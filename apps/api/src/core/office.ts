import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  OfficeSource,
  officeFormat,
  type SourceFile,
  type Subject,
} from "@hyper/contracts";
import {
  OfficeProposalApply,
  OfficeProposalCancel,
  OfficeProposalCreate,
  OfficeProposalEdit,
  type OfficeInspectionResult,
  type OfficeProposalResult,
} from "@hyper/contracts/office";
import type { PoolClient } from "pg";
import type { Database } from "../db/database.js";
import {
  NextcloudFilesProvider,
  UploadPathConflict,
} from "../providers/nextcloud-files.js";
import { sourceConnection } from "./source-connection.js";
import { stableDigest } from "./credentials.js";
import { OfficeProvider, officeDigest } from "./office-provider.js";
import { redactOfficeRuns } from "./office-privacy.js";

export interface OfficeExecution {
  runId?: string;
  guard?: (c: PoolClient) => Promise<void>;
  signal?: AbortSignal;
}
type Connection = Awaited<ReturnType<OfficeService["connection"]>>;
type Row = Record<string, any>;
const definitive = (e: unknown) =>
  e instanceof HttpException &&
  [401, 403, 404, 409, 410, 412].includes(e.getStatus());
const sourceInput = (r: Row): OfficeSource => ({
  path: r.source_path,
  expectedId: r.source_file_id,
  expectedEtag: r.source_etag,
});
export function officeCopyName(name: string, format: string, id: string) {
  let stem = "";
  for (const character of Array.from(name.slice(0, -format.length - 1))) {
    if (Buffer.byteLength(stem + character, "utf8") > 180) break;
    stem += character;
  }
  return (stem || "Office") + "--" + id + "." + format;
}

