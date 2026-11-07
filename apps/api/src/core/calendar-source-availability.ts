import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  CalendarAvailabilityQuery,
  CalendarAvailabilityResult,
  CalendarEventRef,
  CalendarOccurrence,
} from "@hyper/contracts/calendar";
import type {
  CalendarProvider,
  CalendarObject,
  SourceCalendar,
} from "../providers/calendar.js";
import { stableDigest } from "./credentials.js";
import { calendarAvailability } from "./calendar-availability.js";
import { calendarOccurrences } from "./calendar-projection.js";
import { calendarTimeBasis } from "./calendar-time-basis.js";

const snapshot = (objects: CalendarObject[]) =>
  stableDigest(
    [...objects]
      .sort((a, b) => a.objectId.localeCompare(b.objectId))
      .map((o) => ({
        objectId: o.objectId,
        etag: o.etag,
        uid: o.uid,
        ical: o.ical,
      })),
  );
/** A point-in-time availability observation, never a source reservation. The caller
 * supplies a current authority recheck; no executor or model supplies credentials. */
export async function readCalendarAvailability(
  provider: CalendarProvider,
  input: CalendarAvailabilityQuery,
  recheck: () => Promise<SourceCalendar[]>,
  signal?: AbortSignal,
): Promise<CalendarAvailabilityResult> {
  signal?.throwIfAborted();
  const calendars = await provider.calendars();
  const selected = input.calendarIds.map((id) => {
    const c = calendars.find((c) => c.id === id && c.canRead);
    if (!c) throw new NotFoundException("所选日历不存在或无权访问。");
    return c;
  });
  // Source defaults can shift a floating/date event across a UTC boundary. Inspect
  // a wider raw window too, so uncertainty near the requested boundary is not omitted.
  const utc = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  const wider = {
    start: utc(Date.parse(input.start) - 2 * 86400000),
    end: utc(Date.parse(input.end) + 2 * 86400000),
  };
  const bundles: { calendar: SourceCalendar; raw: CalendarObject[] }[] = [],
    events: CalendarOccurrence[] = [];
  const unknown: { event: CalendarEventRef; reason: string }[] = [];
  let count = 0;
  for (const calendar of selected) {
    signal?.throwIfAborted();
    const raw = await provider.query(calendar.id, wider);
    count += raw.length;
    if (count > 2000)
      throw new ServiceUnavailableException(
        "排期来源过多，请缩小日历或时间范围。",
      );
    const original = new Map(raw.map((o) => [o.objectId, o]));
    const expanded = await provider.occurrences(calendar.id, input);
    for (const object of expanded) {
      const origin = original.get(object.objectId);
      if (!origin || origin.etag !== object.etag || origin.uid !== object.uid)
        throw new ConflictException("日程在排期读取期间变化，请重新核对。");
    }
    try {
      for (const o of raw) {
        const basis = calendarTimeBasis(o.ical, !!calendar.timeZone?.id);
        if (basis.startsWith("unresolved_"))
          unknown.push({
            event: {
              calendarId: o.calendarId,
              objectId: o.objectId,
              recurrenceId: null,
              etag: o.etag,
            },
            reason: basis,
          });
      }
      events.push(...calendarOccurrences(expanded));
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        "日程原始时间不完整，未生成部分排期建议。",
      );
    }
    bundles.push({ calendar, raw });
  }
  signal?.throwIfAborted();
  for (const bundle of bundles) {
    signal?.throwIfAborted();
    if (
      snapshot(bundle.raw) !==
      snapshot(await provider.query(bundle.calendar.id, wider))
    )
      throw new ConflictException("日程在排期读取期间变化，请重新核对。");
  }
  const current = await recheck();
  for (const old of selected) {
    const live = current.find((c) => c.id === old.id && c.canRead);
    if (!live) throw new NotFoundException("日历访问在读取期间已撤销。");
    if ((live.timeZone?.revision ?? null) !== (old.timeZone?.revision ?? null))
      throw new ConflictException("来源日历时区已变化，请重新核对排期。");
  }
  signal?.throwIfAborted();
  let result;
  try {
    result = calendarAvailability(events, input, unknown);
  } catch {
    throw new ServiceUnavailableException(
      "日程或时区不能可靠计算，未返回部分排期建议。",
    );
  }
  return {
    ...result,
    checkedAt: new Date().toISOString(),
    observations: bundles.map((b) => ({
      calendarId: b.calendar.id,
      timeZoneId: b.calendar.timeZone?.id ?? null,
      objects: b.raw.map((o) => ({ objectId: o.objectId, etag: o.etag })),
    })),
  };
}
