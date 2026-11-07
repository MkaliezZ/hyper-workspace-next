import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarTimeBasis } from "../apps/api/src/core/calendar-time-basis.js";
const wrap = (body: string) =>
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic\r\n" +
  body +
  "\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
test("Only an explicit source calendar zone resolves a floating event; a server default is not evidence", () => {
  const s = wrap("DTSTART:20261104T090000\r\nDTEND:20261104T100000");
  assert.equal(calendarTimeBasis(s, false), "unresolved_source_timezone");
  assert.equal(calendarTimeBasis(s, true), "source_calendar_timezone");
});
test("Known IANA event zones and UTC are explicit; private unknown zone references remain unresolved", () => {
  assert.equal(
    calendarTimeBasis(
      wrap(
        "DTSTART;TZID=Asia/Shanghai:20261104T090000\r\nDTEND;TZID=Asia/Shanghai:20261104T100000",
      ),
      false,
    ),
    "explicit",
  );
  assert.equal(
    calendarTimeBasis(
      wrap("DTSTART:20261104T010000Z\r\nDTEND:20261104T020000Z"),
      false,
    ),
    "explicit",
  );
  assert.equal(
    calendarTimeBasis(
      wrap("DTSTART;TZID=Unknown/Private:20261104T090000"),
      true,
    ),
    "unresolved_named_timezone",
  );
});
test("Date events are interpreted by the selected viewing zone; nonblocking events do not prevent suggestions", () => {
  assert.equal(
    calendarTimeBasis(
      wrap("DTSTART;VALUE=DATE:20261104\r\nDTEND;VALUE=DATE:20261105"),
      false,
    ),
    "explicit",
  );
  assert.equal(
    calendarTimeBasis(
      wrap("DTSTART:20261104T090000\r\nTRANSP:TRANSPARENT"),
      false,
    ),
    "explicit",
  );
  assert.equal(
    calendarTimeBasis(
      wrap("DTSTART:20261104T090000\r\nSTATUS:CANCELLED"),
      false,
    ),
    "explicit",
  );
});