/** Shared by manual and executor routes. Only current employee credentials can read or publish. */
export class OfficeService {
  constructor(
    readonly db: Database,
    readonly provider = new OfficeProvider(),
  ) {}
  async connection(s: Subject) {
    if (process.env.NEXTCLOUD_FILES_ENABLED !== "true")
      throw new ServiceUnavailableException("企业文件尚未启用。");
    const source = await sourceConnection(this.db, s);
    return {
      ...source,
      files: new NextcloudFilesProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      ),
    };
  }
  private async guard(
    c: PoolClient,
    s: Subject,
    source: Connection,
    execution?: OfficeExecution,
  ) {
    execution?.signal?.throwIfAborted();
    if (
      !(
        await c.query(
          "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [s.workspaceId, s.id],
        )
      ).rowCount
    )
      throw new ForbiddenException("工作区权限已撤销。");
    if (
      !(
        await c.query(
          "SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.user_id=$2 AND i.workspace_id=$3 AND i.provider_key=$4 AND i.remote_uid=$5 AND c.disabled_at IS NULL FOR SHARE OF c,i",
          [
            s.identityCredentialId,
            s.id,
            s.workspaceId,
            source.config.providerKey,
            source.remoteUid,
          ],
        )
      ).rowCount
    )
      throw new ForbiddenException("来源身份已失效。");
    await execution?.guard?.(c);
  }
  private async load(
    s: Subject,
    id: string,
    c: Pick<PoolClient, "query"> = this.db.pool,
    lock = false,
  ): Promise<Row> {
    const row = (
      await c.query(
        "SELECT * FROM cw_office_proposals WHERE id=$1 AND workspace_id=$2 AND actor_id=$3" +
          (lock ? " FOR UPDATE" : ""),
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("Office 提案不存在。");
    return row;
  }
  private async file(source: Connection, input: OfficeSource) {
    const file = await source.files.stat(input.path),
      format = officeFormat(file);
    if (file.id !== input.expectedId || file.etag !== input.expectedEtag)
      throw new ConflictException("Office 来源版本已变化。");
    if (!format || file.size < 1 || file.size > 8388608)
      throw new BadRequestException("请选择受支持的 Office 文件。");
    await source.files.assertReadable(file);
    const binding = stableDigest([
      source.config.providerKey,
      source.remoteUid,
      file.id,
      file.etag,
      file.path,
      file.mime,
      file.size,
    ]);
    return { file, format, binding };
  }
  async checkSource(
    s: Subject,
    raw: OfficeSource,
    expectedSha256?: string,
    expectedBinding?: string,
  ) {
    const input = OfficeSource.parse(raw),
      source = await this.connection(s),
      checked = await this.file(source, input);
    if (expectedBinding && expectedBinding !== checked.binding)
      throw new ConflictException("Office 来源身份已变化。");
    if (
      expectedSha256 &&
      officeDigest(await source.files.download(checked.file)) !== expectedSha256
    )
      throw new ConflictException("Office 来源内容已变化。");
    if (expectedSha256) await this.file(source, input);
    await this.db.tx((c) => this.guard(c, s, source));
    return { binding: checked.binding, format: checked.format };
  }
  async inspect(
    s: Subject,
    raw: OfficeSource,
    signal?: AbortSignal,
  ): Promise<OfficeInspectionResult> {
    const input = OfficeSource.parse(raw),
      source = await this.connection(s),
      checked = await this.file(source, input);
    const bytes = await source.files.download(checked.file),
      result = await this.provider.inspect({
        bytes,
        format: checked.format,
        signal,
      });
    await this.file(source, input);
    await this.db.tx((c) => this.guard(c, s, source, { signal }));
    return {
      source: input,
      binding: checked.binding,
      format: checked.format,
      sourceSha256: result.sourceSha256,
      engine: result.engine,
      inspection: result.inspection,
    };
  }
  private async destination(source: Connection, path: string[]) {
    await source.files.assertWritableDirectory(path);
  }
  private async invalidate(s: Subject, id: string, allActor = false) {
    // Monotonic security cleanup must survive a revoked member, credential or stopped execution.
    await this.db.tx(async (c) => {
      await c.query(
        "UPDATE cw_office_proposals SET invalidated_at=coalesce(invalidated_at,now()),operations=NULL,preview=NULL,source_title='',source_path='{}',destination='{}',target_path='{}',source_file=NULL,retryable=false,updated_at=now(),state=CASE WHEN state IN ('prepared','processing') THEN 'failed' WHEN state='applying' THEN 'recovery_required' ELSE state END,error='source_unavailable' WHERE workspace_id=$2 AND actor_id=$3 AND ($4::boolean OR source_binding=(SELECT source_binding FROM cw_office_proposals WHERE id=$1 AND workspace_id=$2 AND actor_id=$3))",
        [id, s.workspaceId, s.id, allActor],
      );
      await c.query(
        "UPDATE cw_office_requests q SET response=NULL FROM cw_office_proposals p WHERE q.proposal_id=p.id AND p.invalidated_at IS NOT NULL AND q.workspace_id=$1 AND q.actor_id=$2",
        [s.workspaceId, s.id],
      );
      const seed = (
        await c.query(
          "SELECT source_binding FROM cw_office_proposals WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
          [id, s.workspaceId, s.id],
        )
      ).rows[0];
      if (allActor) await redactOfficeRuns(c, s, { allActor: true });
      else if (seed)
        await redactOfficeRuns(c, s, { binding: seed.source_binding });
    });
  }
  private async authorized(s: Subject, id: string, bytes = false) {
    const row = await this.load(s, id);
    try {
      const source = await this.connection(s);
      if (row.invalidated_at) return { row, source, bytes: undefined };
      if (
        source.config.providerKey !== row.provider_key ||
        source.remoteUid !== row.source_uid
      )
        throw new ForbiddenException("来源身份已变化。");
      const checked = await this.file(source, sourceInput(row));
      if (checked.binding !== row.source_binding)
        throw new ConflictException("Office 来源绑定已变化。");
      const content = bytes
        ? await source.files.download(checked.file)
        : undefined;
      if (content && officeDigest(content) !== row.source_sha256)
        throw new ConflictException("Office 来源内容已变化。");
      if (content) await this.file(source, sourceInput(row));
      await this.db.tx((c) => this.guard(c, s, source));
      return { row, source, bytes: content };
    } catch (error) {
      if (definitive(error)) await this.invalidate(s, id);
      if (definitive(error)) {
        let source: Connection;
        try {
          source = await this.connection(s);
        } catch (connectionError) {
          if (definitive(connectionError)) await this.invalidate(s, id, true);
          throw connectionError;
        }
        return { row: await this.load(s, id), source, bytes: undefined };
      }
      throw error;
    }
  }
  private current(row: Row) {
    if (row.invalidated_at)
      throw new ConflictException("来源已失效，请重新选择文件创建提案。");
  }
  private result(
    row: Row,
    file: SourceFile | null = null,
  ): OfficeProposalResult {
    const valid = !row.invalidated_at;
    return {
      id: row.id,
      revision: row.revision,
      state: row.state,
      sourceStatus: valid ? "current" : "invalidated",
      source: valid ? sourceInput(row) : null,
      sourceSha256: row.source_sha256,
      format: row.format,
      title: valid ? row.source_title : null,
      destination: valid ? row.destination : null,
      targetPath: valid ? row.target_path : null,
      operations: valid ? row.operations : null,
      preview: valid ? row.preview : null,
      engine: row.engine,
      error: row.error ?? null,
      retryable: valid && row.retryable,
      cancelRequested: row.cancel_requested,
      outputSha256: row.output_sha256 ?? null,
      file: valid ? file : null,
      sourceRunId: row.source_run_id ?? null,
      applyRunId: row.apply_run_id ?? null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
  private async expire(s: Subject, id: string, source: Connection) {
    await this.db.tx(async (c) => {
      await this.guard(c, s, source);
      await c.query(
        "UPDATE cw_office_proposals SET state=CASE WHEN state='processing' THEN 'failed' ELSE 'recovery_required' END,retryable=(state='processing'),error=CASE WHEN state='processing' THEN 'generation_interrupted' ELSE 'write_unknown' END,updated_at=now() WHERE id=$1 AND state IN ('processing','applying') AND updated_at<now()-interval '120 seconds'",
        [id],
      );
    });
  }
  async get(s: Subject, id: string): Promise<OfficeProposalResult> {
    const { source } = await this.authorized(s, id);
    await this.expire(s, id, source);
    const row = await this.load(s, id);
    let file: SourceFile | null = null;
    if (!row.invalidated_at && row.state === "succeeded" && row.source_file) {
      try {
        const current = await source.files.stat(row.target_path);
        if (
          current.id === row.source_file.id &&
          current.etag === row.source_file.etag &&
          current.size === row.output_size
        ) {
          await source.files.assertReadable(current);
          file = current;
        }
      } catch {
        /* Durable publication fact survives changes to the new copy. */
      }
    }
    const latest = await this.authorized(s, id);
    return this.result(latest.row, file);
  }
  async list(s: Subject): Promise<OfficeProposalResult[]> {
    const rows = (
      await this.db.pool.query(
        "SELECT id FROM cw_office_proposals WHERE workspace_id=$1 AND actor_id=$2 ORDER BY created_at DESC LIMIT 50",
        [s.workspaceId, s.id],
      )
    ).rows;
    try {
      await this.connection(s);
    } catch (error) {
      if (definitive(error) && rows.length)
        await this.invalidate(s, rows[0]!.id, true);
      throw error;
    }
    const results: OfficeProposalResult[] = [];
    for (const row of rows) results.push(await this.get(s, row.id));
    return results;
  }
  private async request(c: PoolClient, s: Subject, key: string, hash: string) {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "office:" + s.workspaceId + ":" + s.id,
    ]);
    const row = (
      await c.query(
        "SELECT * FROM cw_office_requests WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (row && row.request_hash !== hash)
      throw new ConflictException("同一幂等键不能更改 Office 请求。");
    return row;
  }
  private async record(
    c: PoolClient,
    s: Subject,
    key: string,
    hash: string,
    row: Row,
    kind: string,
    response?: OfficeProposalResult,
    runId?: string,
  ) {
    await c.query(
      "INSERT INTO cw_office_requests(workspace_id,actor_id,request_key,request_hash,proposal_id,revision,kind,response,run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        s.workspaceId,
        s.id,
        key,
        hash,
        row.id,
        row.revision,
        kind,
        response ? JSON.stringify(response) : null,
        runId ?? null,
      ],
    );
  }
  private async replay(s: Subject, request: Row) {
    const current = await this.get(s, request.proposal_id);
    if (!request.response || current.sourceStatus === "invalidated")
      return current;
    return {
      ...request.response,
      file: request.response.state === "succeeded" ? current.file : null,
    } as OfficeProposalResult;
  }
  async create(
    s: Subject,
    raw: OfficeProposalCreate,
    execution?: OfficeExecution,
  ): Promise<OfficeProposalResult> {
    const input = OfficeProposalCreate.parse(raw),
      hash = stableDigest({ kind: "create", input });
    const source = await this.connection(s);
    const prior = await this.db.tx(async (c) => {
      await this.guard(c, s, source, execution);
      return this.request(c, s, input.idempotencyKey, hash);
    });
    if (prior) return this.replay(s, prior);
    const checked = await this.file(source, input.source),
      bytes = await source.files.download(checked.file);
    if (officeDigest(bytes) !== input.expectedSha256)
      throw new ConflictException("Office 检查内容已变化。");
    await this.destination(source, input.destination);
    const transformed = await this.provider.transform({
      bytes,
      format: checked.format,
      operations: input.operations,
      signal: execution?.signal,
    });
    await this.checkSource(
      s,
      input.source,
      input.expectedSha256,
      checked.binding,
    );
    await this.destination(source, input.destination);
    const id = await this.db.tx(async (c) => {
      await this.guard(c, s, source, execution);
      const existing = await this.request(c, s, input.idempotencyKey, hash);
      if (existing) return existing.proposal_id as string;
      const id = randomUUID(),
        name = officeCopyName(checked.file.name, checked.format, id);
      const row = (
        await c.query(
          "INSERT INTO cw_office_proposals(id,workspace_id,actor_id,provider_key,source_uid,source_file_id,source_etag,source_path,source_sha256,source_size,source_mime,source_title,source_binding,format,destination,target_path,engine,operations,preview,source_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *",
          [
            id,
            s.workspaceId,
            s.id,
            source.config.providerKey,
            source.remoteUid,
            checked.file.id,
            checked.file.etag,
            checked.file.path,
            input.expectedSha256,
            checked.file.size,
            checked.file.mime,
            checked.file.name,
            checked.binding,
            checked.format,
            input.destination,
            [...input.destination, name],
            transformed.engine,
            JSON.stringify(input.operations),
            JSON.stringify(transformed.preview),
            execution?.runId ?? null,
          ],
        )
      ).rows[0];
      await this.record(
        c,
        s,
        input.idempotencyKey,
        hash,
        row,
        "create",
        this.result(row),
        execution?.runId,
      );
      return id;
    });
    return this.get(s, id);
  }
  async edit(
    s: Subject,
    id: string,
    raw: OfficeProposalEdit,
    execution?: OfficeExecution,
  ): Promise<OfficeProposalResult> {
    const input = OfficeProposalEdit.parse(raw),
      hash = stableDigest({ kind: "edit", id, input }),
      authorized = await this.authorized(s, id, true);
    this.current(authorized.row);
    const prior = await this.db.tx(async (c) => {
      await this.guard(c, s, authorized.source, execution);
      return this.request(c, s, input.idempotencyKey, hash);
    });
    if (prior) return this.replay(s, prior);
    if (
      authorized.row.revision !== input.expectedRevision ||
      !["prepared", "failed"].includes(authorized.row.state) ||
      (authorized.row.state === "failed" && !authorized.row.retryable)
    )
      throw new ConflictException("Office 提案版本或状态已变化。");
    const transformed = await this.provider.transform({
      bytes: authorized.bytes!,
      format: authorized.row.format,
      operations: input.operations,
      signal: execution?.signal,
    });
    const fresh = await this.authorized(s, id, true);
    this.current(fresh.row);
    const req = await this.db.tx(async (c) => {
      await this.guard(c, s, fresh.source, execution);
      const existing = await this.request(c, s, input.idempotencyKey, hash);
      if (existing) return existing;
      const row = await this.load(s, id, c, true);
      this.current(row);
      if (
        row.revision !== input.expectedRevision ||
        !(row.state === "prepared" || (row.state === "failed" && row.retryable))
      )
        throw new ConflictException("Office 提案版本或状态已变化。");
      const next = (
        await c.query(
          "UPDATE cw_office_proposals SET revision=revision+1,state='prepared',operations=$2,preview=$3,engine=$4,error=NULL,retryable=false,updated_at=now() WHERE id=$1 RETURNING *",
          [
            id,
            JSON.stringify(input.operations),
            JSON.stringify(transformed.preview),
            transformed.engine,
          ],
        )
      ).rows[0];
      await this.record(
        c,
        s,
        input.idempotencyKey,
        hash,
        next,
        "edit",
        this.result(next),
      );
      return null;
    });
    return req ? this.replay(s, req) : this.get(s, id);
  }
  private async observe(s: Subject, id: string, execution?: OfficeExecution) {
    const { source, row } = await this.authorized(s, id);
    this.current(row);
    if (!["applying", "recovery_required"].includes(row.state)) return;
    let file: SourceFile;
    try {
      file = await source.files.stat(row.target_path);
      if (file.kind !== "file" || file.size !== row.output_size) return;
      if (officeDigest(await source.files.download(file)) !== row.output_sha256)
        return;
      const latest = await source.files.stat(row.target_path);
      if (
        latest.id !== file.id ||
        latest.etag !== file.etag ||
        latest.size !== file.size
      )
        return;
    } catch {
      return; /* Missing/denied/unstable target cannot establish the PUT outcome. */
    }
    const fresh = await this.authorized(s, id);
    this.current(fresh.row);
    await this.db.tx(async (c) => {
      await this.guard(c, s, source, execution);
      const locked = await this.load(s, id, c, true);
      this.current(locked);
      if (
        locked.output_sha256 !== row.output_sha256 ||
        locked.attempt_token !== row.attempt_token
      )
        return;
      await c.query(
        "UPDATE cw_office_proposals SET state='succeeded',source_file=$2,retryable=false,error=NULL,updated_at=now() WHERE id=$1 AND state IN ('applying','recovery_required')",
        [id, JSON.stringify(file)],
      );
    });
  }
  private async finishRequest(
    s: Subject,
    id: string,
    key: string,
    source: Connection,
    execution?: OfficeExecution,
  ) {
    const result = await this.get(s, id);
    await this.db.tx(async (c) => {
      await this.guard(c, s, source, execution);
      await c.query(
        "UPDATE cw_office_requests SET response=$4 WHERE proposal_id=$1 AND workspace_id=$2 AND actor_id=$3 AND request_key=$5",
        [
          id,
          s.workspaceId,
          s.id,
          result.sourceStatus === "current" ? JSON.stringify(result) : null,
          key,
        ],
      );
    });
    return result;
  }
  async apply(
    s: Subject,
    id: string,
    raw: OfficeProposalApply,
    execution?: OfficeExecution,
  ): Promise<OfficeProposalResult> {
    const input = OfficeProposalApply.parse(raw),
      hash = stableDigest({ kind: "apply", id, input }),
      auth = await this.authorized(s, id, true);
    this.current(auth.row);
    const token = randomUUID();
    const prior = await this.db.tx(async (c) => {
      await this.guard(c, s, auth.source, execution);
      const existing = await this.request(c, s, input.idempotencyKey, hash);
      if (existing) return existing;
      const row = await this.load(s, id, c, true);
      this.current(row);
      if (
        row.revision !== input.expectedRevision ||
        !(
          row.state === "prepared" ||
          (row.state === "failed" && row.retryable)
        ) ||
        row.cancel_requested
      )
        throw new ConflictException(
          "Office 提案版本或状态已变化，请先核对回执。",
        );
      await c.query(
        "UPDATE cw_office_proposals SET state='processing',attempt_token=$2,apply_run_id=$3,retryable=false,error=NULL,updated_at=now() WHERE id=$1",
        [id, token, execution?.runId ?? null],
      );
      await this.record(
        c,
        s,
        input.idempotencyKey,
        hash,
        row,
        "apply",
        undefined,
        execution?.runId,
      );
      return null;
    });
    if (prior) return this.replay(s, prior);
    let dispatch = false;
    try {
      const output = await this.provider.transform({
        bytes: auth.bytes!,
        format: auth.row.format,
        operations: auth.row.operations,
        signal: execution?.signal,
      });
      const fresh = await this.authorized(s, id, true);
      this.current(fresh.row);
      await this.destination(fresh.source, fresh.row.destination);
      await this.db.tx(async (c) => {
        await this.guard(c, s, fresh.source, execution);
        const row = await this.load(s, id, c, true);
        this.current(row);
        if (
          row.state !== "processing" ||
          row.attempt_token !== token ||
          row.revision !== input.expectedRevision ||
          row.cancel_requested
        )
          throw new ConflictException("Office 提案执行已停止或版本变化。");
        await c.query(
          "UPDATE cw_office_proposals SET state='applying',output_sha256=$2,output_size=$3,preview=$4,updated_at=now() WHERE id=$1",
          [
            id,
            output.outputSha256,
            output.bytes.length,
            JSON.stringify(output.preview),
          ],
        );
      });
      // Last source, destination and transaction guard occur immediately before the one conditional PUT.
      const final = await this.authorized(s, id, true);
      this.current(final.row);
      await this.destination(final.source, final.row.destination);
      await this.db.tx(async (c) => {
        await this.guard(c, s, final.source, execution);
        const row = await this.load(s, id, c, true);
        if (
          row.state !== "applying" ||
          row.attempt_token !== token ||
          row.revision !== input.expectedRevision ||
          row.cancel_requested
        )
          throw new ConflictException("Office 执行已停止。");
      });
      dispatch = true;
      await final.source.files.uploadNew(final.row.target_path, output.bytes);
      await this.observe(s, id, execution);
    } catch (error) {
      // Bookkeeping is monotonic and contains no content: stopped/revoked executions must retain uncertain effects.
      const collision = error instanceof UploadPathConflict;
      await this.db.pool.query(
        "UPDATE cw_office_proposals SET state=$3,retryable=$4,error=$5,updated_at=now() WHERE id=$1 AND attempt_token=$2 AND state IN ('processing','applying')",
        [
          id,
          token,
          dispatch && !collision ? "recovery_required" : "failed",
          !dispatch && !definitive(error),
          collision
            ? "target_conflict"
            : dispatch
              ? "write_unknown"
              : "generation_failed",
        ],
      );
      if (dispatch && !collision)
        await this.observe(s, id, execution).catch(() => {});
      if (!dispatch && (execution?.signal?.aborted || definitive(error)))
        throw error;
    }
    await this.db.pool.query(
      "UPDATE cw_office_proposals SET state='recovery_required',error='write_unknown',updated_at=now() WHERE id=$1 AND attempt_token=$2 AND state='applying'",
      [id, token],
    );
    return this.finishRequest(
      s,
      id,
      input.idempotencyKey,
      auth.source,
      execution,
    );
  }
  async reconcile(s: Subject, id: string, execution?: OfficeExecution) {
    const current = await this.get(s, id);
    if (
      current.sourceStatus === "current" &&
      current.state === "recovery_required"
    )
      await this.observe(s, id, execution).catch((error) => {
        if (definitive(error) || execution?.signal?.aborted) throw error;
      });
    return this.get(s, id);
  }
  async cancel(
    s: Subject,
    id: string,
    raw: OfficeProposalCancel,
    execution?: OfficeExecution,
  ) {
    const input = OfficeProposalCancel.parse(raw),
      hash = stableDigest({ kind: "cancel", id, input }),
      auth = await this.authorized(s, id);
    const prior = await this.db.tx(async (c) => {
      await this.guard(c, s, auth.source, execution);
      const existing = await this.request(c, s, input.idempotencyKey, hash);
      if (existing) return existing;
      const row = await this.load(s, id, c, true);
      if (row.revision !== input.expectedRevision)
        throw new ConflictException("Office 提案版本已变化。");
      const next = (
        await c.query(
          "UPDATE cw_office_proposals SET cancel_requested=true,state=CASE WHEN state IN ('prepared','processing') OR (state='failed' AND retryable) THEN 'cancelled' ELSE state END,retryable=false,updated_at=now() WHERE id=$1 RETURNING *",
          [id],
        )
      ).rows[0];
      await this.record(
        c,
        s,
        input.idempotencyKey,
        hash,
        next,
        "cancel",
        this.result(next),
      );
      return null;
    });
    return prior ? this.replay(s, prior) : this.get(s, id);
  }
}
