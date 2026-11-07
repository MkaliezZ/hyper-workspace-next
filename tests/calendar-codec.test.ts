import { test } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";
import {
  CalendarCommandInput,
  CalendarPatch,
  type CalendarOccurrence,
} from "@hyper/contracts/calendar";
import {
  createCalendarObject,
  patchCalendarObject,
  patchCalendarOccurrence,
  calendarObjectDigest,
} from "../apps/api/src/core/calendar-codec.js";
const uid = "synthetic-calendar-codec",
  command = "50000000-0000-4000-8000-000000000123";
const draft = {
  title: "标题\nSUMMARY:不是新属性",
  description: "正文,;\\\n保持文本",
  location: "会议室 A",
  interval: {
    kind: "timed" as const,
    start: "2026-11-04T01:00:00Z",
    end: "2026-11-04T02:00:00Z",
  },
};
test("Calendar codec safely escapes text and preserves exact UTC/all-day interval semantics", () => {
  const ical = createCalendarObject(draft, uid, command),
    root = new ICAL.Component(ICAL.parse(ical));
  assert.equal(root.getAllSubcomponents("vevent").length, 1);
  const event = new ICAL.Event(root.getFirstSubcomponent("vevent")!);
  assert.equal(event.summary, draft.title);
  assert.equal(event.description, draft.description);
  assert.equal(event.startDate.toString(), "2026-11-04T01:00:00Z");
  const day = createCalendarObject(
    {
      ...draft,
      interval: { kind: "all_day", start: "2026-11-04", end: "2026-11-06" },
    },
    uid,
    command,
  );
  const allDay = new ICAL.Event(
    new ICAL.Component(ICAL.parse(day)).getFirstSubcomponent("vevent")!,
  );
  assert.equal(allDay.startDate.isDate, true);
  assert.equal(allDay.endDate.toString(), "2026-11-06");
});
test("Partial calendar edits leave omitted values and recurrence/timezone exceptions intact", () => {
  assert.deepEqual(CalendarPatch.parse({ title: "新标题" }), {
    title: "新标题",
  });
  const ical = createCalendarObject(draft, uid, command)
    .replace(
      "BEGIN:VEVENT",
      "BEGIN:VTIMEZONE\r\nTZID:Custom/Test\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT",
    )
    .replace(
      "END:VEVENT",
      "RRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE:20261111T010000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:" +
        uid +
        "\r\nRECURRENCE-ID:20261118T010000Z\r\nDTSTART:20261118T030000Z\r\nDTEND:20261118T040000Z\r\nSUMMARY:例外\r\nEND:VEVENT",
    );
  const patched = patchCalendarObject(ical, { title: "新标题" }, command);
  assert.match(patched, /RRULE:FREQ=WEEKLY;COUNT=4/);
  assert.match(patched, /EXDATE:20261111T010000Z/);
  assert.match(patched, /RECURRENCE-ID:20261118T010000Z/);
  assert.match(patched, /TZID:Custom\/Test/);
  const event = new ICAL.Event(
    new ICAL.Component(ICAL.parse(patched)).getFirstSubcomponent("vevent")!,
  );
  assert.equal(event.description, draft.description);
  assert.equal(event.location, draft.location);
  assert.throws(
    () => patchCalendarObject(ical, { interval: draft.interval }, command),
    /重复日程的时间调整/,
  );
});
test("Calendar semantic readback ignores ordering and source timestamps but detects changed business data", () => {
  const ical = createCalendarObject(draft, uid, command),
    root = new ICAL.Component(ICAL.parse(ical));
  root
    .getFirstSubcomponent("vevent")!
    .updatePropertyWithValue(
      "dtstamp",
      ICAL.Time.fromDateTimeString("2027-01-01T00:00:00Z"),
    );
  assert.equal(
    calendarObjectDigest(ical),
    calendarObjectDigest(root.toString()),
  );
  root
    .getFirstSubcomponent("vevent")!
    .updatePropertyWithValue("location", "别人更改的地点");
  assert.notEqual(
    calendarObjectDigest(ical),
    calendarObjectDigest(root.toString()),
  );
});
test("Calendar input rejects invented actors, arbitrary source URLs, weak versions and invalid intervals", () => {
  const value = {
    operation: "create",
    calendarId: "personal",
    draft,
    idempotencyKey: command,
  };
  assert.equal(CalendarCommandInput.safeParse(value).success, true);
  for (const patch of [
    { actorId: "someone" },
    { calendarId: "../other" },
    { calendarId: "https://foreign.invalid" },
    {
      draft: {
        ...draft,
        interval: { ...draft.interval, end: draft.interval.start },
      },
    },
  ])
    assert.equal(
      CalendarCommandInput.safeParse({ ...value, ...patch }).success,
      false,
    );
  assert.equal(
    CalendarCommandInput.safeParse({
      operation: "delete",
      calendarId: "personal",
      objectId: "e.ics",
      etag: 'W/"v1"',
      scope: "series",
      idempotencyKey: command,
    }).success,
    false,
  );
});

