import { SpendLimitError } from "./money.js";
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { ProjectAccess } from "./project-access.js";
import { verifyKnowledgeSources } from "./knowledge-sources.js";
import { ModelService, embed, type ModelConnection } from "./models.js";
import { MethodsService } from "./methods.js";
import { stableDigest } from "./credentials.js";
import {
  CHUNK_INDEX_VERSION,
  MAX_INDEX_TEXT,
  textChunks,
} from "./text-chunks.js";
const space = (model: ModelConnection) =>
  stableDigest({
    id: model.id,
    provider: model.provider,
    endpoint: model.endpoint,
    model: model.model,
    ...((model.embeddingInputChars ?? 4000) !== 4000
      ? { inputCharacters: model.embeddingInputChars }
      : {}),
  });
const bindingKey = (row: any) =>
  row ? row.provider_key + "\n" + row.conversation_ref : "";
/** Chunk vectors are derived; every dispatch and retrieval intersects current source/product access. */
export class KnowledgeService {
  constructor(private db: Database) {}
  private async allowed(s: Subject, ids?: string[]) {
    await assertMember(this.db, s);
    const projects = await new ProjectAccess(this.db).visibleIds(s),
      files = await verifyKnowledgeSources(this.db, s, ids);
    return { projects, files };
  }
  async index(s: Subject, ids: string[], modelProfileId?: string) {
    if (!ids.length || ids.length > 20)
      throw new BadRequestException("每次选择 1 至 20 份资料。");
    const initial = await this.allowed(s, ids),
      access = new ProjectAccess(this.db),
      rows = (
        await this.db.pool.query(
          `SELECT id,title,content,source_version,source_version AS "sourceVersion",source_ref AS "sourceRef",project_id,EXISTS(SELECT 1 FROM cw_source_bound_assets f WHERE f.asset_id=cw_assets.id) AS "fileSource" FROM cw_assets WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND deleted_at IS NULL AND validity='active' AND (visibility='workspace' OR owner_id=$3) AND (project_id IS NULL OR project_id=ANY($4::uuid[])) AND (NOT EXISTS(SELECT 1 FROM cw_source_bound_assets f WHERE f.asset_id=cw_assets.id) OR id=ANY($5::uuid[])) ORDER BY id`,
          [
            ids,
            s.workspaceId,
            s.id,
            initial.projects,
            [...initial.files.keys()],
          ],
        )
      ).rows;
    if (
      rows.length !== new Set(ids).size ||
      (await MethodsService.filterAssets(this.db, rows)).length !== rows.length
    )
      throw new NotFoundException(
        "部分资料不存在、方法未发布或无权访问，未发送向量请求。",
      );
    if (rows.some((row) => row.content.length > MAX_INDEX_TEXT))
      throw new BadRequestException(
        "单份资料索引支持最多十八万字符，请缩小资料范围。",
      );
    const connection = await new ModelService(this.db).resolve(
        s,
        "embedding",
        modelProfileId,
      ),
      plans = rows.map((row) => {
        const capacity = connection.embeddingInputChars ?? 4000;
        // A title is an optional retrieval hint; the complete title remains
        // metadata. Never consume the minimum content capacity or truncate it.
        const prefix =
          row.title.length + 1 <= capacity - 200 ? row.title + "\n" : "";
        const chunkLimit = Math.min(2000, capacity - prefix.length);
        return {
          row,
          prefix,
          chunks: textChunks(
            row.content,
            chunkLimit,
            Math.min(200, Math.floor(chunkLimit / 10)),
          ),
        };
      }),
      bindings = new Map<string, string>();
    for (const projectId of new Set(
      rows.map((row) => row.project_id).filter(Boolean),
    ))
      bindings.set(projectId, bindingKey(await access.binding(s, projectId)));
    const items = plans.flatMap((plan) =>
        plan.chunks.map((chunk) => ({
          row: plan.row,
          prefix: plan.prefix,
          chunk,
        })),
      ),
      vectors = new Map<string, number[]>();
    let completedModelBatches = 0;
    try {
      for (let offset = 0; offset < items.length; offset += 32) {
        const batch = items.slice(offset, offset + 32),
          batchIds = [...new Set(batch.map((item) => item.row.id))],
          current = await this.allowed(s, batchIds);
        const versions = (
          await this.db.pool.query(
            "SELECT id,content,source_version,project_id,visibility,owner_id,validity,deleted_at FROM cw_assets WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
            [s.workspaceId, batchIds],
          )
        ).rows;
        const allowed = await MethodsService.filterAssets(
          this.db,
          batch.map((item) => item.row),
        );
        const currentBindings = new Map<string, string>();
        for (const projectId of new Set(
          batch.map((item) => item.row.project_id).filter(Boolean),
        ))
          currentBindings.set(
            projectId,
            bindingKey(await access.binding(s, projectId)),
          );
        const send = batch.filter(
          ({ row }) =>
            (!row.project_id ||
              currentBindings.get(row.project_id) ===
                bindings.get(row.project_id)) &&
            allowed.some((value) => value.id === row.id) &&
            versions.some(
              (value) =>
                value.id === row.id &&
                value.content === row.content &&
                value.source_version === row.source_version &&
                value.validity === "active" &&
                !value.deleted_at &&
                (value.visibility === "workspace" || value.owner_id === s.id) &&
                (!value.project_id ||
                  current.projects.includes(value.project_id)),
            ) &&
            (!row.fileSource ||
              current.files.get(row.id) === row.source_version),
        );
        if (!send.length) continue;
        // A single supplier request must have an honest project attribution. Do not
        // mix chunks from multiple projects into an unattributed budget request.
        const groups = new Map<string | null, typeof send>();
        for (const item of send) {
          const key = item.row.project_id ?? null;
          const group = groups.get(key) ?? [];
          group.push(item);
          groups.set(key, group);
        }
        for (const [projectId, group] of groups) {
          const scopedConnection = projectId
            ? await new ModelService(this.db).resolve(
                s,
                "embedding",
                connection.id,
                projectId,
              )
            : connection;
          if (
            projectId &&
            bindingKey(await access.binding(s, projectId)) !==
              bindings.get(projectId)
          )
            throw new ConflictException(
              "资料来源已变化，未发出此项目的向量请求。",
            );
          if (
            scopedConnection.model !== connection.model ||
            scopedConnection.endpoint !== connection.endpoint ||
            scopedConnection.provider !== connection.provider ||
            scopedConnection.embeddingInputChars !==
              connection.embeddingInputChars
          )
            throw new ConflictException(
              "模型连接已变化，本轮索引不混用不同模型。",
            );
          const result = await embed(
            scopedConnection,
            group.map(({ prefix, chunk }) => prefix + chunk.content),
          );
          completedModelBatches++;
          group.forEach((item, i) =>
            vectors.set(item.row.id + ":" + item.chunk.ordinal, result[i]!),
          );
        }
      }
    } catch (error) {
      if (completedModelBatches > 0)
        throw new BadRequestException(
          `本次索引未完成；此前已完成 ${completedModelBatches} 批模型请求，相关用量与费用按实际记录核对。本轮新向量尚未提交。${error instanceof SpendLimitError ? error.message : "请核对当前索引状态和模型用量后继续。"}`,
        );
      throw error;
    }
    const final = await this.allowed(s, ids),
      indexed: string[] = [];
    for (const { row, chunks } of plans) {
      if (
        (row.project_id && !final.projects.includes(row.project_id)) ||
        (row.fileSource &&
          final.files.get(row.id) !== row.source_version) ||
        chunks.some((chunk) => !vectors.has(row.id + ":" + chunk.ordinal))
      )
        continue;
      const dimensions = vectors.get(row.id + ":0")!.length;
      if (
        chunks.some(
          (chunk) =>
            vectors.get(row.id + ":" + chunk.ordinal)!.length !== dimensions,
        )
      )
        throw new BadRequestException("向量模型在同一索引中返回了不同维度。");
      const stored = await this.db.tx(async (c) => {
        const member = await c.query(
          "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [s.workspaceId, s.id],
        );
        if (!member.rowCount) return false;
        if (
          s.identityCredentialId &&
          !(
            await c.query(
              "SELECT id FROM cw_identity_credentials WHERE id=$1 AND disabled_at IS NULL FOR SHARE",
              [s.identityCredentialId],
            )
          ).rowCount
        )
          return false;
        if (row.project_id) {
          const binding = (
            await c.query(
              "SELECT * FROM cw_project_sources WHERE project_id=$1 AND workspace_id=$2 FOR SHARE",
              [row.project_id, s.workspaceId],
            )
          ).rows[0];
          if (bindingKey(binding) !== bindings.get(row.project_id))
            return false;
        }
        const updated = await c.query(
          `UPDATE cw_assets SET embedding=$1::vector,embedding_profile_id=$2,embedding_model=$3,embedding_dimensions=$4,embedding_source_version=source_version,embedding_version=$5,indexed_at=clock_timestamp() WHERE id=$6 AND workspace_id=$7 AND source_version=$8 AND content=$9 AND deleted_at IS NULL AND validity='active' AND (visibility='workspace' OR owner_id=$10) AND (NOT EXISTS(SELECT 1 FROM cw_methods m WHERE m.id=cw_assets.id) OR EXISTS(SELECT 1 FROM cw_methods m WHERE m.id=cw_assets.id AND m.state='published' AND m.workspace_id=cw_assets.workspace_id AND m.project_id=cw_assets.project_id AND m.current_version::text||':'||m.revision::text=cw_assets.source_version)) RETURNING id`,
          [
            JSON.stringify(vectors.get(row.id + ":0")),
            connection.id,
            connection.model,
            dimensions,
            CHUNK_INDEX_VERSION,
            row.id,
            s.workspaceId,
            row.source_version,
            row.content,
            s.id,
          ],
        );
        if (!updated.rowCount) return false;
        await c.query("DELETE FROM cw_asset_chunks WHERE asset_id=$1", [
          row.id,
        ]);
        const values: unknown[] = [],
          placeholders = chunks.map((chunk, i) => {
            values.push(
              row.id,
              chunk.ordinal,
              chunk.start,
              chunk.end,
              chunk.content,
              row.source_version,
              connection.id,
              connection.model,
              dimensions,
              space(connection),
              CHUNK_INDEX_VERSION,
              JSON.stringify(vectors.get(row.id + ":" + chunk.ordinal)),
            );
            return (
              "(" +
              Array.from(
                { length: 12 },
                (_, j) => "$" + (i * 12 + j + 1) + (j === 11 ? "::vector" : ""),
              ).join(",") +
              ")"
            );
          });
        await c.query(
          "INSERT INTO cw_asset_chunks(asset_id,ordinal,char_start,char_end,content,source_version,model_profile_id,embedding_model,embedding_dimensions,embedding_space_hash,index_version,embedding) VALUES" +
            placeholders.join(","),
          values,
        );
        return true;
      });
      if (stored) indexed.push(row.id);
    }
    return {
      indexed,
      skipped: ids.filter((id) => !indexed.includes(id)),
      modelProfileId: connection.id,
      indexVersion: CHUNK_INDEX_VERSION,
      chunks: indexed.reduce(
        (count, id) =>
          count + plans.find((plan) => plan.row.id === id)!.chunks.length,
        0,
      ),
    };
  }
  private async finalize(s: Subject, rows: any[]) {
    if (!rows.length) return [];
    const current = await this.allowed(s, [
      ...new Set(rows.filter((row) => row.fileSource).map((row) => row.id)),
    ]);
    const latest = (
      await this.db.pool.query(
        "SELECT id,source_version,updated_at::text AS updated_at,project_id,visibility,owner_id FROM cw_assets WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND validity='active' AND deleted_at IS NULL",
        [s.workspaceId, [...new Set(rows.map((row) => row.id))]],
      )
    ).rows;
    return (await MethodsService.filterAssets(this.db, rows)).filter(
      (row) =>
        latest.some(
          (value) =>
            value.id === row.id &&
            value.source_version === row.sourceVersion &&
            value.updated_at === row.assetUpdatedAt &&
            (value.visibility === "workspace" || value.owner_id === s.id) &&
            (!value.project_id || current.projects.includes(value.project_id)),
        ) &&
        (!row.fileSource ||
          current.files.get(row.id) === row.sourceVersion),
    );
  }
  async semantic(
    s: Subject,
    query: string,
    modelProfileId?: string,
    assetIds?: string[],
  ) {
    if (!query.trim() || query.length > 4000)
      throw new BadRequestException("请输入 1 至 4000 字符的检索问题。");
    await assertMember(this.db, s);
    const connection = await new ModelService(this.db).resolve(
        s,
        "embedding",
        modelProfileId,
      ),
      vector = (await embed(connection, [query]))[0]!,
      current = await this.allowed(s, assetIds);
    const common = `a.workspace_id=$2 AND a.deleted_at IS NULL AND a.validity='active' AND (a.visibility='workspace' OR a.owner_id=$3) AND (a.project_id IS NULL OR a.project_id=ANY($6::uuid[])) AND (NOT EXISTS(SELECT 1 FROM cw_source_bound_assets f WHERE f.asset_id=a.id) OR a.id=ANY($7::uuid[])) AND ($8::uuid[] IS NULL OR a.id=ANY($8::uuid[]))`;
    const fields = `a.id,a.title,a.type,a.project_id,a.source_ref AS "sourceRef",a.source_version AS "sourceVersion",a.updated_at::text AS "assetUpdatedAt",EXISTS(SELECT 1 FROM cw_source_bound_assets f WHERE f.asset_id=a.id) AS "fileSource"`;
    const args = [
      JSON.stringify(vector),
      s.workspaceId,
      s.id,
      connection.id,
      vector.length,
      current.projects,
      [...current.files.keys()],
      assetIds ?? null,
    ];
    const [chunks, legacy] = await Promise.all([
      this.db.pool.query(
        `SELECT ${fields},c.content,c.ordinal,c.char_start AS "charStart",c.char_end AS "charEnd",1-(c.embedding <=> $1::vector) AS similarity FROM cw_asset_chunks c JOIN cw_assets a ON a.id=c.asset_id WHERE ${common} AND a.embedding_version='text-chunks-v1' AND c.source_version=a.source_version AND c.model_profile_id=$4 AND c.embedding_dimensions=$5 AND c.embedding_model=$9 AND c.embedding_space_hash=$10 AND c.index_version='text-chunks-v1' ORDER BY c.embedding <=> $1::vector,a.id,c.ordinal LIMIT 120`,
        [...args, connection.model, space(connection)],
      ),
      this.db.pool.query(
        `SELECT ${fields},a.content,0 AS ordinal,0 AS "charStart",char_length(a.content) AS "charEnd",1-(a.embedding <=> $1::vector) AS similarity FROM cw_assets a WHERE ${common} AND a.embedding_profile_id=$4 AND a.embedding_dimensions=$5 AND a.embedding_model=$9 AND a.embedding_source_version=a.source_version AND a.embedding_version='text-v1' AND a.embedding IS NOT NULL AND $10::int=4000 ORDER BY a.embedding <=> $1::vector,a.id LIMIT 30`,
        [...args, connection.model, connection.embeddingInputChars ?? 4000],
      ),
    ]);
    const rows = await this.finalize(s, [
        ...chunks.rows,
        ...legacy.rows.map((row) => ({ ...row, charEnd: row.content.length })),
      ]),
      grouped = new Map<string, any>();
    for (const row of rows.sort(
      (a, b) =>
        Number(b.similarity) - Number(a.similarity) ||
        a.id.localeCompare(b.id) ||
        a.ordinal - b.ordinal,
    )) {
      const citation = {
        ordinal: row.ordinal,
        start: row.charStart,
        end: row.charEnd,
        content: row.content,
        sourceVersion: row.sourceVersion,
        reference:
          "asset:" +
          row.id +
          "@" +
          row.sourceVersion +
          "#chars=" +
          row.charStart +
          "-" +
          row.charEnd,
      };
      const existing = grouped.get(row.id);
      if (existing) {
        if (existing.chunks.length < 3) existing.chunks.push(citation);
        continue;
      }
      grouped.set(row.id, {
        id: row.id,
        title: row.title,
        type: row.type,
        content: row.content,
        sourceRef: row.sourceRef,
        sourceVersion: row.sourceVersion,
        similarity: row.similarity,
        chunks: [citation],
      });
    }
    return [...grouped.values()].slice(0, 30).map((row) => ({
      ...row,
      content: row.chunks.map((chunk: any) => chunk.content).join("\n\n"),
    }));
  }
}
export async function refreshArtifactIndex(
  c: PoolClient,
  workspaceId: string,
  id: string,
  content: string,
  version: number,
) {
  await c.query(
    "UPDATE cw_assets SET content=$1,source_version=$2,updated_at=clock_timestamp(),embedding=NULL,embedding_profile_id=NULL,embedding_dimensions=NULL,embedding_source_version=NULL,embedding_model=NULL,embedding_version=NULL,indexed_at=NULL WHERE workspace_id=$3 AND source_ref=$4 AND deleted_at IS NULL",
    [content, String(version), workspaceId, "artifact:" + id],
  );
}
