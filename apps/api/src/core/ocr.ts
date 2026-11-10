import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { SourceFile, Subject } from "@hyper/contracts";
import {
  OcrPage,
  supportsOcr,
  type OcrCorrection,
  type OcrRecognition,
  type OcrResult,
  type OcrSource,
} from "@hyper/contracts/ocr";
import type { Database } from "../db/database.js";
import {
  FileSourceRejected,
  NextcloudFilesProvider,
} from "../providers/nextcloud-files.js";
import { stableDigest } from "./credentials.js";
import { sourceConnection } from "./source-connection.js";
import { OcrProvider } from "./ocr-provider.js";

type Source = {
  provider: NextcloudFilesProvider;
  key: string;
  uid: string;
};
type OcrDocument = {
  id: string;
  asset_id: string | null;
  provider_key: string;
  source_uid: string;
  source_file_id: string;
  source_etag: string;
  source_path: string[];
  source_size: number;
  source_mime: string;
  source_title: string;
  page: number;
  revision: number;
  confirmed_revision: number | null;
};
type Revision = {
  revision: number;
  request_hash: string;
  state: "draft" | "confirmed";
  engine: string;
  content: OcrPage;
  recorded_at: Date;
};

type Queryable = Pick<PoolClient, "query">;
function sourceOf(document: OcrDocument): OcrSource {
  return {
    path: document.source_path,
    expectedId: document.source_file_id,
    expectedEtag: document.source_etag,
    page: document.page,
  };
}

function matches(file: SourceFile, document: OcrDocument) {
  return (
    file.etag === document.source_etag &&
    file.size === document.source_size &&
    file.mime === document.source_mime &&
    JSON.stringify(file.path) === JSON.stringify(document.source_path)
  );
}

export class OcrService {
  constructor(private readonly db: Database) {}

  private async connection(s: Subject): Promise<Source> {
    if (process.env.NEXTCLOUD_FILES_ENABLED !== "true")
      throw new ServiceUnavailableException("企业文件尚未启用。");
    const { config, credentials, remoteUid } = await sourceConnection(
      this.db,
      s,
    );
    return {
      provider: new NextcloudFilesProvider(config, credentials, remoteUid),
      key: config.providerKey,
      uid: remoteUid,
    };
  }

  private async sourceFile(source: Source, selection: OcrSource) {
    const file = await source.provider.stat(selection.path);
    if (
      file.id !== selection.expectedId ||
      file.etag !== selection.expectedEtag
    )
      throw new ConflictException("来源文件或版本已变化，请重新选择。");
    if (
      !supportsOcr(file) ||
      (file.mime !== "application/pdf" && selection.page !== 1)
    )
      throw new BadRequestException(
        "请选择 8 MiB 内的 PNG、JPEG 或 PDF。图片只有第 1 页。",
      );
    await source.provider.assertReadable(file);
    return file;
  }

  private async active(
    c: Queryable,
    s: Subject,
    source: Source,
    selection: OcrSource,
  ) {
    return (
      await c.query<OcrDocument>(
        `SELECT * FROM cw_ocr_documents
       WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND source_uid=$4
         AND source_file_id=$5 AND page=$6 AND invalidated_at IS NULL`,
        [
          s.workspaceId,
          s.id,
          source.key,
          source.uid,
          selection.expectedId,
          selection.page,
        ],
      )
    ).rows[0];
  }

  private async byId(s: Subject, id: string) {
    const document = (
      await this.db.pool.query<OcrDocument>(
        `SELECT * FROM cw_ocr_documents
       WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND invalidated_at IS NULL`,
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!document) throw new NotFoundException("识别记录不存在或来源已失效。");
    return document;
  }

  private async invalidate(c: Queryable, document: OcrDocument) {
    await c.query(
      `WITH stale AS (
         UPDATE cw_ocr_documents d SET invalidated_at=clock_timestamp()
         FROM cw_ocr_documents seed WHERE seed.id=$1
           AND d.workspace_id=seed.workspace_id AND d.actor_id=seed.actor_id
           AND d.provider_key=seed.provider_key AND d.source_uid=seed.source_uid
           AND d.source_file_id=seed.source_file_id AND d.source_etag=seed.source_etag
           AND d.invalidated_at IS NULL RETURNING d.id
       )
       UPDATE cw_ocr_revisions v SET content=NULL FROM stale WHERE v.document_id=stale.id`,
      [document.id],
    );
  }

  private async checkDocument(
    s: Subject,
    document: OcrDocument,
    existing?: Source,
  ) {
    const source = existing ?? (await this.connection(s));
    if (
      source.key !== document.provider_key ||
      source.uid !== document.source_uid
    )
      throw new NotFoundException("识别记录所属来源已变化。");
    try {
      const file = await this.sourceFile(source, sourceOf(document));
      if (!matches(file, document))
        throw new ConflictException("来源文件已变化。");
      return { source, file };
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException ||
        (error instanceof FileSourceRejected &&
          [403, 404, 410, 412].includes(error.getStatus()))
      ) {
        await this.db.tx((c) => this.invalidate(c, document));
        throw new NotFoundException("来源权限或版本已变化，旧识别内容已清理。");
      }
      throw error;
    }
  }

