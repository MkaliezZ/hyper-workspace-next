import { ConflictException } from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import { ApprovalRunPlan } from "@hyper/contracts/approvals";
import type { Database } from "../db/database.js";
import { ApprovalService } from "./approvals.js";
import { ExecutionPolicyService } from "./execution-policy.js";
import { assertMember } from "./security.js";

export class ApprovalRunService {
  private readonly approvals: ApprovalService;
  constructor(private readonly db: Database) {
    this.approvals = new ApprovalService(db);
  }
  async history(s: Subject) {
    await assertMember(this.db, s);
    if (s.demo) return [];
    return (
      await this.db.pool.query(
        `SELECT r.id,r.engine,r.state,r.created_at AS "createdAt",
           COALESCE(r.approval_plan->'action'->>'operation','read') AS operation
         FROM cw_runs r JOIN cw_approval_requests a
           ON a.id::text=r.approval_plan->>'requestId' AND a.workspace_id=r.workspace_id
         WHERE r.workspace_id=$1 AND r.actor_id=$2 AND r.workflow='manage_approval'
           AND (a.applicant_id=$2 OR a.visible_reviewers @> ARRAY[$2]::uuid[]
             OR EXISTS (SELECT 1 FROM cw_approval_operations o
               WHERE o.source_run_id=r.id AND o.workspace_id=r.workspace_id
                 AND o.actor_id=r.actor_id AND o.request_id=a.id AND o.action='transfer'))
         ORDER BY r.created_at DESC,r.id DESC LIMIT 20`,
        [s.workspaceId, s.id],
      )
    ).rows;
  }
  async recordedReceipt(s: Subject, id: string) {
    const operation = (
      await this.db.pool.query(
        `SELECT action,receipt FROM cw_approval_operations
         WHERE source_run_id=$1 AND workspace_id=$2 AND actor_id=$3`,
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    return operation
      ? {
          tool: "approval.manage" as const,
          state: "succeeded",
          operation: operation.action,
          approval: operation.receipt,
        }
      : undefined;
  }
  async scope(s: Subject, raw: unknown, runId?: string) {
    return this.approvals.runScope(s, ApprovalRunPlan.parse(raw), false, runId);
  }
  async prepare(s: Subject, raw: unknown) {
    const plan = ApprovalRunPlan.parse(raw);
    await this.approvals.runScope(s, plan, true);
    return plan;
  }
  async context(s: Subject, run: { approval_plan: unknown }) {
    const plan = await this.prepare(s, run.approval_plan);
    return {
      context:
        "Host-bound private approval operation. Return exactly one approval.manage with empty args. The host reads the current state or applies the employee-confirmed action. The form and identities are withheld. A model cannot cast an approval vote or choose a target, recipient, action or field.\n" +
        JSON.stringify({
          operation: plan.operation === "read" ? "read" : plan.action.operation,
        }),
      sourceIds: [] as string[],
      contextRefs: [] as string[],
      live: true,
    };
  }
  async execute(
    s: Subject,
    run: any,
    execution: {
      lease: string;
      contextBytes: number;
      actionCount: number;
      signal?: AbortSignal;
    },
  ) {
    const plan = ApprovalRunPlan.parse(run.approval_plan);
    execution.signal?.throwIfAborted();
    const row = await this.approvals.runScope(s, plan, false, run.id);
    if (plan.operation === "apply") {
      const receipt = await this.approvals.action(
        s,
        plan.requestId,
        plan.action,
        {
          ...execution,
          runId: run.id,
          plan,
        },
      );
      return {
        tool: "approval.manage" as const,
        state: "succeeded",
        operation: plan.action.operation,
        approval: receipt,
      };
    }
    const live = await this.db.pool.query(
      `SELECT id FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3
        AND state='running' AND lease_owner=$4 AND lease_expires_at>clock_timestamp()`,
      [run.id, s.workspaceId, s.id, execution.lease],
    );
    if (!live.rowCount)
      throw new ConflictException("审批执行已停止或租约失效。");
    await new ExecutionPolicyService(this.db).check(
      this.db.pool,
      s,
      run,
      execution.contextBytes,
      execution.actionCount,
    );
    execution.signal?.throwIfAborted();
    return {
      tool: "approval.manage" as const,
      state: "succeeded",
      operation: "read",
      approval: row,
    };
  }
}
