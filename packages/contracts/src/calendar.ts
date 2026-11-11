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
const wallTime = z.iso
  .datetime({ local: true, precision: 0 })
  .refine((v) => !v.endsWith("Z"));
const calendarTimeZone = z
  .string()
  .max(100)
  .regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/u)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, "请填写有效的 IANA 时区。");
export const CalendarInterval = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("timed"), start: instant, end: instant })
    .strict()
    .refine(
      (v) => Date.parse(v.end) > Date.parse(v.start),
      "结束时间须晚于开始时间。",
    ),
  z
    .object({
      kind: z.literal("zoned"),
      start: wallTime,
      end: wallTime,
      timeZone: calendarTimeZone,
    })
    .strict()
    .refine((v) => v.end > v.start, "结束时间须晚于开始时间。"),
  z
    .object({ kind: z.literal("all_day"), start: date, end: date })
    .strict()
    .refine((v) => v.end > v.start, "全天事件结束日期为不含当天的边界。"),
]);
export type CalendarInterval = z.infer<typeof CalendarInterval>;
export const CalendarRepeat = z
  .object({
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    interval: z.number().int().min(1).max(12),
    count: z.number().int().min(2).max(104),
  })
  .strict();
export type CalendarRepeat = z.infer<typeof CalendarRepeat>;
export const CalendarDraft = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(10000).default(""),
    location: z.string().max(1000).default(""),
    interval: CalendarInterval,
    repeat: CalendarRepeat.optional(),
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
const calendarWindow = { start: instant, end: instant };
function boundedCalendarWindow(v: { start: string; end: string }) {
  const duration = Date.parse(v.end) - Date.parse(v.start);
  return duration > 0 && duration <= 93 * 86400000;
}
export const CalendarQuery = z
  .object({ calendarId: CalendarId, ...calendarWindow })
  .strict()
  .refine(boundedCalendarWindow, "查询范围须大于零且不超过93天。");
const occurrenceTarget = z
  .object({
    recurrenceId: z.union([
      date,
      instant,
      z.iso.datetime({ local: true, precision: 0 }),
    ]),
    window: z.object(calendarWindow).strict().refine(boundedCalendarWindow),
  })
  .strict();
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
const seriesTarget = { objectId: CalendarId, etag: CalendarEtag };
const base = { calendarId: CalendarId, idempotencyKey: z.uuid() };
const invitees = z
  .array(CalendarId)
  .min(1)
  .max(12)
  .refine((uids) => new Set(uids).size === uids.length, "邀请员工不能重复。");
export const CalendarCommandInput = z.discriminatedUnion("operation", [
  z
    .object({
      ...base,
      operation: z.literal("create"),
      draft: CalendarDraft,
      invitees: invitees.optional(),
      booking: CalendarAvailabilityQuery.optional(),
    })
    .strict()
    .refine(({ booking, draft, calendarId }) => {
      if (!booking) return true;
      const slot = draft.interval;
      return (
        !draft.repeat &&
        slot.kind === "timed" &&
        booking.calendarIds.includes(calendarId) &&
        slot.start >= booking.start &&
        slot.end <= booking.end &&
        Date.parse(slot.end) - Date.parse(slot.start) ===
          booking.durationMinutes * 60000
      );
    }, "候选预约仅支持选定的单次时段，且须纳入写入日历。"),
  z.discriminatedUnion("scope", [
    z
      .object({
        ...base,
        ...seriesTarget,
        operation: z.literal("update"),
        scope: z.literal("series"),
        patch: CalendarPatch,
      })
      .strict(),
    z
      .object({
        ...base,
        ...seriesTarget,
        operation: z.literal("update"),
        scope: z.literal("occurrence"),
        target: occurrenceTarget,
        change: z.discriminatedUnion("operation", [
          z
            .object({ operation: z.literal("edit"), patch: CalendarPatch })
            .strict(),
          z.object({ operation: z.literal("cancel") }).strict(),
        ]),
      })
      .strict(),
    z
      .object({
        ...base,
        ...seriesTarget,
        operation: z.literal("update"),
        scope: z.literal("series_rule"),
        repeat: CalendarRepeat.nullable(),
      })
      .strict(),
    z
      .object({
        ...base,
        ...seriesTarget,
        operation: z.literal("update"),
        scope: z.literal("meeting"),
        change: z.discriminatedUnion("operation", [
          z
            .object({
              operation: z.literal("reply"),
              response: z.enum(["ACCEPTED", "TENTATIVE", "DECLINED"]),
              // Absent on historical commands; those replies apply to the series.
              target: z
                .discriminatedUnion("scope", [
                  z.object({ scope: z.literal("series") }).strict(),
                  occurrenceTarget
                    .extend({ scope: z.literal("occurrence") })
                    .strict(),
                ])
                .optional(),
            })
            .strict(),
          z
            .object({
              operation: z.literal("reschedule_series"),
              interval: CalendarInterval,
              exceptions: z.literal("preserve_overrides"),
            })
            .strict(),
          z
            .object({ operation: z.literal("edit"), patch: CalendarPatch })
            .strict(),
          z.object({ operation: z.literal("cancel") }).strict(),
        ]),
      })
      .strict(),
  ]),
  z
    .object({
      ...base,
      operation: z.literal("delete"),
      ...seriesTarget,
      scope: z.literal("series"),
    })
    .strict(),
]);
export type CalendarCommandInput = z.infer<typeof CalendarCommandInput>;