  private async ensureSession(c: Queryable, s: Subject, source: Source) {
    const live = await c.query(
      `SELECT c.id FROM cw_members m
       JOIN cw_external_identities i ON i.user_id=m.user_id AND i.workspace_id=m.workspace_id
       JOIN cw_identity_credentials c ON c.identity_id=i.id
       WHERE m.workspace_id=$1 AND m.user_id=$2 AND c.id=$3 AND c.disabled_at IS NULL
         AND i.provider_key=$4 AND i.remote_uid=$5 FOR SHARE OF m,i,c`,
      [s.workspaceId, s.id, s.identityCredentialId, source.key, source.uid],
    );
    if (!live.rowCount) throw new ForbiddenException("文件来源权限已失效。");
  }

  private async lock(
    c: Queryable,
    s: Subject,
    source: Source,
    selection: OcrSource,
  ) {
    await this.ensureSession(c, s, source);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "ocr:" +
        stableDigest([
          s.workspaceId,
          s.id,
          source.key,
          source.uid,
          selection.expectedId,
          selection.page,
        ]),
    ]);
  }

  private result(document: OcrDocument, row: Revision): OcrResult {
    return {
      id: document.id,
      source: sourceOf(document),
      title: document.source_title,
      revision: row.revision,
      confirmedRevision: document.confirmed_revision,
      state: row.state,
      engine: row.engine,
      recordedAt: row.recorded_at.toISOString(),
      content: row.content,
    };
  }

  private async load(c: Queryable, document: OcrDocument, requested: number) {
    const row = (
      await c.query<Revision>(
        `SELECT v.* FROM cw_ocr_revisions v JOIN cw_ocr_documents d ON d.id=v.document_id
       WHERE v.document_id=$1 AND v.revision=$2 AND d.invalidated_at IS NULL AND v.content IS NOT NULL`,
        [document.id, requested],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("识别版本不存在或来源已失效。");
    return this.result(document, row);
  }

  private async replay(
    c: Queryable,
    document: OcrDocument | undefined,
    key: string,
    hash: string,
  ) {
    if (!document) return;
    const row = (
      await c.query<Revision>(
        `SELECT v.* FROM cw_ocr_revisions v JOIN cw_ocr_documents d ON d.id=v.document_id
       WHERE v.document_id=$1 AND v.request_key=$2 AND d.invalidated_at IS NULL AND v.content IS NOT NULL`,
        [document.id, key],
      )
    ).rows[0];
    if (!row) return;
    if (row.request_hash !== hash)
      throw new ConflictException("同一操作键不能更换识别参数。");
    return this.result(document, row);
  }

  private async append(
    c: Queryable,
    document: OcrDocument,
    input: {
      key: string;
      hash: string;
      state: Revision["state"];
      engine: string;
      content: OcrPage;
    },
  ) {
    const revision = document.revision + 1;
    const head = await c.query<OcrDocument>(
      `UPDATE cw_ocr_documents SET revision=$2,
         confirmed_revision=CASE WHEN $3='confirmed' THEN $2 ELSE confirmed_revision END
       WHERE id=$1 AND invalidated_at IS NULL RETURNING *`,
      [document.id, revision, input.state],
    );
    if (!head.rowCount) throw new ConflictException("来源已变化，请重新选择。");
    const row = (
      await c.query<Revision>(
        `INSERT INTO cw_ocr_revisions(document_id,revision,request_key,request_hash,state,engine,content)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          document.id,
          revision,
          input.key,
          input.hash,
          input.state,
          input.engine,
          input.content,
        ],
      )
    ).rows[0]!;
    return this.result(head.rows[0]!, row);
  }

  /** The confirmed version stays indexed while an employee works on a later draft. */
  private async publishConfirmedAsset(
    c: Queryable,
    s: Subject,
    document: OcrDocument,
    result: OcrResult,
  ) {
    const id = document.asset_id ?? randomUUID();
    const title = result.title + " · 第 " + result.source.page + " 页（OCR）";
    const sourceRef = "ocr:" + document.id + "#page=" + document.page;
    const content = result.content.blocks
      .map((block, index) =>
        block.text.trim()
          ? "[第 " +
            document.page +
            " 页 · 块 " +
            (index + 1) +
            "]\n" +
            block.text
          : "",
      )
      .filter(Boolean)
      .join("\n\n");
    const version = "ocr:" + result.revision;
    if (document.asset_id) {
      const updated = await c.query(
        `UPDATE cw_assets SET title=$2,content=$3,source_version=$4,updated_at=clock_timestamp()
         WHERE id=$1 AND workspace_id=$5 AND owner_id=$6 AND type='ocr' AND visibility='private'
           AND validity='active' AND project_id IS NULL AND deleted_at IS NULL`,
        [id, title, content, version, s.workspaceId, s.id],
      );
      if (!updated.rowCount) throw new ConflictException("原 OCR 资料已变化。");
      return;
    }
    await c.query(
      `INSERT INTO cw_assets(id,workspace_id,owner_id,visibility,title,content,type,source_ref,source_version)
       VALUES($1,$2,$3,'private',$4,$5,'ocr',$6,$7)`,
      [id, s.workspaceId, s.id, title, content, sourceRef, version],
    );
    await c.query("UPDATE cw_ocr_documents SET asset_id=$2 WHERE id=$1", [
      document.id,
      id,
    ]);
  }

  async verifyAssets(s: Subject, ids?: string[]) {
    const allowed = new Map<string, string>();
    if (
      s.demo ||
      !s.identityCredentialId ||
      ids?.length === 0 ||
      process.env.NEXTCLOUD_FILES_ENABLED !== "true"
    )
      return allowed;
    const documents = (
      await this.db.pool.query<OcrDocument>(
        `SELECT d.* FROM cw_ocr_documents d JOIN cw_assets a ON a.id=d.asset_id
       WHERE d.workspace_id=$1 AND d.actor_id=$2 AND d.invalidated_at IS NULL
         AND d.confirmed_revision IS NOT NULL AND a.type='ocr' AND a.visibility='private'
         AND a.workspace_id=$1 AND a.owner_id=$2 AND a.project_id IS NULL AND a.deleted_at IS NULL
         AND a.validity='active' AND ($3::uuid[] IS NULL OR d.asset_id=ANY($3::uuid[]))`,
        [s.workspaceId, s.id, ids ?? null],
      )
    ).rows;
    if (!documents.length) return allowed;
    let source: Source;
    try {
      source = await this.connection(s);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) return allowed;
      throw error;
    }
    const groups = new Map<string, OcrDocument[]>();
    for (const document of documents) {
      const binding = stableDigest([
        document.provider_key,
        document.source_uid,
        document.source_file_id,
        document.source_etag,
        document.source_path,
        document.source_size,
        document.source_mime,
      ]);
      const group = groups.get(binding);
      if (group) group.push(document);
      else groups.set(binding, [document]);
    }
    const batches = [...groups.values()];
    for (let offset = 0; offset < batches.length; offset += 4) {
      await Promise.all(
        batches.slice(offset, offset + 4).map(async (group) => {
          try {
            await this.checkDocument(s, group[0]!, source);
            for (const document of group)
              allowed.set(
                document.asset_id!,
                "ocr:" + document.confirmed_revision,
              );
          } catch (error) {
            if (
              !(
                error instanceof NotFoundException ||
                error instanceof ServiceUnavailableException ||
                (error instanceof FileSourceRejected &&
                  error.getStatus() === 429)
              )
            )
              throw error;
          }
        }),
      );
    }
    return allowed;
  }

  async lookup(s: Subject, selection: OcrSource) {
    const source = await this.connection(s);
    const known = await this.active(this.db.pool, s, source, selection);
    const file =
      known?.source_etag === selection.expectedEtag &&
      JSON.stringify(known.source_path) === JSON.stringify(selection.path)
        ? (await this.checkDocument(s, known, source)).file
        : await this.sourceFile(source, selection);
    return this.db.tx(async (c) => {
      await this.lock(c, s, source, selection);
      const document = await this.active(c, s, source, selection);
      if (!document) return null;
      if (!matches(file, document)) {
        await this.invalidate(c, document);
        return null;
      }
      return this.load(c, document, document.revision);
    });
  }

  async detail(s: Subject, id: string, revision?: number) {
    const document = await this.byId(s, id);
    await this.checkDocument(s, document);
    return this.load(this.db.pool, document, revision ?? document.revision);
  }

  async recognize(s: Subject, input: OcrRecognition) {
    const selection = input.source;
    const source = await this.connection(s);
    const file = await this.sourceFile(source, selection);
    const hash = stableDigest(input);
    const plan = async (c: Queryable, firstRead: boolean) => {
      await this.lock(c, s, source, selection);
      let document = await this.active(c, s, source, selection);
      if (document && !matches(file, document)) {
        if (!firstRead) throw new ConflictException("识别期间来源版本已更新。");
        await this.invalidate(c, document);
        document = undefined;
      }
      const replay = await this.replay(c, document, input.idempotencyKey, hash);
      return { document, replay };
    };
    const previous = await this.db.tx((c) => plan(c, true));
    if (previous.replay) return previous.replay;
    if ((previous.document?.revision ?? 0) !== input.expectedRevision)
      throw new ConflictException("识别版本已更新，请刷新后重试。");
    const verifyCurrent = async () => {
      if (previous.document) {
        await this.checkDocument(s, previous.document);
        return;
      }
      const fresh = await this.connection(s);
      const current = await this.sourceFile(fresh, selection);
      if (
        fresh.key !== source.key ||
        fresh.uid !== source.uid ||
        current.mime !== file.mime ||
        current.size !== file.size
      )
        throw new ConflictException("识别期间来源已变化，结果未保存。");
    };
    const bytes = await source.provider.download(file);
    await verifyCurrent();
    const observed = await new OcrProvider().recognize({
      bytes,
      mime: file.mime,
      page: selection.page,
    });
    await verifyCurrent();
    return this.db.tx(async (c) => {
      const { document: existing, replay } = await plan(c, false);
      if (replay) return replay;
      if ((existing?.revision ?? 0) !== input.expectedRevision)
        throw new ConflictException("识别版本已更新，请刷新后重试。");
      const document =
        existing ??
        (
          await c.query<OcrDocument>(
            `INSERT INTO cw_ocr_documents
         (id,workspace_id,actor_id,provider_key,source_uid,source_file_id,source_etag,
          source_path,source_size,source_mime,source_title,page)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [
              randomUUID(),
              s.workspaceId,
              s.id,
              source.key,
              source.uid,
              file.id,
              file.etag,
              file.path,
              file.size,
              file.mime,
              file.name,
              selection.page,
            ],
          )
        ).rows[0]!;
      return this.append(c, document, {
        ...observed,
        key: input.idempotencyKey,
        hash,
        state: "draft",
      });
    });
  }

  async confirm(s: Subject, id: string, input: OcrCorrection) {
    const original = await this.byId(s, id);
    const { source } = await this.checkDocument(s, original);
    const hash = stableDigest(input);
    return this.db.tx(async (c) => {
      await this.lock(c, s, source, sourceOf(original));
      const document = await this.active(c, s, source, sourceOf(original));
      if (!document || document.id !== id)
        throw new ConflictException("来源已变化，请重新选择。");
      const replay = await this.replay(c, document, input.idempotencyKey, hash);
      if (replay) return replay;
      if (document.revision !== input.expectedRevision)
        throw new ConflictException("识别版本已更新，请刷新后重试。");
      const current = await this.load(c, document, document.revision);
      if (
        current.content.blocks.length !== input.texts.length ||
        !input.texts.some((text) => text.trim())
      )
        throw new BadRequestException("请按原有版面块校对，至少保留一段文字。");
      const content = OcrPage.parse({
        ...current.content,
        blocks: current.content.blocks.map((block, index) => ({
          ...block,
          text: input.texts[index],
        })),
      });
      const confirmed = await this.append(c, document, {
        content,
        engine: current.engine,
        key: input.idempotencyKey,
        hash,
        state: "confirmed",
      });
      await this.publishConfirmedAsset(c, s, document, confirmed);
      return confirmed;
    });
  }
}
