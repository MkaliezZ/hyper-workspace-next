import { Temporal } from "@js-temporal/polyfill";
import type {
  CalendarOccurrence,
  CalendarPoint,
  CalendarEventRef,
} from "@hyper/contracts/calendar";

export interface AvailabilityWindow {
  start: string;
  end: string;
  timeZone: string;
  durationMinutes: number;
  stepMinutes: number;
  weekdays: number[];
  dailyStart: string;
  dailyEnd: string;
}
type Ref = Pick<
  CalendarOccurrence,
  "calendarId" | "objectId" | "recurrenceId" | "etag"
>;
type Interval = { start: number; end: number; event: Ref; tentative: boolean };
const iso = (ms: number) =>
  Temporal.Instant.fromEpochMilliseconds(ms).toString();
const ref = (e: CalendarOccurrence): Ref => ({
  calendarId: e.calendarId,
  objectId: e.objectId,
  recurrenceId: e.recurrenceId,
  etag: e.etag,
});

/** All-day intervals use the explicitly selected viewing zone. Floating or unresolved
 * source times must be resolved before offering slots, never guessed as free time. */
function point(p: CalendarPoint, timeZone: string) {
  if (p.kind === "instant")
    return Temporal.Instant.from(p.value).epochMilliseconds;
  if (p.kind !== "date") return null;
  const date = Temporal.PlainDate.from(p.value),
    midnight = date.toZonedDateTime(timeZone);
  if (!midnight.toPlainDate().equals(date)) return null; // Entire civil date skipped by a zone change.
  return midnight.epochMilliseconds;
}
function minute(value: string) {
  const t = Temporal.PlainTime.from(value);
  return t.hour * 60 + t.minute;
}

/** Bounded deterministic calculation. Network authority and current version/ACL checks
 * belong to CalendarService; this function never writes or claims a reservation. */
export function calendarAvailability(
  events: CalendarOccurrence[],
  input: AvailabilityWindow,
  unresolved: { event: CalendarEventRef; reason: string }[] = [],
) {
  const start = Temporal.Instant.from(input.start).epochMilliseconds,
    end = Temporal.Instant.from(input.end).epochMilliseconds;
  if (!(end > start) || end - start > 31 * 86400000 || events.length > 2000)
    throw new Error("Availability window or event count exceeds its bound");
  const dayStart = minute(input.dailyStart),
    rawDayEnd = minute(input.dailyEnd),
    overnight = rawDayEnd <= dayStart,
    dayEnd = rawDayEnd + (overnight ? 1440 : 0);
  if (
    !Number.isInteger(input.durationMinutes) ||
    !Number.isInteger(input.stepMinutes) ||
    input.durationMinutes < 5 ||
    input.durationMinutes > 480 ||
    input.stepMinutes < 5 ||
    input.stepMinutes > 120 ||
    !input.weekdays.length ||
    input.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
  )
    throw new Error("Invalid availability constraints");
  const zoneStart = Temporal.Instant.fromEpochMilliseconds(
    start,
  ).toZonedDateTimeISO(input.timeZone);
  const zoneEnd = Temporal.Instant.fromEpochMilliseconds(
    end - 1,
  ).toZonedDateTimeISO(input.timeZone);
  const unknown: { event: Ref; reason: string }[] = [...unresolved],
    intervals: Interval[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const key = JSON.stringify([e.calendarId, e.objectId, e.recurrenceId]);
    if (seen.has(key)) throw new Error("Duplicate calendar occurrence");
    seen.add(key);
    if (e.status === "cancelled" || e.transparency === "transparent") continue;
    const a = point(e.start, input.timeZone),
      b = point(e.end, input.timeZone);
    if (a === null || b === null) {
      unknown.push({ event: ref(e), reason: "source_time_unresolved" });
      continue;
    }
    if (b < a) throw new Error("Invalid source interval");
    if (b === a || a >= end || b <= start) continue;
    intervals.push({
      start: Math.max(a, start),
      end: Math.min(b, end),
      event: ref(e),
      tentative: e.status === "tentative",
    });
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const conflicts: { left: Ref; right: Ref; start: string; end: string }[] = [];
  let conflictsTruncated = false;
  for (let i = 0; i < intervals.length; i++)
    for (
      let j = i + 1;
      j < intervals.length && intervals[j]!.start < intervals[i]!.end;
      j++
    ) {
      if (conflicts.length === 100) {
        conflictsTruncated = true;
        break;
      }
      const a = intervals[i]!,
        b = intervals[j]!;
      conflicts.push({
        left: a.event,
        right: b.event,
        start: iso(Math.max(a.start, b.start)),
        end: iso(Math.min(a.end, b.end)),
      });
    }
  const merged: { start: number; end: number }[] = [];
  for (const span of intervals) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  const candidates: { start: string; end: string }[] = [],
    skippedWindows: { date: string; reason: string }[] = [];
  if (!unknown.length) {
    let date = overnight
      ? zoneStart.toPlainDate().subtract({ days: 1 })
      : zoneStart.toPlainDate();
    const last = zoneEnd.toPlainDate();
    while (
      Temporal.PlainDate.compare(date, last) <= 0 &&
      candidates.length < 20
    ) {
      if (input.weekdays.includes(date.dayOfWeek)) {
        try {
          const a = date
            .toPlainDateTime(input.dailyStart)
            .toZonedDateTime(input.timeZone, { disambiguation: "reject" });
          const b = (overnight ? date.add({ days: 1 }) : date)
            .toPlainDateTime(input.dailyEnd)
            .toZonedDateTime(input.timeZone, { disambiguation: "reject" });
          for (
            let wall = dayStart;
            wall + input.durationMinutes <= dayEnd && candidates.length < 20;
            wall += input.stepMinutes
          ) {
            // Grid is in local wall time, duration in elapsed minutes across DST transitions.
            const local = date.toPlainDateTime("00:00").add({ minutes: wall });
            let t: number;
            try {
              t = local.toZonedDateTime(input.timeZone, {
                disambiguation: "reject",
              }).epochMilliseconds;
            } catch {
              continue;
            }
            const finish = t + input.durationMinutes * 60000;
            if (
              t < start ||
              finish > end ||
              t < a.epochMilliseconds ||
              finish > b.epochMilliseconds
            )
              continue;
            if (merged.some((span) => span.start < finish && span.end > t))
              continue;
            candidates.push({ start: iso(t), end: iso(finish) });
          }
        } catch {
          skippedWindows.push({
            date: date.toString(),
            reason: "working_window_timezone_ambiguous_or_missing",
          });
        }
      }
      date = date.add({ days: 1 });
    }
  }
  return {
    state: unknown.length ? ("blocked" as const) : ("evaluated" as const),
    timeZone: input.timeZone,
    window: { start: input.start, end: input.end },
    busy: intervals.map((i) => ({
      ...i,
      start: iso(i.start),
      end: iso(i.end),
    })),
    conflicts,
    conflictsTruncated,
    unknown,
    candidates,
    candidateLimit: 20,
    skippedWindows,
    reservation: false as const,
  };
}
