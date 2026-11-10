import { NotificationPlan } from "./notifications.js";
export {
  NotificationPlan,
  NotificationRules,
  NotificationField,
} from "./notifications.js";
import { z } from "zod";

export const EngineId = z.enum(["dsh", "hermes", "fixture"]);
export type EngineId = z.infer<typeof EngineId>;
export const RunState = z.enum([
  "queued",
  "running",
  "waiting_input",
  "waiting_confirmation",
  "succeeded",
  "failed",
  "cancelled",
  "recovery_required",
]);
export type RunState = z.infer<typeof RunState>;
export const EventKind = z.enum([
  "run.started",
  "message.delta",
  "progress.updated",
  "input.required",
  "action.proposed",
  "action.completed",
  "artifact.updated",
  "task.updated",
  "method.updated",
  "decision.updated",
  "usage.updated",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.recovery_required",
]);
export type EventKind = z.infer<typeof EventKind>;
export const Workflow = z.enum([
  "plan_work",
  "discussion_to_minutes",
  "project_report",
  "revise_artifact",
  "revise_task",
  "manage_method",
  "review_artifact",
  "follow_up",
  "configure_follow_up",
  "configure_policy",
  "manage_notifications",
  "usage_report",
  "manage_spending",
  "manage_brief",
  "assign_task",
  "directory_report",
  "manage_organization",
  "manage_communication",
  "manage_calendar",
  "manage_approval",
  "share_attachment",
  "manage_decision",
  "query_knowledge",
  "chat",
  "draft_reply",
  "read_file",
  "revise_file_reading",
]);
export type Workflow = z.infer<typeof Workflow>;
export const OrganizationQuery = z
  .object({
    query: z.string().trim().max(200).default(""),
    offset: z.number().int().min(0).max(2000).default(0),
    departmentId: z.uuid().optional(),
  })
  .strict();
const OrganizationBinding = { bindingKey: z.string().min(1).max(128) };
const OrganizationChange = {
  ...OrganizationBinding,
  expectedRevision: z.number().int().nonnegative(),
  confirmed: z.literal(true),
};
export const OrganizationPlan = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("read"),
      ...OrganizationBinding,
      query: OrganizationQuery,
    })
    .strict(),
  z
    .object({
      operation: z.literal("create_department"),
      ...OrganizationChange,
      name: z.string().trim().min(1).max(100),
      parentId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("update_department"),
      ...OrganizationChange,
      departmentId: z.uuid(),
      name: z.string().trim().min(1).max(100),
      parentId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete_department"),
      ...OrganizationChange,
      departmentId: z.uuid(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("assign_department"),
      ...OrganizationChange,
      uid: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[^\u0000-\u001f\u007f]+$/),
      departmentId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("change_role"),
      ...OrganizationChange,
      userId: z.uuid(),
      role: z.enum(["admin", "member"]),
      expectedRole: z.enum(["admin", "member"]),
      expectedRoleRevision: z.number().int().positive(),
      expectedMembershipId: z.uuid(),
    })
    .strict(),
]);
export type OrganizationPlan = z.infer<typeof OrganizationPlan>;
export const WorkSelector = z
  .object({
    name: z.string().trim().min(1).max(300),
    version: z.number().int().positive().optional(),
  })
  .strict();