export const CalendarObjectQuery = z
  .object({
    calendarId: CalendarId,
    objectId: CalendarId,
    etag: CalendarEtag,
  })
  .strict();
export const CalendarMeetingQuery = CalendarObjectQuery.extend({
  target: occurrenceTarget.optional(),
}).strict();
export interface CalendarSeriesRule {
  rules: string[];
  simple: CalendarRepeat | null;
  exceptionCount: number;
}
export interface CalendarMeeting {
  role: "organizer" | "attendee";
  cancelled: boolean;
  canUpdate?: boolean;
  title: string;
  ownResponse?: CalendarInvitationStatus["response"];
  invitations?: CalendarInvitationStatus[];
  responses?: {
    recurrenceId: string | null;
    response: CalendarInvitationStatus["response"];
  }[];
  selectedResponse?: CalendarInvitationStatus["response"];
  selectedRecurrenceId?: string;
  series?: {
    interval: CalendarInterval;
    repeat: CalendarRepeat;
    exceptionCount: number;
    canReschedule: boolean;
  };
}
export interface CalendarSummary {
  id: string;
  name: string;
  canRead: boolean;
  canCreate: boolean;
  canInvite?: boolean;
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
  meeting?: true;
  truncatedFields: string[];
}
export interface CalendarInvitationStatus {
  employeeUid: string;
  delivery: "delivered" | "pending" | "rejected" | "unreported";
  response:
    | "needs_action"
    | "accepted"
    | "tentative"
    | "declined"
    | "unreported";
  instances?: {
    recurrenceId: string;
    response: CalendarInvitationStatus["response"];
  }[];
}
export interface CalendarCommandReceipt {
  sourceRunId?: string | null;
  bookingCheckedAt?: string;
  invitations?: CalendarInvitationStatus[];
  meeting?: CalendarMeeting;
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
export const CalendarLinkTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("task"),
      projectId: z.uuid(),
      taskId: z.uuid(),
      taskVersion: z.number().int().positive(),
    })
    .strict(),
]);
export type CalendarLinkTarget = z.infer<typeof CalendarLinkTarget>;
export const CalendarLinkChange = z
  .object({
    event: CalendarObjectQuery,
    target: CalendarLinkTarget,
    linked: z.boolean(),
    idempotencyKey: z.uuid(),
    confirmed: z.literal(true),
  })
  .strict();
export type CalendarLinkChange = z.infer<typeof CalendarLinkChange>;
export interface CalendarLink {
  target: CalendarLinkTarget;
  label: string;
}
export interface CalendarLinkReceipt {
  id: string;
  linked: boolean;
  target: CalendarLinkTarget;
  sourceEtag: string;
  recordedAt: string;
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
  z
    .object({ operation: z.literal("link"), change: CalendarLinkChange })
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
  operation: "read" | "apply" | "availability" | "link";
  calendarId: string;
  createdAt: string;
}