test("A moved occurrence keeps its original named-zone key and cancellation preserves other exceptions", () => {
  const raw = createCalendarObject(draft, uid, command)
    .replace(
      "BEGIN:VEVENT",
      "BEGIN:VTIMEZONE\r\nTZID:Asia/Shanghai\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT",
    )
    .replace(
      "DTSTART:20261104T010000Z",
      "DTSTART;TZID=Asia/Shanghai:20261104T090000",
    )
    .replace(
      "DTEND:20261104T020000Z",
      "DTEND;TZID=Asia/Shanghai:20261104T100000",
    )
    .replace(
      "END:VEVENT",
      "RRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;TZID=Asia/Shanghai:20261125T090000\r\nEND:VEVENT",
    );
  const occurrence: CalendarOccurrence = {
    calendarId: "personal",
    objectId: "event.ics",
    etag: '"v1"',
    uid,
    recurrenceId: "2026-11-11T01:00:00Z",
    title: draft.title,
    description: draft.description,
    location: draft.location,
    start: {
      kind: "instant",
      value: "2026-11-11T01:00:00.000Z",
      timeZone: "UTC",
    },
    end: {
      kind: "instant",
      value: "2026-11-11T02:00:00.000Z",
      timeZone: "UTC",
    },
    status: "confirmed",
    transparency: "opaque",
    truncatedFields: [],
  };
  const moved = patchCalendarOccurrence(
    raw,
    occurrence,
    {
      operation: "edit",
      patch: {
        interval: {
          kind: "timed",
          start: "2026-11-12T02:00:00Z",
          end: "2026-11-12T03:00:00Z",
        },
      },
    },
    command,
  );
  assert.match(moved, /RECURRENCE-ID;TZID=Asia\/Shanghai:20261111T090000/);
  assert.match(moved, /DTSTART:20261112T020000Z/);
  assert.match(moved, /RRULE:FREQ=WEEKLY;COUNT=4/);
  const text = patchCalendarOccurrence(
    moved,
    occurrence,
    {
      operation: "edit",
      patch: { title: "修改已移动日程" },
    },
    command,
  );
  assert.equal((text.match(/RECURRENCE-ID/g) ?? []).length, 1);
  assert.match(text, /DTSTART:20261112T020000Z/);
  assert.match(text, /SUMMARY:修改已移动日程/);
  const cancelled = patchCalendarOccurrence(
    text,
    occurrence,
    { operation: "cancel" },
    command,
  );
  assert.doesNotMatch(cancelled, /RECURRENCE-ID|DTSTART:20261112/);
  assert.match(cancelled, /EXDATE;TZID=Asia\/Shanghai:20261125T090000/);
  assert.match(cancelled, /EXDATE;TZID=Asia\/Shanghai:20261111T090000/);
  assert.match(cancelled, /RRULE:FREQ=WEEKLY;COUNT=4/);
});

test("A recurring named-zone draft retains its wall time across a DST transition", () => {
  const zoned = {
    ...draft,
    interval: {
      kind: "zoned" as const,
      start: "2027-03-07T09:00:00",
      end: "2027-03-07T10:00:00",
      timeZone: "America/New_York",
    },
    repeat: { frequency: "WEEKLY" as const, interval: 1, count: 3 },
  };
  const stored = createCalendarObject(zoned, uid, command);
  assert.match(stored, /DTSTART;TZID=America\/New_York:20270307T090000/);
  assert.match(stored, /RRULE:FREQ=WEEKLY;COUNT=3/);
  const root = new ICAL.Component(ICAL.parse(stored));
  const event = new ICAL.Event(root.getFirstSubcomponent("vevent")!);
  const occurrences = event.iterator();
  assert.deepEqual(
    Array.from({ length: 3 }, () =>
      occurrences.next()!.toJSDate().toISOString(),
    ),
    [
      "2027-03-07T14:00:00.000Z",
      "2027-03-14T13:00:00.000Z",
      "2027-03-21T13:00:00.000Z",
    ],
  );
  assert.throws(
    () =>
      createCalendarObject(
        {
          ...zoned,
          interval: {
            ...zoned.interval,
            start: "2027-03-14T02:30:00",
            end: "2027-03-14T03:30:00",
          },
        },
        uid,
        command,
      ),
    /不存在/,
  );
  assert.throws(
    () =>
      createCalendarObject(
        {
          ...zoned,
          interval: {
            ...zoned.interval,
            start: "2027-11-07T01:30:00",
            end: "2027-11-07T02:30:00",
          },
        },
        uid,
        command,
      ),
    /出现两次/,
  );
  assert.throws(
    () =>
      createCalendarObject(
        {
          ...zoned,
          repeat: { frequency: "YEARLY", interval: 2, count: 4 },
        },
        uid,
        command,
      ),
    /五年内/,
  );
});
