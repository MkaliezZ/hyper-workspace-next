import { test } from "node:test";
import assert from "node:assert/strict";
import type { CalendarOccurrence } from "@hyper/contracts/calendar";
import { calendarAvailability } from "../apps/api/src/core/calendar-availability.js";
const input = {
  start: "2026-11-04T00:00:00Z",
  end: "2026-11-05T00:00:00Z",
  timeZone: "Asia/Shanghai",
  durationMinutes: 60,
  stepMinutes: 30,
  weekdays: [1, 2, 3, 4, 5],
  dailyStart: "09:00",
  dailyEnd: "18:00",
};
function event(id: string, start: string, end: string): CalendarOccurrence {
  return {
    calendarId: "personal",
    objectId: id + ".ics",
    uid: id,
    etag: '"v1"',
    recurrenceId: null,
    title: "Private event",
    description: "",
    location: "",
    status: "confirmed",
    transparency: "opaque",
    truncatedFields: [],
    start: { kind: "instant", value: start, timeZone: "UTC" },
    end: { kind: "instant", value: end, timeZone: "UTC" },
  };
}
test("Availability uses half-open intervals, unions busy spans and returns verifiable source references", () => {
  const a = event("a", "2026-11-04T01:00:00Z", "2026-11-04T02:00:00Z"),
    b = event("b", "2026-11-04T01:30:00Z", "2026-11-04T03:00:00Z");
  const r = calendarAvailability([a, b], input);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.candidates[0]!.start, "2026-11-04T03:00:00Z");
  assert.deepEqual(r.conflicts[0]!.left, {
    calendarId: "personal",
    objectId: "a.ics",
    etag: '"v1"',
    recurrenceId: null,
  });
  assert.equal(r.reservation, false);
});
test("Tentative events block, transparent/cancelled and zero-duration events do not", () => {
  const e = event("tentative", "2026-11-04T01:00:00Z", "2026-11-04T02:00:00Z");
  e.status = "tentative";
  const transparent = {
    ...event("transparent", "2026-11-04T02:00:00Z", "2026-11-04T03:00:00Z"),
    transparency: "transparent" as const,
  };
  const cancelled = {
    ...event("cancelled", "2026-11-04T02:00:00Z", "2026-11-04T03:00:00Z"),
    status: "cancelled" as const,
  };
  assert.equal(
    calendarAvailability(
      [
        e,
        transparent,
        cancelled,
        event("zero", "2026-11-04T02:00:00Z", "2026-11-04T02:00:00Z"),
      ],
      input,
    ).candidates[0]!.start,
    "2026-11-04T02:00:00Z",
  );
});
test("All-day events use the selected zone and exclusive end, including a 25-hour DST day", () => {
  const e = event("day", "2026-11-04T01:00:00Z", "2026-11-04T02:00:00Z");
  e.start = { kind: "date", value: "2026-11-01" };
  e.end = { kind: "date", value: "2026-11-02" };
  const r = calendarAvailability([e], {
    ...input,
    timeZone: "America/New_York",
    start: "2026-11-01T00:00:00Z",
    end: "2026-11-03T00:00:00Z",
    weekdays: [1, 2, 3, 4, 5, 6, 7],
  });
  assert.equal(r.busy[0]!.start, "2026-11-01T04:00:00Z");
  assert.equal(r.busy[0]!.end, "2026-11-02T05:00:00Z");
});
test("Unresolved source time blocks suggestions instead of implying availability", () => {
  const e = event("floating", "2026-11-04T01:00:00Z", "2026-11-04T02:00:00Z");
  e.start = { kind: "floating", value: "2026-11-04T09:00:00" };
  const r = calendarAvailability([e], input);
  assert.equal(r.state, "blocked");
  assert.deepEqual(r.candidates, []);
  assert.equal(r.unknown.length, 1);
});
test("Local working-window DST gaps/folds are explicit, never silently shifted", () => {
  const r = calendarAvailability([], {
    ...input,
    timeZone: "America/New_York",
    start: "2026-03-08T00:00:00Z",
    end: "2026-03-09T00:00:00Z",
    weekdays: [7],
    dailyStart: "02:30",
    dailyEnd: "04:00",
  });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.skippedWindows.length, 1);
  const fold = calendarAvailability([], {
    ...input,
    timeZone: "America/New_York",
    start: "2026-11-01T00:00:00Z",
    end: "2026-11-02T00:00:00Z",
    weekdays: [7],
    dailyStart: "01:30",
    dailyEnd: "03:00",
  });
  assert.equal(fold.candidates.length, 0);
  assert.equal(fold.skippedWindows.length, 1);
});
test("Duplicate instances, oversized ranges and invalid zones never yield partial trusted-looking slots", () => {
  const e = event("a", "2026-11-04T01:00:00Z", "2026-11-04T02:00:00Z");
  assert.throws(() => calendarAvailability([e, e], input));
  assert.throws(() =>
    calendarAvailability([], { ...input, end: "2027-01-01T00:00:00Z" }),
  );
  assert.throws(() =>
    calendarAvailability([], { ...input, timeZone: "Unknown/Zone" }),
  );
});

test("Overnight shifts include candidates after midnight in the preceding selected workday", () => {
  const r = calendarAvailability([], {
    ...input,
    start: "2026-11-04T16:00:00Z",
    end: "2026-11-04T22:00:00Z",
    dailyStart: "22:00",
    dailyEnd: "06:00",
    weekdays: [3],
  });
  assert.equal(r.candidates[0]!.start, "2026-11-04T16:00:00Z");
  assert.equal(r.candidates.at(-1)!.end, "2026-11-04T22:00:00Z");
});
