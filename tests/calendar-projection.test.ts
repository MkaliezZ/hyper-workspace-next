import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarOccurrences } from "../apps/api/src/core/calendar-projection.js";
import type { ExpandedCalendarObject } from "../apps/api/src/providers/calendar.js";

function source(body: string, timezone = ""): ExpandedCalendarObject {
  return {
    calendarId: "personal",
    objectId: "one.ics",
    etag: '"v1"',
    uid: "synthetic",
    representation: "expanded",
    ical: [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      timezone,
      "BEGIN:VEVENT",
      "UID:synthetic",
      body,
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]
      .filter(Boolean)
      .join("\r\n"),
  };
}

test("Expanded source projection keeps exact source identities, UTC instants and cancelled/transparent states", () => {
  const [event] = calendarOccurrences([
    source(
      "DTSTART:20261104T010000Z\r\nDTEND:20261104T020000Z\r\nSUMMARY:项目排期\r\nSTATUS:CANCELLED\r\nTRANSP:TRANSPARENT",
    ),
  ]);
  assert.equal(event?.title, "项目排期");
  assert.equal(event?.uid, "synthetic");
  assert.equal(event?.etag, '"v1"');
  assert.deepEqual(event?.start, {
    kind: "instant",
    value: "2026-11-04T01:00:00.000Z",
    timeZone: "UTC",
  });
  assert.equal(event?.status, "cancelled");
  assert.equal(event?.transparency, "transparent");
});

test("All-day dates stay civil dates with an exclusive end, rather than becoming host-local instants", () => {
  const [event] = calendarOccurrences([
    source("DTSTART;VALUE=DATE:20261104\r\nSUMMARY:全天事件"),
  ]);
  assert.deepEqual(event?.start, { kind: "date", value: "2026-11-04" });
  assert.deepEqual(event?.end, { kind: "date", value: "2026-11-05" });
});

test("Floating and missing TZID definitions remain explicitly unresolved, without assuming UTC", () => {
  const [floating] = calendarOccurrences([
    source("DTSTART:20261104T090000\r\nDTEND:20261104T100000"),
  ]);
  assert.deepEqual(floating?.start, {
    kind: "floating",
    value: "2026-11-04T09:00:00",
  });
  const [unknown] = calendarOccurrences([
    source(
      "DTSTART;TZID=Missing/Zone:20261104T090000\r\nDTEND;TZID=Missing/Zone:20261104T100000",
    ),
  ]);
  assert.deepEqual(unknown?.start, {
    kind: "unresolved_timezone",
    value: "2026-11-04T09:00:00",
    timeZone: "Missing/Zone",
  });
});

test("Embedded source timezone is used without installing process-global timezone state", () => {
  const tz = [
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "END:STANDARD",
    "END:VTIMEZONE",
  ].join("\r\n");
  const [event] = calendarOccurrences([
    source(
      "DTSTART;TZID=Asia/Shanghai:20261104T090000\r\nDTEND;TZID=Asia/Shanghai:20261104T100000",
      tz,
    ),
  ]);
  assert.deepEqual(event?.start, {
    kind: "instant",
    value: "2026-11-04T01:00:00.000Z",
    timeZone: "Asia/Shanghai",
  });
});

test("Unexpanded recurrence, reversed dates and duplicate occurrences fail as a whole", () => {
  for (const body of [
    "DTSTART:20261104T010000Z\r\nRRULE:FREQ=DAILY;COUNT=3",
    "DTSTART:20261104T020000Z\r\nDTEND:20261104T010000Z",
    "DTSTART:20261104T010000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:synthetic\r\nDTSTART:20261104T030000Z",
  ])
    assert.throws(() => calendarOccurrences([source(body)]), /未可靠展开/);
});

test("Display text truncation is explicit and cannot tear Unicode pairs", () => {
  const [event] = calendarOccurrences([
    source("DTSTART:20261104T010000Z\r\nSUMMARY:" + "😀".repeat(501)),
  ]);
  assert.equal(Array.from(event!.title).length, 500);
  assert.deepEqual(event?.truncatedFields, ["summary"]);
  assert.equal(event?.title.at(-1)?.charCodeAt(0), 0xde00);
});
