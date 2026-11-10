import { z } from "zod";

const id = z.uuid().transform((value) => value.toLowerCase());
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const label = z.string().trim().min(1).max(100);
const revision = z.number().int().min(1).max(2147483647);
const value = z.union([
  z.string().max(4000),
  z.number().int().safe(),
  z.boolean(),
]);
export const ApprovalForm = z.record(key, value);
export type ApprovalForm = z.infer<typeof ApprovalForm>;
const formField = z.discriminatedUnion("kind", [
  z
    .object({ key, label, required: z.boolean(), kind: z.literal("text") })
    .strict(),
  z
    .object({ key, label, required: z.boolean(), kind: z.literal("integer") })
    .strict(),
  z
    .object({ key, label, required: z.boolean(), kind: z.literal("boolean") })
    .strict(),
  z
    .object({
      key,
      label,
      required: z.boolean(),
      kind: z.literal("choice"),
      options: z.array(label).min(2).max(20),
    })
    .strict(),
]);
const condition = z
  .object({
    field: key,
    operator: z.enum(["eq", "neq", "lt", "gte"]),
    value,
  })
  .strict();
const step = z
  .object({
    key,
    label,
    when: z.array(condition).max(8).default([]),
    reviewers: z.array(id).min(1).max(12),
    requiredApprovals: z.number().int().min(1).max(12),
  })
  .strict();
const stage = z.object({ label, steps: z.array(step).min(1).max(6) }).strict();

export const ApprovalDefinition = z
  .object({
    title: label,
    fields: z.array(formField).min(1).max(24),
    stages: z.array(stage).min(1).max(8),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    const fields = new Map(definition.fields.map((item) => [item.key, item]));
    if (fields.size !== definition.fields.length)
      issue("表单字段标识不能重复。");
    for (const item of fields.values())
      if (
        item.kind === "choice" &&
        new Set(item.options).size !== item.options.length
      )
        issue("选项不能重复。");
    const stepKeys = new Set<string>();
    for (const stage of definition.stages)
      for (const step of stage.steps) {
        if (stepKeys.has(step.key)) issue("审批步骤标识不能重复。");
        stepKeys.add(step.key);
        if (
          new Set(step.reviewers).size !== step.reviewers.length ||
          step.requiredApprovals > step.reviewers.length
        )
          issue("审批人须唯一，且同意人数不得超过审批人数。");
        for (const test of step.when) {
          const target = fields.get(test.field);
          if (
            !target ||
            !target.required ||
            !approvalFieldAccepts(target, test.value) ||
            (["lt", "gte"].includes(test.operator) && target.kind !== "integer")
          )
            issue("分支条件须引用匹配类型的必填字段，范围比较仅用于整数。");
        }
      }
  });
export type ApprovalDefinition = z.infer<typeof ApprovalDefinition>;

export function approvalFieldAccepts(
  field: z.infer<typeof formField>,
  value: unknown,
) {
  switch (field.kind) {
    case "integer":
      return Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "choice":
      return typeof value === "string" && field.options.includes(value);
    case "text":
      return (
        typeof value === "string" &&
        value.trim().length > 0 &&
        value.length <= 4000
      );
  }
}

export const ApprovalPublish = z
  .object({
    idempotencyKey: id,
    previous: z.object({ id, version: revision }).strict().optional(),
    definition: ApprovalDefinition,
  })
  .strict();
export const ApprovalOpen = z
  .object({
    idempotencyKey: id,
    flowId: id,
    version: revision,
  })
  .strict();
export const ApprovalAction = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("submit"),
      idempotencyKey: id,
      expectedRevision: revision,
      form: ApprovalForm,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("review"),
      idempotencyKey: id,
      attempt: revision,
      step: key,
      assignmentVersion: revision,
      decision: z.enum(["approve", "reject", "return"]),
      comment: z.string().trim().max(2000).default(""),
      confirmed: z.literal(true),
    })
    .strict()
    .refine(
      (input) => input.decision === "approve" || input.comment.length > 0,
      "拒绝或退回须说明原因。",
    ),
  z
    .object({
      operation: z.literal("transfer"),
      idempotencyKey: id,
      attempt: revision,
      step: key,
      assignmentVersion: revision,
      recipientId: id,
      comment: z.string().trim().min(1).max(2000),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("remind"),
      idempotencyKey: id,
      attempt: revision,
      step: key,
      assignmentVersion: revision,
      recipientId: id,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal("withdraw"),
      idempotencyKey: id,
      expectedRevision: revision,
      comment: z.string().trim().min(1).max(2000),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type ApprovalAction = z.infer<typeof ApprovalAction>;
export type ApprovalState =
  | "draft"
  | "active"
  | "returned"
  | "approved"
  | "rejected"
  | "withdrawn";
export interface ApprovalAssignment {
  reviewerId: string;
  version: number;
  decision: "approve" | "reject" | "return" | null;
}
export interface ApprovalStep {
  key: string;
  label: string;
  requiredApprovals: number;
  assignments: ApprovalAssignment[];
}
export interface ApprovalStage {
  label: string;
  steps: ApprovalStep[];
}
export interface ApprovalSummary {
  id: string;
  flowId: string;
  flowVersion: number;
  applicantId: string;
  state: ApprovalState;
  revision: number;
  attempt: number;
  stage: number;
}
export interface ApprovalFlow {
  id: string;
  version: number;
  definition: ApprovalDefinition;
}
export interface ApprovalDetail extends ApprovalSummary {
  definition: ApprovalDefinition;
  form: ApprovalForm;
  people: Record<string, string>;
  stages: {
    label: string;
    steps: (ApprovalStep & { state: "approved" | "rejected" | "active" })[];
  }[];
  audit: {
    id: string;
    actorId: string;
    action: string;
    audit: {
      attempt?: number;
      step?: string;
      comment?: string;
      decision?: string;
    };
    recordedAt: string;
  }[];
}
