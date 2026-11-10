import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  FilePath,
  officeFormat,
  type OfficeLink,
  type OfficeSource,
  type OfficeVersion,
  type Subject,
  type SourceFile,
} from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { sourceConnection } from "./source-connection.js";
import { digest } from "./credentials.js";
import { invalidateFileDependents } from "./file-lifecycle.js";
import {
  FileSourceRejected,
  NextcloudFilesProvider,
  fileParserVersion,
} from "../providers/nextcloud-files.js";

const CLEAR_INDEX =
  "embedding=NULL,embedding_profile_id=NULL,embedding_dimensions=NULL,embedding_source_version=NULL,embedding_model=NULL,embedding_version=NULL,indexed_at=NULL";
export interface FileValidation {
  allowed: Map<string, string>;
  metadata: Map<string, SourceFile>;
}
/** Source checks never expand the actor's product permissions or publish a shared copy. */
export class SourceFileService {
  constructor(private db: Database) {}
  private async connection(s: Subject) {
    if (process.env.NEXTCLOUD_FILES_ENABLED !== "true")
      throw new ServiceUnavailableException("企业文件尚未启用。");
    const source = await sourceConnection(this.db, s);
    return {
      ...source,
      provider: new NextcloudFilesProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      ),
    };
  }
  async list(s: Subject, path: string[]) {
    return (await this.connection(s)).provider.list(FilePath.parse(path));
  }
  private async officeSource(s: Subject, selection: OfficeSource) {
    if (process.env.NEXTCLOUD_OFFICE_ENABLED !== "true")
      throw new ServiceUnavailableException("企业 Office 协作尚未启用。");
    const source = await this.connection(s);
    const file = await source.provider.stat(selection.path);
    if (file.id !== selection.expectedId)
      throw new ConflictException("所选文件已变化，请刷新文件夹后重试。");
    const format = officeFormat(file);
    if (!format)
      throw new BadRequestException("Office 协作支持 DOCX、XLSX 和 PPTX。");
    await source.provider.assertReadable(file);
    return { file, format, publicUrl: source.config.publicUrl };
  }
  async officeLink(s: Subject, selection: OfficeSource): Promise<OfficeLink> {
    const { file, format, publicUrl } = await this.officeSource(s, selection);
    if (file.etag !== selection.expectedEtag)
      throw new ConflictException("所选文件已变化，请刷新文件夹后重试。");
    return {
      url: publicUrl + "/index.php/f/" + file.id,
      format,
      checkedEtag: file.etag,
    };
  }
  async officeVersion(
    s: Subject,
    selection: OfficeSource,
  ): Promise<OfficeVersion> {
    const { file } = await this.officeSource(s, selection);
    return {
      checkedEtag: file.etag,
      changed: file.etag !== selection.expectedEtag,
    };
  }
  private rows(s: Subject, ids?: string[]) {
    return this.db.pool.query(
      `SELECT f.*,a.title,a.validity,a.source_version FROM cw_source_files f JOIN cw_assets a ON a.id=f.asset_id
       WHERE f.workspace_id=$1 AND f.actor_id=$2 AND a.owner_id=$2 AND a.workspace_id=$1 AND a.deleted_at IS NULL
       AND ($3::uuid[] IS NULL OR f.asset_id=ANY($3::uuid[])) ORDER BY f.asset_id`,
      [s.workspaceId, s.id, ids ?? null],
    );
  }
  private async invalidate(row: any, validity: string) {
    await this.db.tx(async (c) => {
      const changed = await c.query(
        `UPDATE cw_assets SET content='',validity=$2,${CLEAR_INDEX},updated_at=clock_timestamp() WHERE id=$1 AND source_version=$3 RETURNING id`,
        [row.asset_id, validity, row.source_version],
      );
      if (changed.rowCount)
        await c.query(
          "UPDATE cw_source_files SET extraction_metadata='{}'::jsonb WHERE asset_id=$1",
          [row.asset_id],
        );
      if (changed.rowCount)
        await invalidateFileDependents(c, row.asset_id, row.source_version);
    });
  }
  /** Fresh metadata plus an actual content-read probe; no positive permission cache. */
  async verify(s: Subject, ids?: string[]): Promise<FileValidation> {
    const rows = (await this.rows(s, ids)).rows;
    const result: FileValidation = { allowed: new Map(), metadata: new Map() };
    if (
      !rows.length ||
      s.demo ||
      !s.identityCredentialId ||
      process.env.NEXTCLOUD_FILES_ENABLED !== "true"
    )
      return result;
    let source;
    try {
      source = await this.connection(s);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) return result;
      throw error;
    }
    let unavailable = false;
    for (let offset = 0; offset < rows.length; offset += 4) {
      if (unavailable) break;
      await Promise.all(
        rows.slice(offset, offset + 4).map(async (row) => {
          if (row.provider_key !== source.config.providerKey) return;
          try {
            const file = await source.provider.stat(FilePath.parse(row.path));
            if (file.id !== row.remote_file_id) {
              await this.invalidate(row, "source_unavailable");
              return;
            }
            if (
              file.etag !== row.source_etag ||
              !file.importable ||
              file.size !== Number(row.size_bytes) ||
              file.mime !== row.content_mime ||
              row.parser_version !== fileParserVersion(file)
            ) {
              await this.invalidate(row, "stale");
              // Names are shown only after the current employee can actually read the file.
              await source.provider.assertReadable(file);
              result.metadata.set(row.asset_id, file);
              return;
            }
            await source.provider.assertReadable(file);
            result.metadata.set(row.asset_id, file);
            if (row.validity === "active")
              result.allowed.set(row.asset_id, row.source_version);
            await this.db.pool.query(
              "UPDATE cw_source_files SET checked_at=clock_timestamp() WHERE asset_id=$1",
              [row.asset_id],
            );
          } catch (error) {
            if (error instanceof FileSourceRejected) {
              if (error.getStatus() === 401) throw error;
              if ([403, 404, 410, 412].includes(error.getStatus()))
                await this.invalidate(
                  row,
                  error.getStatus() === 412 ? "stale" : "source_unavailable",
                );
              else unavailable = true;
            } else if (error instanceof ServiceUnavailableException)
              unavailable = true;
            else throw error;
          }
        }),
      );
    }
    return result;
  }
  async imported(s: Subject) {
    await assertMember(this.db, s);
    const checked = await this.verify(s);
    return (await this.rows(s)).rows.map((row) => ({
      id: row.asset_id,
      title: checked.metadata.get(row.asset_id)?.name ?? "来源暂不可用的文件",
      state: checked.allowed.has(row.asset_id)
        ? "ready"
        : checked.metadata.has(row.asset_id)
          ? "needs_refresh"
          : "unavailable",
      sourceVersion: checked.allowed.get(row.asset_id),
    }));
  }
  async assertVersion(s: Subject, id: string, version: string) {
    await assertMember(this.db, s);
    const checked = await this.verify(s, [id]);
    if (checked.allowed.get(id) !== version)
      throw new NotFoundException("文件来源或版本已失效。");
    const current = await this.db.pool.query(
      "SELECT id FROM cw_assets WHERE id=$1 AND workspace_id=$2 AND owner_id=$3 AND source_version=$4 AND validity='active' AND deleted_at IS NULL",
      [id, s.workspaceId, s.id, version],
    );
    if (!current.rowCount)
      throw new NotFoundException("文件来源或版本已失效。");
  }
  async get(s: Subject, id: string) {
    await assertMember(this.db, s);
    const checked = await this.verify(s, [id]),
      version = checked.allowed.get(id);
    if (!version)
      throw new NotFoundException("文件不可读取、已变化或需要重新导入。");
    const row = (
      await this.db.pool.query(
        `SELECT a.id,a.title,a.content,a.source_ref AS "sourceRef",a.source_version AS "sourceVersion",f.parser_version AS "parserVersion",f.extraction_metadata AS extraction
        FROM cw_assets a JOIN cw_source_files f ON f.asset_id=a.id AND f.workspace_id=a.workspace_id AND f.actor_id=a.owner_id
        WHERE a.id=$1 AND a.workspace_id=$2 AND a.owner_id=$3 AND a.source_version=$4 AND a.validity='active' AND a.deleted_at IS NULL`,
        [id, s.workspaceId, s.id, version],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("文件已变化，请刷新。");
    return row;
  }
  async refresh(s: Subject, id: string) {
    const row = (await this.rows(s, [id])).rows[0];
    if (!row) throw new NotFoundException("导入记录不存在。");
    const source = await this.connection(s);
    if (source.config.providerKey !== row.provider_key)
      throw new NotFoundException("文件来源已变化。");
    const current = await source.provider.stat(FilePath.parse(row.path));
    if (current.id !== row.remote_file_id) {
      await this.invalidate(row, "source_unavailable");
      throw new ConflictException(
        "原文件已移动、删除或被替换，请重新选择文件。",
      );
    }
    return this.import(s, current.path, current.id, current.etag);
  }
  async import(
    s: Subject,
    path: string[],
    expectedId: string,
    expectedEtag: string,
  ) {
    const source = await this.connection(s);
    const initial = await source.provider.stat(FilePath.parse(path));
    if (initial.id !== expectedId || initial.etag !== expectedEtag)
      throw new ConflictException("所选文件或版本已变化，请刷新文件夹。");
    const extracted = await source.provider.extract(initial),
      content = extracted.text;
    const metadata = {
      format: extracted.format,
      sections: extracted.sections,
      warnings: extracted.warnings,
    };
    // Recheck product/device/source membership and the exact version after downloading.
    const fresh = await this.connection(s),
      current = await fresh.provider.stat(path);
    if (
      fresh.config.providerKey !== source.config.providerKey ||
      current.id !== initial.id ||
      current.etag !== initial.etag ||
      current.size !== initial.size ||
      current.mime !== initial.mime
    )
      throw new ConflictException("读取期间文件已变化，请重试。");
    await fresh.provider.assertReadable(current);
    const hash = digest(content),
      version =
        current.etag +
        ":" +
        digest(
          JSON.stringify(
            extracted.parserVersion === "utf8-text-v1"
              ? [current.name, hash, extracted.parserVersion]
              : [
                  current.name,
                  hash,
                  extracted.parserVersion,
                  digest(JSON.stringify(metadata)),
                ],
          ),
        );
    return this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        s.workspaceId + s.id + source.config.providerKey,
      ]);
      const existing = (
        await c.query(
          "SELECT f.asset_id,a.source_version,a.validity,a.title,a.visibility FROM cw_source_files f JOIN cw_assets a ON a.id=f.asset_id WHERE f.workspace_id=$1 AND f.actor_id=$2 AND f.provider_key=$3 AND f.remote_file_id=$4",
          [s.workspaceId, s.id, source.config.providerKey, current.id],
        )
      ).rows[0];
      const count = (
        await c.query(
          "SELECT count(*) FROM cw_source_files WHERE workspace_id=$1 AND actor_id=$2",
          [s.workspaceId, s.id],
        )
      ).rows[0];
      if (!existing && Number(count.count) >= 50)
        throw new BadRequestException("当前每人最多保留 50 个文件导入记录。");
      const id = existing?.asset_id ?? randomUUID();
      if (!existing)
        await c.query(
          "INSERT INTO cw_assets(id,workspace_id,owner_id,visibility,title,content,type,source_ref,source_version) VALUES($1,$2,$3,'private',$4,$5,'source_file',$6,$7)",
          [
            id,
            s.workspaceId,
            s.id,
            current.name,
            content,
            "file:" + source.config.providerKey + ":" + current.id,
            version,
          ],
        );
      else if (
        existing.source_version !== version ||
        existing.validity !== "active" ||
        existing.title !== current.name ||
        existing.visibility !== "private"
      ) {
        await c.query("SELECT id FROM cw_assets WHERE id=$1 FOR UPDATE", [id]);
        await invalidateFileDependents(c, id, existing.source_version);
        await c.query(
          `UPDATE cw_assets SET title=$2,content=$3,source_version=$4,validity='active',visibility='private',${CLEAR_INDEX},updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$5 AND owner_id=$6`,
          [id, current.name, content, version, s.workspaceId, s.id],
        );
      }
      await c.query(
        `INSERT INTO cw_source_files(asset_id,workspace_id,actor_id,provider_key,remote_file_id,path,source_etag,size_bytes,content_mime,content_sha256,parser_version,extraction_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(asset_id) DO UPDATE SET path=EXCLUDED.path,source_etag=EXCLUDED.source_etag,size_bytes=EXCLUDED.size_bytes,content_mime=EXCLUDED.content_mime,content_sha256=EXCLUDED.content_sha256,parser_version=EXCLUDED.parser_version,extraction_metadata=EXCLUDED.extraction_metadata,imported_at=clock_timestamp(),checked_at=clock_timestamp()`,
        [
          id,
          s.workspaceId,
          s.id,
          source.config.providerKey,
          current.id,
          JSON.stringify(current.path),
          current.etag,
          current.size,
          current.mime,
          hash,
          extracted.parserVersion,
          JSON.stringify(metadata),
        ],
      );
      return { id, title: current.name, sourceVersion: version };
    });
  }
}
