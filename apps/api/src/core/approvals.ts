import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Subject } from "@hyper/contracts";
import {
  ApprovalAction,
  ApprovalDefinition,
  ApprovalOpen,
  ApprovalPublish,
  approvalFieldAccepts,
  type ApprovalForm,
  type ApprovalStage,
  type ApprovalState,
  type ApprovalStep,
} from "@hyper/contracts/approvals";
import type { Database } from "../db/database.js";
import { stableDigest } from "./credentials.js";
import { assertMember } from "./security.js";

interface RequestRow {
  id: string;
  flow_id: string;
  flow_version: number;
  applicant_id: string;
  state: ApprovalState;
  revision: number;
  attempt: number;
  stage: number;
  form: ApprovalForm;
  stages: ApprovalStage[];
  visible_reviewers: string[];
}

function plan(
  definition: ApprovalDefinition,
  form: ApprovalForm,
): ApprovalStage[] {
  const fields = new Map(definition.fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(form)) {
    const field = fields.get(key);
    if (!field || !approvalFieldAccepts(field, value))
      throw new BadRequestException("表单包含未知字段或不符合定义的值。");
  }
  if (
    definition.fields.some(
      (field) => field.required && !Object.hasOwn(form, field.key),
    )
  )
    throw new BadRequestException("请填写所有必填字段。");
  const stages = definition.stages
    .map((stage) => ({
      label: stage.label,
      steps: stage.steps
        .filter((step) =>
          step.when.every((test) => {
            const value = form[test.field];
            switch (test.operator) {
              case "eq":
                return value === test.value;
              case "neq":
                return value !== test.value;
              case "lt":
                return (
                  typeof value === "number" &&
                  typeof test.value === "number" &&
                  value < test.value
                );
              case "gte":
                return (
                  typeof value === "number" &&
                  typeof test.value === "number" &&
                  value >= test.value
                );
            }
          }),
        )
        .map((step) => ({
          key: step.key,
          label: step.label,
          requiredApprovals: step.requiredApprovals,
          assignments: step.reviewers.map((reviewerId) => ({
            reviewerId,
            version: 1,
            decision: null,
          })),
        })),
    }))
    .filter((stage) => stage.steps.length);
  if (!stages.length)
    throw new BadRequestException("当前表单没有匹配任何审批步骤。");
  return stages;
}
function stepState(step: ApprovalStep) {
  const approved = step.assignments.filter(
    (item) => item.decision === "approve",
  ).length;
  const pending = step.assignments.filter(
    (item) => item.decision === null,
  ).length;
  return approved >= step.requiredApprovals
    ? "approved"
    : approved + pending < step.requiredApprovals
      ? "rejected"
      : "active";
}
function reviewers(stage: ApprovalStage) {
  return stage.steps.flatMap((step) =>
    step.assignments.map((item) => item.reviewerId),
  );
}
function pendingAssignment(
  step: ApprovalStep,
  reviewerId: string,
  version: number,
) {
  const assignment = step.assignments.find(
    (item) => item.reviewerId === reviewerId,
  );
  if (!assignment)
    throw new ForbiddenException("仅当前步骤获分派的员工可以处理。");
  if (
    assignment.version !== version ||
    assignment.decision !== null ||
    stepState(step) !== "active"
  )
    throw new ConflictException("审批分派已变化或步骤已经结束。");
  return assignment;
}
function summary(row: RequestRow) {
  return {
    id: row.id,
    flowId: row.flow_id,
    flowVersion: row.flow_version,
    applicantId: row.applicant_id,
    state: row.state,
    revision: row.revision,
    attempt: row.attempt,
    stage: row.stage,
  };
}

type OperationResult = {
  scope: { requestId: string } | { flowId: string };
  audit: unknown;
  receipt: object;
};

export class ApprovalService {
  constructor(private readonly db: Database) {}

