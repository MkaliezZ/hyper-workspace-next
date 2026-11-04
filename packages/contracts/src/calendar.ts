import { z } from "zod";

export const CalendarId = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (v) => !/[\u0000-\u001f\u007f/\\%?#]/u.test(v) && v !== "." && v !== "..",
  );
export const CalendarEtag = z
  .string()
  .max(512)
  .regex(/^"[^"\x00-\x20\x7f]*"$/u);
const date = z.iso.date();
const instant = z.iso.datetime({ precision: 0 });
export const CalendarInterval = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("timed"), start: instant, end: instant })
    .strict()
    .refine(
      (v) => Date.parse(v.end) > Date.parse(v.start),
      "结束时间须晚于开始时间。",
    ),
  z
    .object({ kind: z.literal("all_day"), start: date, end: date })
    .strict()
    .refine((v) => v.end > v.start, "全天事件结束日期为不含当天的边界。"),
]);
export type CalendarInterval = z.infer<typeof CalendarInterval>;
export const CalendarDraft = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(10000).default(""),
    location: z.string().max(1000).default(""),
    interval: CalendarInterval,
  })
  .strict();
export type CalendarDraft = z.infer<typeof CalendarDraft>;
export const CalendarPatch = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(10000).optional(),
    location: z.string().max(1000).optional(),
    interval: CalendarInterval.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "请填写要修改的内容。");
const base = { calendarId: CalendarId, idempotencyKey: z.uuid() };
export const CalendarCommandInput = z.discriminatedUnion("operation", [
  z
    .object({ ...base, operation: z.literal("create"), draft: CalendarDraft })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal("update"),
      objectId: CalendarId,
      etag: CalendarEtag,
      scope: z.literal("series"),
      patch: CalendarPatch,
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal("delete"),
      objectId: CalendarId,
      etag: CalendarEtag,
      scope: z.literal("series"),
    })
    .strict(),
]);
export type CalendarCommandInput = z.infer<typeof CalendarCommandInput>;
export const CalendarQuery = z
  .object({ calendarId: CalendarId, start: instant, end: instant })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.end) > Date.parse(v.start) &&
      Date.parse(v.end) - Date.parse(v.start) <= 93 * 86400000,
    "查询范围须大于零且不超过93天。",
  );

export interface CalendarSummary {
  id: string;
  name: string;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}
export type CalendarPoint =
  | { kind: "date"; value: string }
  | { kind: "instant"; value: string; timeZone: string }
  | { kind: "floating"; value: string }
  | { kind: "unresolved_timezone"; value: string; timeZone: string };
export interface CalendarOccurrence {
  calendarId: string;
  objectId: string;
  etag: string;
  uid: string;
  recurrenceId: string | null;
  title: string;
  description: string;
  location: string;
  start: CalendarPoint;
  end: CalendarPoint;
  status: "tentative" | "confirmed" | "cancelled" | "unspecified";
  transparency: "opaque" | "transparent";
  truncatedFields: string[];
}
export interface CalendarCommandReceipt {
  sourceRunId?: string | null;
  plan: CalendarCommandInput;
  id: string;
  operation: "create" | "update" | "delete";
  calendarId: string;
  objectId: string;
  state:
    | "prepared"
    | "applying"
    | "succeeded"
    | "failed"
    | "recovery_required"
    | "cancelled";
  title: string;
  error: string | null;
  stopRequested: boolean;
  sourceEtag: string | null;
  observedResult: "matched" | "absent" | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export const CalendarRunPlan = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read"), query: CalendarQuery }).strict(),
  z
    .object({
      operation: z.literal("apply"),
      commandId: z.uuid(),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type CalendarRunPlan = z.infer<typeof CalendarRunPlan>;
export const CalendarRunInput = z
  .object({
    plan: CalendarRunPlan,
    engine: z.enum(["dsh", "hermes"]).default("dsh"),
    modelProfileId: z.uuid().optional(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type CalendarRunInput = z.infer<typeof CalendarRunInput>;
export interface CalendarRunSummary {
  id: string;
  state: string;
  engine: "dsh" | "hermes";
  operation: "read" | "apply";
  calendarId: string;
  createdAt: string;
}
