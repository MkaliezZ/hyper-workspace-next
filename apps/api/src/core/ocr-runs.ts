import { z } from "zod";
import { ConflictException } from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import { OcrRunPlan, type OcrSource } from "@hyper/contracts/ocr";
import type { Database } from "../db/database.js";
import { OcrService } from "./ocr.js";

const BoundOcrPlan = OcrRunPlan.extend({
  binding: z.string().regex(/^[0-9a-f]{64}$/),
});

export class OcrRunService {
  private readonly ocr: OcrService;
  constructor(private readonly db: Database) {
    this.ocr = new OcrService(db);
  }

  async review(s: Subject, selection: OcrSource) {
    const { binding, result } = await this.ocr.inspect(s, selection);
    const history = (
      await this.db.pool.query(
        `SELECT id,engine,state,created_at AS "createdAt" FROM cw_runs
       WHERE workspace_id=$1 AND actor_id=$2 AND workflow='recognize_ocr'
         AND ocr_plan->>'binding'=$3 AND ocr_plan->'source'=$4::jsonb
       ORDER BY created_at DESC,id DESC LIMIT 20`,
        [s.workspaceId, s.id, binding, selection],
      )
    ).rows;
    return { result, history };
  }

  async scope(s: Subject, raw: unknown) {
    const plan = BoundOcrPlan.parse(raw);
    const current = await this.ocr.inspect(s, plan.source);
    if (current.binding !== plan.binding)
      throw new ConflictException("OCR 的文件来源已变化。");
    return current.result;
  }

  async prepare(s: Subject, raw: unknown) {
    const plan = OcrRunPlan.parse(raw);
    const { result, binding } = await this.ocr.inspect(s, plan.source);
    if ((result?.revision ?? 0) !== plan.expectedRevision)
      throw new ConflictException("识别版本已更新，请刷新后发起 OCR。");
    return { ...plan, binding };
  }

  async context(s: Subject, raw: unknown) {
    const plan = BoundOcrPlan.parse(raw);
    const current = await this.scope(s, plan);
    if ((current?.revision ?? 0) !== plan.expectedRevision)
      throw new ConflictException("识别版本已更新，请刷新后发起 OCR。");
    return {
      context:
        "Host-bound private OCR operation. Return exactly one ocr.recognize with empty args. The employee fixed the page and revision. The host calls the configured private OCR engine. Do not choose or describe the file, read text, correct content, or claim any result before the host receipt. No source bytes, paths, coordinates or text are included.",
      sourceIds: [] as string[],
      contextRefs: [] as string[],
      live: true,
    };
  }

  private receipt(documentId: string, revision: number, page: number) {
    return {
      tool: "ocr.recognize" as const,
      state: "succeeded" as const,
      documentId,
      revision,
      page,
    };
  }

  async recordedReceipt(s: Subject, runId: string) {
    const row = (
      await this.db.pool.query<{ id: string; revision: number; page: number }>(
        `SELECT d.id,v.revision,d.page FROM cw_ocr_revisions v
       JOIN cw_ocr_documents d ON d.id=v.document_id
       WHERE v.source_run_id=$1 AND d.workspace_id=$2 AND d.actor_id=$3
         AND d.invalidated_at IS NULL AND v.content IS NOT NULL`,
        [runId, s.workspaceId, s.id],
      )
    ).rows[0];
    if (row) return this.receipt(row.id, row.revision, row.page);
  }

  async execute(
    s: Subject,
    run: { id: string; ocr_plan: unknown },
    execution: {
      lease: string;
      contextBytes: number;
      actionCount: number;
      signal?: AbortSignal;
    },
  ) {
    const plan = BoundOcrPlan.parse(run.ocr_plan);
    const result = await this.ocr.recognize(
      s,
      {
        source: plan.source,
        expectedRevision: plan.expectedRevision,
        idempotencyKey: run.id,
      },
      { ...execution, runId: run.id, plan },
    );
    return this.receipt(result.id, result.revision, result.source.page);
  }
}