export const WorkOperation = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create_task"),
      title: z.string().trim().min(1).max(200),
      assignee: WorkSelector.nullable(),
      dueDate: z.iso.date().nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("update_task"),
      target: WorkSelector,
      title: z.string().trim().min(1).max(200).optional(),
      dueDate: z.iso.date().nullable().optional(),
      status: z.enum(["open", "done"]).optional(),
      assignee: WorkSelector.nullable().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("create_artifact"),
      title: z.string().trim().min(1).max(300),
      content: z.string().trim().min(1).max(20000),
    })
    .strict(),
  z
    .object({
      operation: z.literal("revise_artifact"),
      target: WorkSelector,
      content: z.string().trim().min(1).max(20000),
    })
    .strict(),
]);
export type WorkOperation = z.infer<typeof WorkOperation>;
export const WorkProposal = z
  .object({
    summary: z.string().trim().min(1).max(1000),
    operations: z.array(WorkOperation).min(1).max(6),
    questions: z.array(z.string().trim().min(1).max(600)).max(6),
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 60000,
    "工作计划超过 60000 字符。",
  )
  .refine(
    (value) =>
      value.operations.every(
        (operation) =>
          operation.operation !== "update_task" ||
          ["title", "dueDate", "status", "assignee"].some(
            (key) => (operation as any)[key] !== undefined,
          ),
      ),
    "待办修改至少指定一个字段。",
  );
export type WorkProposal = z.infer<typeof WorkProposal>;
export const WorkPlanResponse = z
  .object({
    expectedRevision: z.number().int().positive(),
    answers: z
      .array(
        z
          .object({
            key: z.string().max(60),
            text: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .max(6)
      .default([]),
    selections: z
      .array(
        z
          .object({
            key: z.string().max(60),
            id: z.uuid().nullable(),
            version: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    confirmed: z.boolean().default(false),
    regenerate: z.boolean().default(false),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type WorkPlanResponse = z.infer<typeof WorkPlanResponse>;
export const TaskAssignmentPlan = z
  .object({
    taskId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    assigneeId: z.uuid().nullable(),
    confirmed: z.literal(true),
  })
  .strict();
export type TaskAssignmentPlan = z.infer<typeof TaskAssignmentPlan>;
export const TaskAssignmentInput = z
  .object({ plan: TaskAssignmentPlan, idempotencyKey: z.uuid() })
  .strict();
export const WorkBriefContent = z
  .object({
    title: z.string().trim().min(1).max(200),
    goal: z.string().trim().min(1).max(4000),
    scope: z.string().trim().max(4000),
    constraints: z.string().trim().max(4000),
    completionCriteria: z.string().trim().max(4000),
    questions: z
      .array(z.string().trim().min(1).max(600))
      .max(10)
      .refine(
        (items) => new Set(items).size === items.length,
        "澄清问题不能重复。",
      ),
  })
  .strict();
export type WorkBriefContent = z.infer<typeof WorkBriefContent>;
export const BriefReference = z
  .object({ id: z.uuid(), version: z.number().int().positive() })
  .strict();
export type BriefReference = z.infer<typeof BriefReference>;
const briefTarget = {
  briefId: z.uuid(),
  expectedVersion: z.number().int().positive(),
};
export const WorkBriefPlan = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create") }).strict(),
  z.object({ operation: z.literal("revise"), ...briefTarget }).strict(),
  z
    .object({
      operation: z.literal("answer"),
      ...briefTarget,
      answers: z
        .array(
          z
            .object({
              questionId: z.uuid(),
              answer: z.string().trim().min(1).max(4000),
            })
            .strict(),
        )
        .min(1)
        .max(10),
    })
    .strict(),
  z
    .object({
      operation: z.literal("confirm"),
      ...briefTarget,
      confirmed: z.literal(true),
    })
    .strict(),
  z.object({ operation: z.literal("reopen"), ...briefTarget }).strict(),
]);
export type WorkBriefPlan = z.infer<typeof WorkBriefPlan>;
export const WorkBriefInput = z
  .object({
    plan: WorkBriefPlan,
    draft: WorkBriefContent.optional(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const MoneyAmount = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/, "请输入最多六位小数的非负金额。");
export const ExactMoneyAmount = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})(\.\d{1,12})?$/, "核对金额最多保留十二位小数。");
export const BudgetPriceIdentity = z
  .object({
    provider: z.enum(["openai-compatible", "deepseek", "anthropic"]),
    endpoint: z.url(),
    model: z.string().trim().min(1).max(200),
    purpose: z.enum(["chat", "embedding"]),
  })
  .strict();
export const OrganizationBudgetPlan = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("budget_price"),
      provider: z.enum(["openai-compatible", "deepseek", "anthropic"]),
      endpoint: z.url(),
      model: z.string().trim().min(1).max(200),
      purpose: z.enum(["chat", "embedding"]),
      expectedRevision: z.number().int().min(0),
      currency: z.enum(["CNY", "USD"]),
      inputPerMillion: MoneyAmount,
      outputPerMillion: MoneyAmount,
      cacheReadPerMillion: MoneyAmount,
      cacheWritePerMillion: MoneyAmount,
      source: z.string().trim().min(1).max(1000),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("budget_configure"),
      scope: z.enum(["workspace", "project"]),
      projectId: z.uuid().nullable(),
      expectedRevision: z.number().int().min(0),
      currency: z.enum(["CNY", "USD"]),
      dailyLimit: MoneyAmount.nullable(),
      requestReservation: MoneyAmount,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("budget_reconcile"),
      requestId: z.uuid(),
      expectedRevision: z.number().int().min(0),
      currency: z.enum(["CNY", "USD"]),
      amount: ExactMoneyAmount,
      evidence: z.string().trim().min(1).max(2000),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type OrganizationBudgetPlan = z.infer<typeof OrganizationBudgetPlan>;
export function isOrganizationBudgetPlan(plan: {
  operation: string;
}): plan is OrganizationBudgetPlan {
  return ["budget_price", "budget_configure", "budget_reconcile"].includes(
    plan.operation,
  );
}
export const ModelSpendingPlan = z.discriminatedUnion("operation", [
  ...OrganizationBudgetPlan.options,
  z
    .object({
      operation: z.literal("configure"),
      modelProfileId: z.uuid(),
      expectedRevision: z.number().int().min(0),
      currency: z.enum(["CNY", "USD"]),
      inputPerMillion: MoneyAmount,
      outputPerMillion: MoneyAmount,
      cacheReadPerMillion: MoneyAmount,
      cacheWritePerMillion: MoneyAmount,
      dailyLimit: MoneyAmount.nullable(),
      requestReservation: MoneyAmount,
      source: z.string().trim().min(1).max(1000),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("reconcile"),
      requestId: z.uuid(),
      expectedRevision: z.number().int().min(0),
      currency: z.enum(["CNY", "USD"]),
      amount: ExactMoneyAmount,
      evidence: z.string().trim().min(1).max(2000),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type ModelSpendingPlan = z.infer<typeof ModelSpendingPlan>;
export const ModelSpendingInput = z
  .object({ plan: ModelSpendingPlan, idempotencyKey: z.uuid() })
  .strict();
export const ExecutionRules = z
  .object({
    maxContextBytes: z.number().int().min(1024).max(100000).optional(),
    maxOutputTokens: z.number().int().min(64).max(4096).optional(),
    maxDurationSeconds: z.number().int().min(5).max(180).optional(),
    maxActions: z.number().int().min(0).max(30).optional(),
    engines: z.array(EngineId).max(3).optional(),
    workflows: z.array(Workflow).max(32).optional(),
    dailyRuns: z.number().int().min(0).max(10000).optional(),
    expression: z.enum(["concise", "balanced", "detailed"]).optional(),
  })
  .strict();
export type ExecutionRules = z.infer<typeof ExecutionRules>;
export const ExecutionPolicyPlan = z
  .object({
    scope: z.enum(["workspace", "project", "personal"]),
    expectedRevision: z.number().int().min(0),
    rules: ExecutionRules,
    confirmed: z.literal(true),
  })
  .strict();
export type ExecutionPolicyPlan = z.infer<typeof ExecutionPolicyPlan>;
export const ExecutionPolicyInput = ExecutionPolicyPlan.extend({
  idempotencyKey: z.uuid(),
}).strict();
export function isFileWorkflow(workflow: string) {
  return workflow === "read_file" || workflow === "revise_file_reading";
}
export const FollowUpPlan = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      intervalMinutes: z.number().int().min(15).max(1440),
      maxChecks: z.number().int().min(1).max(96),
    })
    .strict(),
  z
    .object({
      operation: z.enum(["pause", "resume", "cancel"]),
      scheduleId: z.uuid(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export type FollowUpPlan = z.infer<typeof FollowUpPlan>;
export const FollowUpConfiguration = z
  .object({
    plan: FollowUpPlan,
    engine: EngineId.default("dsh"),
    modelProfileId: z.uuid().optional(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export const ArtifactReviewPlan = z
  .object({
    expectedVersion: z.number().int().positive(),
    expectedReviewRevision: z.number().int().min(0),
    decision: z.enum(["accept", "request_changes", "reopen"]),
    feedback: z.string().trim().min(1).max(4000),
    confirmed: z.literal(true),
  })
  .strict();
export type ArtifactReviewPlan = z.infer<typeof ArtifactReviewPlan>;
export const ArtifactReviewInput = ArtifactReviewPlan.extend({
  idempotencyKey: z.uuid(),
}).strict();
export type ArtifactReviewInput = z.infer<typeof ArtifactReviewInput>;
export const MethodDraft = z
  .object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(["sop", "template", "case", "rubric", "glossary"]),
    content: z.string().trim().min(1).max(12000),
  })
  .strict();
export type MethodDraft = z.infer<typeof MethodDraft>;
const methodTarget = {
  methodId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
};
export const MethodPlan = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("transfer"),
      ...methodTarget,
      maintainerId: z.uuid(),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("create"),
      sourceArtifactId: z.uuid(),
      expectedSourceVersion: z.number().int().positive(),
    })
    .strict(),
  z.object({ operation: z.literal("revise"), ...methodTarget }).strict(),
  z
    .object({
      operation: z.literal("verify"),
      ...methodTarget,
      evidence: z.string().trim().min(1).max(4000),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("publish"),
      ...methodTarget,
      scope: z.enum(["project", "workspace"]),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("withdraw"),
      ...methodTarget,
      reason: z.string().trim().min(1).max(4000),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type MethodPlan = z.infer<typeof MethodPlan>;
export const MethodActionInput = z
  .object({
    plan: MethodPlan,
    draft: MethodDraft.optional(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type MethodActionInput = z.infer<typeof MethodActionInput>;
export const MethodReference = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    revision: z.number().int().positive(),
  })
  .strict();
export type MethodReference = z.infer<typeof MethodReference>;
export interface MethodAsset {
  id: string;
  projectId: string;
  projectName: string;
  maintainerId: string;
  maintainerName: string;
  sourceArtifactId: string;
  sourceTitle: string;
  sourceVersion: number;
  version: number;
  revision: number;
  state: "candidate" | "published" | "withdrawn";
  verification: "candidate" | "employee_verified";
  evidence: string;
  scope: "project" | "workspace";
  title: string;
  kind: MethodDraft["kind"];
  content: string;
  canManage: boolean;
  canPublishWorkspace: boolean;
}
export function artifactStatusLabel(status: string) {
  return (
    (
      {
        draft: "草稿",
        changes_requested: "待修改",
        accepted: "已验收",
      } as Record<string, string>
    )[status] ?? "状态未知"
  );
}
export const RunInput = z
  .object({
    conversationId: z.uuid(),
    workflow: Workflow,
    engine: EngineId.default("dsh"),
    instruction: z.string().trim().min(1).max(20000),
    artifactId: z.uuid().optional(),
    modelProfileId: z.uuid().optional(),
    followUpPlan: FollowUpPlan.optional(),
    artifactReviewPlan: ArtifactReviewPlan.optional(),
    taskId: z.uuid().optional(),
    expectedTaskVersion: z.number().int().positive().optional(),
    methodPlan: MethodPlan.optional(),
    methodRefs: z.array(MethodReference).max(3).optional(),
    policyPlan: ExecutionPolicyPlan.optional(),
    notificationPlan: NotificationPlan.optional(),
    spendingPlan: ModelSpendingPlan.optional(),
    briefPlan: WorkBriefPlan.optional(),
    briefRef: BriefReference.optional(),
    taskAssignmentPlan: TaskAssignmentPlan.optional(),
    attachmentPlan: z.lazy(() => AttachmentSendPlan).optional(),
    decisionPlan: z.lazy(() => DecisionPlan).optional(),
    knowledgePlan: z.lazy(() => KnowledgePlan).optional(),
    organizationPlan: OrganizationPlan.optional(),
    taskRules: ExecutionRules.omit({ dailyRuns: true }).optional(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();
export type RunInput = z.infer<typeof RunInput>;
export const NewMessage = z
  .object({ content: z.string().trim().min(1).max(20000) })
  .strict();
export const TaskInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    assignee: z.string().max(100).default("待分配"),
    dueDate: z.string().date().nullable().default(null),
  })
  .strict();
export type TaskInput = z.infer<typeof TaskInput>;
export const TaskPatch = z
  .object({
    status: z.enum(["open", "done"]).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    assignee: z.string().trim().min(1).max(100).optional(),
    dueDate: z.string().date().nullable().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.entries(value).some(
        ([key, item]) => key !== "expectedVersion" && item !== undefined,
      ),
    "请指定需要修改的待办字段。",
  );
export type TaskPatch = z.infer<typeof TaskPatch>;
export const TaskRewrite = z
  .object({
    status: z.enum(["open", "done"]).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    assignee: z.string().trim().min(1).max(100).optional(),
    dueDate: z.string().date().nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    "没有提出待办修改字段。",
  );
export const ArtifactRevision = z
  .object({
    content: z.string().trim().min(1).max(100000),
    expectedVersion: z.number().int().positive(),
    feedback: z.string().trim().max(20000).default(""),
  })
  .strict();
export type ArtifactRevision = z.infer<typeof ArtifactRevision>;
export const ModelInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    provider: z.enum(["openai-compatible", "deepseek", "anthropic"]),
    endpoint: z.url(),
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().min(1).max(4096).optional(),
    purpose: z.enum(["chat", "embedding"]).default("chat"),
    scope: z.enum(["personal", "workspace"]).default("personal"),
    embeddingInputChars: z.number().int().min(200).max(4000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.purpose !== "embedding" &&
      value.embeddingInputChars !== undefined
    )
      ctx.addIssue({
        code: "custom",
        path: ["embeddingInputChars"],
        message: "向量输入长度仅适用于向量模型。",
      });
  });
export const DecisionInput = z
  .object({ requestId: z.uuid(), approved: z.boolean() })
  .strict();
export const TerminalStates = new Set<RunState>([
  "succeeded",
  "failed",
  "cancelled",
  "recovery_required",
]);
const transitions: Record<RunState, readonly RunState[]> = {
  queued: ["running", "cancelled", "failed"],
  running: [
    "waiting_input",
    "waiting_confirmation",
    "succeeded",
    "failed",
    "cancelled",
    "recovery_required",
  ],
  waiting_input: ["queued", "running", "cancelled", "failed"],
  waiting_confirmation: [
    "queued",
    "running",
    "cancelled",
    "failed",
    "recovery_required",
  ],
  succeeded: [],
  failed: [],
  cancelled: [],
  recovery_required: ["failed", "succeeded"],
};
export function assertTransition(from: RunState, to: RunState) {
  if (!transitions[from].includes(to))
    throw new Error("Invalid run transition: " + from + " -> " + to);
}
export interface Subject {
  id: string;
  name: string;
  workspaceId: string;
  role: "admin" | "member";
  demo: boolean;
  /** Server-owned source credential reference. Never accepted from client input. */
  identityCredentialId?: string;
}
export interface RunEvent {
  eventId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  schemaVersion: "1.0.0";
  kind: EventKind;
  data: Record<string, unknown>;
}
export interface PlannedAction {
  tool:
    | "work.plan"
    | "artifact.create"
    | "artifact.revise"
    | "artifact.review"
    | "task.create"
    | "task.update"
    | "method.write"
    | "method.manage"
    | "policy.configure"
    | "notifications.manage"
    | "usage.report"
    | "spending.manage"
    | "brief.write"
    | "brief.manage"
    | "task.assign"
    | "directory.read"
    | "organization.manage"
    | "communication.manage"
    | "calendar.manage"
    | "approval.manage"
    | "attachment.share"
    | "decision.write"
    | "decision.manage"
    | "knowledge.answer"
    | "project.report"
    | "follow_up.check"
    | "follow_up.configure"
    | "communication.draft"
    | "file.reading.save";
  args: Record<string, unknown>;
}
export interface EngineRequest {
  runId: string;
  subject: Subject;
  instruction: string;
  workflow: Workflow;
  context: string;
  policy: string;
  workdir: string;
  /** Backend-only connection. Never serialize credentials into product events. */
  model?: {
    id: string;
    provider: string;
    endpoint: string;
    model: string;
    apiKey?: string;
  };
  signal: AbortSignal;
  limits?: { maxOutputTokens: number; maxDurationSeconds: number };
  onProgress: (text: string) => Promise<void>;
}
export function toolsForWorkflow(
  workflow: Workflow,
): readonly PlannedAction["tool"][] {
  switch (workflow) {
    case "plan_work":
      return ["work.plan"];
    case "discussion_to_minutes":
      return ["artifact.create", "task.create"];
    case "project_report":
      return ["artifact.create", "project.report"];
    case "revise_artifact":
      return ["artifact.revise"];
    case "revise_task":
      return ["task.update"];
    case "manage_method":
      return ["method.write", "method.manage"];
    case "review_artifact":
      return ["artifact.review"];
    case "follow_up":
      return ["follow_up.check"];
    case "configure_follow_up":
      return ["follow_up.configure"];
    case "manage_notifications":
      return ["notifications.manage"];
    case "configure_policy":
      return ["policy.configure"];
    case "usage_report":
      return ["usage.report"];
    case "manage_spending":
      return ["spending.manage"];
    case "manage_brief":
      return ["brief.write", "brief.manage"];
    case "assign_task":
      return ["task.assign"];
    case "manage_communication":
      return ["communication.manage"];
    case "manage_approval":
      return ["approval.manage"];
    case "manage_calendar":
      return ["calendar.manage"];
    case "manage_organization":
      return ["organization.manage"];
    case "directory_report":
      return ["directory.read"];
    case "query_knowledge":
      return ["knowledge.answer"];
    case "manage_decision":
      return ["decision.write", "decision.manage"];
    case "share_attachment":
      return ["attachment.share"];
    case "chat":
      return [];
    case "draft_reply":
      return ["communication.draft"];
    case "read_file":
    case "revise_file_reading":
      return ["file.reading.save"];
  }
}
export interface EngineResult {
  text: string;
  actions: PlannedAction[];
  evidence: "fixture" | "runtime";
  usage?: { inputTokens: number; outputTokens: number };
}
export interface EngineCapabilities {
  configured: boolean;
  operations: string[];
  evidence: string;
  modelProviders?: string[];
}
export interface EngineAdapter {
  id: EngineId;
  describeCapabilities(): EngineCapabilities;
  execute(request: EngineRequest): Promise<EngineResult>;
}
export interface Message {
  id: string;
  author: string;
  role: string;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}
export interface Task {
  id: string;
  title: string;
  assignee: string;
  assigneeId?: string | null;
  status: "open" | "done";
  dueDate: string | null;
  version?: number;
}
export interface Artifact {
  id: string;
  title: string;
  version: number;
  content: string;
  status: string;
  reviewRevision?: number;
  acceptedVersion?: number | null;
  createdAt: string;
}
export interface Project {
  id: string;
  name: string;
  goal: string;
  conversationId: string;
  source?: { kind: "nextcloud-talk"; roomId: string; name: string };
}
export interface WorkspaceView {
  user: Subject;
  projects: Project[];
  project: Project;
  messages: Message[];
  tasks: Task[];
  artifacts: Artifact[];
  decisions?: {
    id: string;
    title: string;
    version: number;
    confirmedBy: string;
  }[];
  engines: Record<string, EngineCapabilities>;
}

export interface CommunicationRoom {
  id: string;
  name: string;
  readOnly: boolean;
  unreadMessages?: number | null;
  unreadMention?: boolean | null;
}
export interface CommunicationMessage {
  id: string;
  authorId: string;
  author: string;
  content: string;
  createdAt: string;
  kind: "comment" | "system" | "deleted" | "unsupported";
  referenceId: string;
  version: string;
  expiresAt: string | null;
  /** Live source references only; receiving a reference does not ingest its body. */
  attachments?: CommunicationAttachment[];
}

export const TalkFileId = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const AttachmentEtag = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const AttachmentSendPlan = z
  .object({
    roomId: z.string().regex(/^[a-z0-9]{4,30}$/),
    path: z.lazy(() => FilePath).refine((path) => path.length > 0),
    expectedFileId: TalkFileId,
    expectedEtag: AttachmentEtag,
    caption: z.string().trim().max(2000),
    confirmed: z.literal(true),
  })
  .strict();
export type AttachmentSendPlan = z.infer<typeof AttachmentSendPlan>;
export const AttachmentSendInput = z
  .object({ plan: AttachmentSendPlan, idempotencyKey: z.uuid() })
  .strict();
export interface AttachmentSendReceipt extends CommunicationReceipt {
  kind: "attachment";
  roomId: string;
  fileId: string;
  name: string;
  sourceShareId: string | null;
  sourceRunId: string | null;
  requestedPermissions: 1;
}
export interface CommunicationAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  etag: string;
  downloadable: boolean;
}

export const CommunicationSendInput = z
  .object({
    content: z.string().trim().min(1).max(20000),
    idempotencyKey: z.uuid(),
    draftId: z.uuid().optional(),
  })
  .strict();
export interface CommunicationReceipt {
  id: string;
  state: "sending" | "succeeded" | "failed" | "recovery_required";
  sourceMessageId: string | null;
  error: string | null;
  acknowledgedAt: string | null;
}
export interface ReplyDraftSummary {
  id: string;
  runId: string;
  createdAt: string;
  engine: string;
  sendState: CommunicationReceipt["state"] | null;
  sendId: string | null;
}
export interface ReplyDraft {
  id: string;
  runId: string;
  createdAt: string;
  roomId: string;
  roomName: string;
  content: string;
  sourceMessageIds: string[];
  sendState: CommunicationReceipt["state"] | null;
  sendId: string | null;
}

export const FilePath = z
  .array(
    z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          value !== "." &&
          value !== ".." &&
          !/[\\/\u0000-\u001f\u007f]/.test(value),
        "Invalid path segment",
      ),
  )
  .max(20);
export const AttachmentUploadInput = z
  .object({
    roomId: z.string().regex(/^[a-z0-9]{4,30}$/),
    name: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine(
        (name) =>
          FilePath.safeParse([name]).success &&
          new TextEncoder().encode(name).length <= 180,
        "Invalid upload name",
      ),
    size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    confirmed: z.literal(true),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type AttachmentUploadInput = z.infer<typeof AttachmentUploadInput>;
export interface AttachmentUploadReceipt {
  id: string;
  name: string;
  size: number;
  state:
    | "prepared"
    | "uploading"
    | "succeeded"
    | "failed"
    | "recovery_required";
  acknowledgedAt: string | null;
  error: string | null;
  file: SourceFile | null;
}

export interface SourceFile {
  path: string[];
  id: string;
  name: string;
  kind: "file" | "directory";
  etag: string;
  size: number;
  mime: string;
  importable: boolean;
}

export const FileReadingInput = z
  .object({
    engine: z.enum(["dsh", "hermes"]).default("dsh"),
    instruction: z.string().trim().min(1).max(4000),
    expectedSourceVersion: z.string().min(1).max(512),
    modelProfileId: z.uuid().optional(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type FileReadingInput = z.infer<typeof FileReadingInput>;
export const FileReadingRevisionInput = FileReadingInput.omit({
  expectedSourceVersion: true,
})
  .extend({ expectedVersion: z.number().int().positive() })
  .strict();
export type FileReadingRevisionInput = z.infer<typeof FileReadingRevisionInput>;
export const FileReadingRevision = z
  .object({
    content: z.string().trim().min(1).max(20000),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const DecisionDraft = z
  .object({
    title: z.string().trim().min(1).max(300),
    content: z.string().trim().min(1).max(8000),
    rationale: z.string().trim().max(2000).default(""),
    links: z
      .array(
        z
          .object({
            kind: z.enum(["task", "artifact"]),
            id: z.uuid(),
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export type DecisionDraft = z.infer<typeof DecisionDraft>;
const DecisionTarget = {
  decisionId: z.uuid(),
  expectedVersion: z.number().int().positive(),
};
export const DecisionPlan = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create") }).strict(),
  z.object({ operation: z.literal("revise"), ...DecisionTarget }).strict(),
  z
    .object({
      operation: z.literal("confirm"),
      ...DecisionTarget,
      confirmed: z.literal(true),
      supersedes: z
        .object({ id: z.uuid(), version: z.number().int().positive() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("withdraw"),
      ...DecisionTarget,
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type DecisionPlan = z.infer<typeof DecisionPlan>;
export const DecisionSourceRefs = z.array(z.string().min(1).max(1024)).max(120);
export const DecisionMutation = z
  .object({
    plan: DecisionPlan,
    draft: DecisionDraft.optional(),
    sourceRefs: DecisionSourceRefs.default([]),
    idempotencyKey: z.uuid(),
  })
  .strict()
  .refine(
    (input) =>
      ["create", "revise"].includes(input.plan.operation) === !!input.draft,
    "决定内容与操作不匹配。",
  );
export type DecisionMutation = z.infer<typeof DecisionMutation>;
export interface DecisionReceipt {
  tool: "decision.write" | "decision.manage";
  id: string;
  version: number;
  state: "proposed" | "confirmed" | "withdrawn" | "superseded";
  sourceRunId: string | null;
  superseded?: { id: string; version: number };
}

export const KnowledgePlan = z
  .object({
    query: z.string().trim().min(1).max(4000),
    assetRefs: z
      .array(
        z
          .object({ id: z.uuid(), sourceVersion: z.string().min(1).max(512) })
          .strict(),
      )
      .min(1)
      .max(10),
    mode: z.enum(["keyword", "semantic"]).default("keyword"),
    embeddingProfileId: z.uuid().optional(),
  })
  .strict()
  .refine(
    (plan) =>
      new Set(plan.assetRefs.map((ref) => ref.id)).size ===
      plan.assetRefs.length,
    "重复的资料引用。",
  );
export type KnowledgePlan = z.infer<typeof KnowledgePlan>;