  private async mutate<T extends OperationResult>(
    s: Subject,
    action: string,
    idempotencyKey: string,
    params: unknown,
    admin: boolean,
    change: (c: PoolClient) => Promise<T>,
  ): Promise<T["receipt"]> {
    await assertMember(this.db, s);
    const hash = stableDigest({ action, params });
    return this.db.tx(async (c) => {
      const member = (
        await c.query(
          "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [s.workspaceId, s.id],
        )
      ).rows[0];
      if (!member || (admin && member.role !== "admin"))
        throw new ForbiddenException(
          admin ? "仅工作区管理员可发布审批流程。" : "工作区成员资格已撤销。",
        );
      if (s.identityCredentialId) {
        const identity = await c.query(
          `SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id
            WHERE c.id=$1 AND i.workspace_id=$2 AND i.user_id=$3 AND c.disabled_at IS NULL FOR SHARE OF c,i`,
          [s.identityCredentialId, s.workspaceId, s.id],
        );
        if (!identity.rowCount)
          throw new ForbiddenException("当前来源身份已撤销。");
      }
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `approval-operation:${s.workspaceId}:${s.id}:${idempotencyKey}`,
      ]);
      const previous = (
        await c.query(
          `SELECT params_hash,receipt,request_id FROM cw_approval_operations
          WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3`,
          [s.workspaceId, s.id, idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        if (previous.params_hash !== hash)
          throw new ConflictException("同一操作键不能更换审批操作。");
        // A completed transfer can remove the caller's visibility. The exact
        // same key may recover its original receipt without reading the case.
        if (previous.request_id && action !== "transfer")
          await this.request(c, s, previous.request_id);
        return previous.receipt;
      }
      const result = await change(c);
      await c.query(
        `INSERT INTO cw_approval_operations(id,workspace_id,actor_id,request_id,flow_id,action,idempotency_key,params_hash,audit,receipt)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          randomUUID(),
          s.workspaceId,
          s.id,
          "requestId" in result.scope ? result.scope.requestId : null,
          "flowId" in result.scope ? result.scope.flowId : null,
          action,
          idempotencyKey,
          hash,
          result.audit,
          result.receipt,
        ],
      );
      return result.receipt;
    });
  }
  private async verifyReviewers(
    c: PoolClient,
    workspaceId: string,
    ids: string[],
  ) {
    const unique = [...new Set(ids)].sort();
    const members = await c.query(
      "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE",
      [workspaceId, unique],
    );
    if (members.rowCount !== unique.length)
      throw new BadRequestException("流程含已经离开工作区的审批人。");
  }
  async flows(s: Subject) {
    await assertMember(this.db, s);
    return (
      await this.db.pool.query(
        `SELECT f.id,v.version,v.definition FROM cw_approval_flows f JOIN cw_approval_flow_versions v
        ON v.flow_id=f.id AND v.workspace_id=f.workspace_id AND v.version=f.current_version
        WHERE f.workspace_id=$1 ORDER BY v.published_at DESC,v.flow_id LIMIT 100`,
        [s.workspaceId],
      )
    ).rows;
  }
  async publish(s: Subject, raw: unknown) {
    const input = ApprovalPublish.parse(raw);
    return this.mutate(
      s,
      "publish",
      input.idempotencyKey,
      input,
      true,
      async (c) => {
        await this.verifyReviewers(
          c,
          s.workspaceId,
          input.definition.stages.flatMap((stage) =>
            stage.steps.flatMap((step) => step.reviewers),
          ),
        );
        const id = input.previous?.id ?? randomUUID();
        const version = (input.previous?.version ?? 0) + 1;
        if (input.previous) {
          const changed = await c.query(
            "UPDATE cw_approval_flows SET current_version=$1 WHERE id=$2 AND workspace_id=$3 AND current_version=$4",
            [version, id, s.workspaceId, input.previous.version],
          );
          if (!changed.rowCount)
            throw new ConflictException("审批流程版本已变化或无权访问。");
        } else {
          await c.query(
            "INSERT INTO cw_approval_flows(id,workspace_id,current_version)VALUES($1,$2,$3)",
            [id, s.workspaceId, version],
          );
        }
        await c.query(
          "INSERT INTO cw_approval_flow_versions(flow_id,workspace_id,version,definition,published_by) VALUES($1,$2,$3,$4,$5)",
          [id, s.workspaceId, version, input.definition, s.id],
        );
        return {
          scope: { flowId: id },
          audit: { version },
          receipt: { id, version },
        };
      },
    );
  }
  async open(s: Subject, raw: unknown) {
    const input = ApprovalOpen.parse(raw);
    return this.mutate(
      s,
      "open",
      input.idempotencyKey,
      input,
      false,
      async (c) => {
        const flow = await c.query(
          "SELECT current_version FROM cw_approval_flows WHERE id=$1 AND workspace_id=$2 FOR SHARE",
          [input.flowId, s.workspaceId],
        );
        if (!flow.rowCount) throw new NotFoundException("审批流程不存在。");
        if (flow.rows[0].current_version !== input.version)
          throw new ConflictException("请选择当前审批流程版本。");
        const { rows } = await c.query<RequestRow>(
          `INSERT INTO cw_approval_requests(id,workspace_id,flow_id,flow_version,applicant_id,state,revision)
          VALUES($1,$2,$3,$4,$5,'draft',1) RETURNING *`,
          [randomUUID(), s.workspaceId, input.flowId, input.version, s.id],
        );
        const row = rows[0]!;
        return {
          scope: { requestId: row.id },
          audit: { version: input.version },
          receipt: summary(row),
        };
      },
    );
  }
  private async request(
    c: Pick<PoolClient, "query">,
    s: Subject,
    id: string,
    lock = false,
  ) {
    const row = (
      await c.query<RequestRow>(
        `SELECT * FROM cw_approval_requests WHERE id=$1 AND workspace_id=$2
        AND (applicant_id=$3 OR visible_reviewers @> ARRAY[$3]::uuid[]) ${lock ? "FOR UPDATE" : ""}`,
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("申请不存在或无权查看。");
    return row;
  }
  async list(s: Subject) {
    await assertMember(this.db, s);
    return (
      await this.db.pool.query<RequestRow & { title: string }>(
        `SELECT r.id,r.flow_id,r.flow_version,r.applicant_id,r.state,r.revision,r.attempt,r.stage,v.definition->>'title' AS title
        FROM cw_approval_requests r JOIN cw_approval_flow_versions v ON v.flow_id=r.flow_id AND v.workspace_id=r.workspace_id AND v.version=r.flow_version
        WHERE r.workspace_id=$1 AND (r.applicant_id=$2 OR r.visible_reviewers @> ARRAY[$2]::uuid[])
        ORDER BY r.updated_at DESC,r.id LIMIT 100`,
        [s.workspaceId, s.id],
      )
    ).rows.map((row) => ({ ...summary(row), title: row.title }));
  }
  async detail(s: Subject, id: string) {
    await assertMember(this.db, s);
    const row = await this.request(this.db.pool, s, id);
    const definition = await this.definition(this.db.pool, s.workspaceId, row);
    const audit = (
      await this.db.pool.query(
        `SELECT id,actor_id AS "actorId",action,audit,recorded_at AS "recordedAt"
        FROM cw_approval_operations WHERE request_id=$1 AND workspace_id=$2
        ORDER BY recorded_at DESC,id DESC LIMIT 100`,
        [id, s.workspaceId],
      )
    ).rows;
    const stages =
      s.id === row.applicant_id
        ? row.stages
        : row.stages.slice(0, row.stage + 1);
    const people = (
      await this.db.pool.query<{ id: string; name: string }>(
        "SELECT id,name FROM cw_users WHERE id=ANY($1::uuid[])",
        [[row.applicant_id, ...stages.flatMap(reviewers)]],
      )
    ).rows;
    // A return/resubmit can change the visible reviewers while this detail is being loaded.
    const current = await this.request(this.db.pool, s, id);
    if (current.revision !== row.revision)
      throw new ConflictException("申请已变化，请刷新。");
    await assertMember(this.db, s);
    return {
      ...summary(row),
      definition,
      form: row.form,
      people: Object.fromEntries(
        people.map((person) => [person.id, person.name]),
      ),
      stages: stages.map((stage) => ({
        ...stage,
        steps: stage.steps.map((step) => ({ ...step, state: stepState(step) })),
      })),
      audit: audit.filter(
        (entry) =>
          s.id === row.applicant_id || entry.audit.attempt === row.attempt,
      ),
    };
  }
  async reminders(s: Subject) {
    await assertMember(this.db, s);
    const rows = (
      await this.db.pool.query<{
        requestId: string;
        recordedAt: Date;
        step: string;
        assignmentVersion: number;
        stage: ApprovalStage;
      }>(
        `SELECT r.id AS "requestId", o.recorded_at AS "recordedAt", o.audit->>'step' AS step,
              (o.audit->>'assignmentVersion')::integer AS "assignmentVersion", r.stages->r.stage AS stage
         FROM cw_approval_operations o JOIN cw_approval_requests r ON r.id=o.request_id AND r.workspace_id=o.workspace_id
        WHERE o.workspace_id=$1 AND o.action='remind' AND o.audit->>'recipientId'=$2 AND r.state='active'
          AND (o.audit->>'attempt')::integer=r.attempt AND r.visible_reviewers @> ARRAY[$2]::uuid[]
        ORDER BY o.recorded_at DESC,o.id LIMIT 100`,
        [s.workspaceId, s.id],
      )
    ).rows;
    return rows.flatMap((row) => {
      const step = row.stage.steps.find((item) => item.key === row.step);
      const assignment = step?.assignments.find(
        (item) => item.reviewerId === s.id,
      );
      if (
        !step ||
        stepState(step) !== "active" ||
        !assignment ||
        assignment.decision !== null ||
        assignment.version !== row.assignmentVersion
      )
        return [];
      return [
        {
          requestId: row.requestId,
          step: row.step,
          recordedAt: row.recordedAt,
        },
      ];
    });
  }
  private async definition(
    c: Pick<PoolClient, "query">,
    workspaceId: string,
    row: RequestRow,
  ) {
    const definition = (
      await c.query(
        "SELECT definition FROM cw_approval_flow_versions WHERE flow_id=$1 AND workspace_id=$2 AND version=$3",
        [row.flow_id, workspaceId, row.flow_version],
      )
    ).rows[0]?.definition;
    return ApprovalDefinition.parse(definition);
  }
  async action(s: Subject, id: string, raw: unknown) {
    const input = ApprovalAction.parse(raw);
    return this.mutate(
      s,
      input.operation,
      input.idempotencyKey,
      { id, input },
      false,
      async (c) => {
        const row = await this.request(c, s, id, true);
        if (
          input.operation === "review" ||
          input.operation === "transfer" ||
          input.operation === "remind"
        ) {
          if (row.state !== "active" || input.attempt !== row.attempt)
            throw new ConflictException("此轮审批已结束，请刷新。");
          const stage = row.stages[row.stage]!;
          const step = stage.steps.find((step) => step.key === input.step);
          if (!step) throw new ForbiddenException("仅当前阶段的步骤可以处理。");
          if (input.operation === "remind") {
            if (s.id !== row.applicant_id)
              throw new ForbiddenException("仅申请人可以催办。");
            pendingAssignment(step, input.recipientId, input.assignmentVersion);
            await this.verifyReviewers(c, s.workspaceId, [input.recipientId]);
            const recent = await c.query(
              `SELECT id FROM cw_approval_operations
                WHERE workspace_id=$1 AND request_id=$2 AND action='remind'
                  AND audit->>'recipientId'=$3 AND audit->>'step'=$4 AND audit->>'attempt'=$5
                  AND recorded_at>clock_timestamp()-interval '30 minutes' LIMIT 1`,
              [
                s.workspaceId,
                id,
                input.recipientId,
                input.step,
                String(row.attempt),
              ],
            );
            if (recent.rowCount)
              throw new ConflictException("最近已催办，请等待审批人处理。");
            return {
              scope: { requestId: id },
              audit: {
                step: input.step,
                recipientId: input.recipientId,
                assignmentVersion: input.assignmentVersion,
                attempt: row.attempt,
                revision: row.revision,
              },
              receipt: summary(row),
            };
          }
          const assignment = pendingAssignment(
            step,
            s.id,
            input.assignmentVersion,
          );
          if (input.operation === "transfer") {
            if (
              input.recipientId === row.applicant_id ||
              step.assignments.some(
                (item) => item.reviewerId === input.recipientId,
              )
            )
              throw new BadRequestException(
                "不能转交给申请人或本步骤已有审批人。",
              );
            await this.verifyReviewers(c, s.workspaceId, [input.recipientId]);
            assignment.reviewerId = input.recipientId;
            assignment.version += 1;
            row.visible_reviewers = [
              ...new Set(row.stages.slice(0, row.stage + 1).flatMap(reviewers)),
            ];
          } else {
            assignment.decision = input.decision;
            if (input.decision === "return") row.state = "returned";
            else if (stepState(step) === "rejected") row.state = "rejected";
            else if (
              stage.steps.every((step) => stepState(step) === "approved")
            ) {
              const next = row.stages[row.stage + 1];
              if (next) {
                row.stage += 1;
                row.visible_reviewers = [
                  ...new Set([...row.visible_reviewers, ...reviewers(next)]),
                ];
              } else row.state = "approved";
            }
          }
        } else {
          if (s.id !== row.applicant_id)
            throw new ForbiddenException("仅申请人可以提交或撤回。");
          if (row.revision !== input.expectedRevision)
            throw new ConflictException("申请版本已变化，请刷新。");
          if (input.operation === "withdraw") {
            if (!["draft", "active", "returned"].includes(row.state))
              throw new ConflictException("审批已结束。");
            row.state = "withdrawn";
          } else {
            if (row.state !== "draft" && row.state !== "returned")
              throw new ConflictException("申请当前不能提交。");
            const stages = plan(
              await this.definition(c, s.workspaceId, row),
              input.form,
            );
            const allReviewers = stages.flatMap(reviewers);
            if (allReviewers.includes(s.id))
              throw new BadRequestException("申请人不能审批本人申请。");
            await this.verifyReviewers(c, s.workspaceId, allReviewers);
            row.form = input.form;
            row.stages = stages;
            row.stage = 0;
            row.attempt += 1;
            row.state = "active";
            row.visible_reviewers = [...new Set(reviewers(stages[0]!))];
          }
        }
        row.revision += 1;
        await c.query(
          `UPDATE cw_approval_requests SET state=$2,revision=$3,attempt=$4,stage=$5,form=$6,stages=$7,
          visible_reviewers=$8,updated_at=clock_timestamp() WHERE id=$1`,
          [
            row.id,
            row.state,
            row.revision,
            row.attempt,
            row.stage,
            row.form,
            JSON.stringify(row.stages),
            row.visible_reviewers,
          ],
        );
        const { idempotencyKey: _key, confirmed: _confirmed, ...audit } = input;
        return {
          scope: { requestId: id },
          audit: { ...audit, attempt: row.attempt, revision: row.revision },
          receipt: summary(row),
        };
      },
    );
  }
}
