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

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
export const CalendarAvailabilityQuery = z
  .object({
    calendarIds: z
      .array(CalendarId)
      .min(1)
      .max(10)
      .refine((v) => new Set(v).size === v.length),
    start: instant,
    end: instant,
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }),
    durationMinutes: z.number().int().min(5).max(480).default(60),
    stepMinutes: z.number().int().min(5).max(120).default(30),
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((v) => new Set(v).size === v.length)
      .default([1, 2, 3, 4, 5]),
    dailyStart: clock.default("09:00"),
    dailyEnd: clock.default("18:00"),
  })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.end) > Date.parse(v.start) &&
      Date.parse(v.end) - Date.parse(v.start) <= 31 * 86400000,
    "排期窗口须大于0且不超过31天。",
  );
export type CalendarAvailabilityQuery = z.infer<
  typeof CalendarAvailabilityQuery
>;
export interface CalendarEventRef {
  calendarId: string;
  objectId: string;
  recurrenceId: string | null;
  etag: string;
}
export interface CalendarAvailabilityResult {
  state: "evaluated" | "blocked";
  timeZone: string;
  window: { start: string; end: string };
  checkedAt: string;
  busy: {
    start: string;
    end: string;
    event: CalendarEventRef;
    tentative: boolean;
  }[];
  conflicts: {
    left: CalendarEventRef;
    right: CalendarEventRef;
    start: string;
    end: string;
  }[];
  conflictsTruncated: boolean;
  unknown: { event: CalendarEventRef; reason: string }[];
  candidates: { start: string; end: string }[];
  candidateLimit: number;
  skippedWindows: { date: string; reason: string }[];
  reservation: false;
  observations: {
    calendarId: string;
    timeZoneId: string | null;
    objects: { objectId: string; etag: string }[];
  }[];
}
export const CalendarRunPlan = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read"), query: CalendarQuery }).strict(),
  z
    .object({
      operation: z.literal("availability"),
      query: CalendarAvailabilityQuery,
    })
    .strict(),
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
  operation: "read" | "apply" | "availability";
  calendarId: string;
  createdAt: string;
}
