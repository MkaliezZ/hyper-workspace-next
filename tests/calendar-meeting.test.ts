import { test } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";
import {
  CalendarCommandInput,
  type CalendarInterval,
  type CalendarOccurrence,
} from "@hyper/contracts/calendar";
import {
  createCalendarObject,
  calendarMeeting,
  calendarMeetingRepliesMatch,
  patchCalendarMeeting,
  invitationStatuses,
} from "../apps/api/src/core/calendar-codec.js";

const organizer = "mailto:alice@example.invalid",
  attendee = "mailto:bob@example.invalid",
  other = "mailto:carol@example.invalid";
const command = "53000000-0000-4000-8000-000000000001";
const timed: CalendarInterval = {
  kind: "timed",
  start: "2026-11-04T09:00:00Z",
  end: "2026-11-04T10:00:00Z",
};
const rootOf = (ical: string) => new ICAL.Component(ICAL.parse(ical));
const textOf = (root: InstanceType<typeof ICAL.Component>) =>
  root.toString() + "\r\n";
function fixture(value: CalendarInterval = timed) {
  return createCalendarObject(
    {
      title: "Synthetic recurring meeting",
      description: "Preserve organizer content",
      location: "Room A",
      interval: value,
      repeat: { frequency: "WEEKLY", interval: 1, count: 3 },
    },
    "meeting-fixture",
    command,
    { organizer, attendees: [attendee, other] },
  );
}
function addOverride(
  root: InstanceType<typeof ICAL.Component>,
  key: string,
  start: string,
  end: string,
  zone?: string,
) {
  const exception = new ICAL.Component(
    structuredClone(root.getFirstSubcomponent("vevent")!.toJSON()),
  );
  for (const name of ["rrule", "rdate", "exdate", "dtstart", "dtend"])
    exception.removeAllProperties(name);
  for (const [name, value] of [
    ["recurrence-id", key],
    ["dtstart", start],
    ["dtend", end],
  ]) {
    const property = new ICAL.Property(name!);
    property.setValue(ICAL.Time.fromString(value!, undefined));
    if (zone) property.setParameter("tzid", zone);
    exception.addProperty(property);
  }
  exception.updatePropertyWithValue("summary", "Special arrangement");
  exception
    .getAllProperties("attendee")[0]!
    .setParameter("partstat", "TENTATIVE");
  root.addSubcomponent(exception);
  // Reparse to resolve newly attached TZID values against the parent VTIMEZONE.
  return rootOf(textOf(root));
}
function occurrence(key = "2026-11-11T09:00:00Z"): CalendarOccurrence {
  return {
    calendarId: "personal",
    objectId: "meeting.ics",
    etag: '"v1"',
    uid: "meeting-fixture",
    recurrenceId: key,
    title: "Synthetic recurring meeting",
    description: "Preserve organizer content",
    location: "Room A",
    start: { kind: "instant", value: key, timeZone: "UTC" },
    end: {
      kind: "instant",
      value: key.replace("09:00", "10:00"),
      timeZone: "UTC",
    },
    status: "confirmed",
    transparency: "opaque",
    meeting: true,
    truncatedFields: [],
  };
}
const target = {
  scope: "occurrence" as const,
  recurrenceId: "2026-11-11T09:00:00Z",
  window: { start: "2026-11-11T00:00:00Z", end: "2026-11-12T00:00:00Z" },
};

test("Recurring meeting reschedule preserves timezone, ordinal exceptions, explicit dates and special arrangements", () => {
  const value: CalendarInterval = {
    kind: "zoned",
    timeZone: "America/New_York",
    start: "2026-10-28T09:00:00",
    end: "2026-10-28T10:00:00",
  };
  let root = addOverride(
    rootOf(fixture(value)),
    "2026-11-04T09:00:00",
    "2026-11-04T15:00:00",
    "2026-11-04T16:00:00",
    value.timeZone,
  );
  const master = root.getFirstSubcomponent("vevent")!;
  for (const [name, date] of [
    ["exdate", "2026-11-11T14:00:00Z"],
    ["rdate", "2026-11-20T14:00:00Z"],
  ])
    master.addPropertyWithValue(name!, ICAL.Time.fromString(date!, undefined));
  master.getAllProperties("attendee")[0]!.setParameter("partstat", "ACCEPTED");
  const changed = patchCalendarMeeting(
    textOf(root),
    organizer,
    {
      operation: "reschedule_series",
      exceptions: "preserve_overrides",
      interval: {
        ...value,
        start: "2026-10-29T10:00:00",
        end: "2026-10-29T11:00:00",
      },
    },
    command,
  );
  const events = rootOf(changed).getAllSubcomponents("vevent"),
    first = new ICAL.Event(events[0]!);
  assert.equal(first.startDate.toString(), "2026-10-29T10:00:00");
  assert.equal(first.startDate.zone.tzid, "America/New_York");
  assert.equal(
    events[0]!.getFirstPropertyValue("rrule")!.toString(),
    "FREQ=WEEKLY;COUNT=3",
  );
  assert.match(changed, /EXDATE;TZID=America\/New_York:20261112T100000/);
  assert.match(changed, /RDATE:20261120T140000Z/);
  const exception = events[1]!;
  assert.equal(
    String(exception.getFirstPropertyValue("recurrence-id")),
    "2026-11-05T10:00:00",
  );
  assert.equal(
    new ICAL.Event(exception).startDate.toString(),
    "2026-11-04T15:00:00",
  );
  assert.equal(
    exception.getFirstPropertyValue("summary"),
    "Special arrangement",
  );
  assert.equal(
    events[0]!.getAllProperties("attendee")[0]!.getParameter("partstat"),
    "NEEDS-ACTION",
  );
  assert.equal(
    exception.getAllProperties("attendee")[0]!.getParameter("partstat"),
    "TENTATIVE",
  );
  const details = calendarMeeting(changed, organizer);
  assert.equal(details.series!.exceptionCount, 2);
  assert.equal(details.series!.canReschedule, true);
  assert.deepEqual(details.series!.interval, {
    ...value,
    start: "2026-10-29T10:00:00",
    end: "2026-10-29T11:00:00",
  });
});

test("All-day series retains date boundaries and reschedule rejects ambiguous, orphaned or incompatible source rules", () => {
  const value: CalendarInterval = {
    kind: "all_day",
    start: "2026-11-04",
    end: "2026-11-06",
  };
  const root = addOverride(
    rootOf(fixture(value)),
    "2026-11-11",
    "2026-11-12",
    "2026-11-14",
  );
  const change = {
    operation: "reschedule_series" as const,
    exceptions: "preserve_overrides" as const,
    interval: {
      kind: "all_day" as const,
      start: "2026-11-05",
      end: "2026-11-07",
    },
  };
  const changed = rootOf(
    patchCalendarMeeting(textOf(root), organizer, change, command),
  );
  assert.equal(
    String(
      changed
        .getAllSubcomponents("vevent")[1]!
        .getFirstPropertyValue("recurrence-id"),
    ),
    "2026-11-12",
  );
  assert.equal(
    String(
      changed
        .getAllSubcomponents("vevent")[1]!
        .getFirstPropertyValue("dtstart"),
    ),
    "2026-11-12",
  );
  assert.throws(
    () => patchCalendarMeeting(textOf(root), attendee, change, command),
    /只有/,
  );
  assert.throws(
    () =>
      patchCalendarMeeting(
        textOf(root),
        organizer,
        { ...change, interval: timed },
        command,
      ),
    /全天类型/,
  );
  assert.throws(
    () =>
      patchCalendarMeeting(
        textOf(root).replace(
          "RECURRENCE-ID;VALUE=DATE:",
          "RECURRENCE-ID;RANGE=THISANDFUTURE;VALUE=DATE:",
        ),
        organizer,
        change,
        command,
      ),
    /范围例外/,
  );
  assert.throws(
    () =>
      patchCalendarMeeting(
        textOf(root).replace(
          "RECURRENCE-ID;VALUE=DATE:20261111",
          "RECURRENCE-ID;VALUE=DATE:20261230",
        ),
        organizer,
        change,
        command,
      ),
    /丢失/,
  );
  assert.throws(
    () =>
      patchCalendarMeeting(
        textOf(root).replace(
          "FREQ=WEEKLY;COUNT=3",
          "FREQ=WEEKLY;UNTIL=20261231",
        ),
        organizer,
        change,
        command,
      ),
    /来源重复规则/,
  );
  const zone: CalendarInterval = {
    kind: "zoned",
    timeZone: "America/New_York",
    start: "2026-10-25T09:00:00",
    end: "2026-10-25T10:00:00",
  };
  assert.throws(
    () =>
      patchCalendarMeeting(
        fixture(zone),
        organizer,
        {
          ...change,
          interval: {
            ...zone,
            start: "2026-10-25T01:30:00",
            end: "2026-10-25T02:30:00",
          },
        },
        command,
      ),
    /出现两次/,
  );
});

test("Series replies update only this attendee on all invited live exceptions and read back every response", () => {
  let root = addOverride(
    rootOf(fixture()),
    "2026-11-11T09:00:00Z",
    "2026-11-11T15:00:00Z",
    "2026-11-11T16:00:00Z",
  );
  root = addOverride(
    root,
    "2026-11-18T09:00:00Z",
    "2026-11-18T09:00:00Z",
    "2026-11-18T10:00:00Z",
  );
  const excluded = root.getAllSubcomponents("vevent")[2]!;
  excluded.removeProperty(excluded.getAllProperties("attendee")[0]!);
  const original = textOf(root);
  const changed = patchCalendarMeeting(
    original,
    attendee,
    { operation: "reply", response: "ACCEPTED", target: { scope: "series" } },
    command,
  );
  const events = rootOf(changed).getAllSubcomponents("vevent");
  assert.deepEqual(calendarMeeting(changed, attendee).responses, [
    { recurrenceId: null, response: "accepted" },
    { recurrenceId: target.recurrenceId, response: "accepted" },
  ]);
  for (const event of events) {
    assert.equal(
      event.getFirstPropertyValue("sequence"),
      0,
      "Reply never increments organizer sequence",
    );
    assert.equal(
      event
        .getAllProperties("attendee")
        .find((p) => p.getFirstValue() === other)!
        .getParameter("partstat"),
      "NEEDS-ACTION",
    );
    assert.equal(event.getFirstPropertyValue("organizer"), organizer);
  }
  assert.equal(
    events[2]!.getAllProperties("attendee").length,
    1,
    "Do not invite self to an excluded exception",
  );
  assert.throws(
    () =>
      patchCalendarMeeting(
        changed,
        attendee,
        { operation: "reply", response: "ACCEPTED" },
        command,
      ),
    /相同/,
  );
  assert.equal(calendarMeetingRepliesMatch(changed, changed, attendee), true);
  events[1]!
    .getAllProperties("attendee")[0]!
    .setParameter("partstat", "DECLINED");
  assert.equal(
    calendarMeetingRepliesMatch(changed, textOf(events[0]!.parent!), attendee),
    false,
    "Master-only success must never mask a failed exception reply",
  );
  const invitation = invitationStatuses(original, changed, [
    "bob",
    "carol",
  ])[0]!;
  assert.equal(invitation.response, "accepted");
  assert.deepEqual(invitation.instances, [
    { recurrenceId: target.recurrenceId, response: "accepted" },
  ]);
});

test("Occurrence reply creates a keyed override, preserves other instances and cannot inject a target", () => {
  const original = fixture();
  assert.throws(
    () =>
      patchCalendarMeeting(
        original,
        organizer,
        {
          operation: "reschedule_series",
          exceptions: "preserve_overrides",
          interval: timed,
        },
        command,
      ),
    /请修改系列首次时间/,
  );
  const reply = {
    operation: "reply" as const,
    response: "DECLINED" as const,
    target,
  };
  assert.throws(
    () => patchCalendarMeeting(original, attendee, reply, command),
    /核对来源窗口/,
  );
  assert.throws(
    () =>
      patchCalendarMeeting(original, attendee, reply, command, {
        ...occurrence(),
        uid: "another",
      }),
    /核实/,
  );
  const changed = patchCalendarMeeting(
    original,
    attendee,
    reply,
    command,
    occurrence(),
  );
  const details = calendarMeeting(changed, attendee, occurrence());
  assert.equal(details.ownResponse, "needs_action");
  assert.equal(details.selectedResponse, "declined");
  assert.deepEqual(details.responses, [
    { recurrenceId: null, response: "needs_action" },
    { recurrenceId: target.recurrenceId, response: "declined" },
  ]);
  const events = rootOf(changed).getAllSubcomponents("vevent");
  assert.equal(
    events[1]!.getFirstPropertyValue("summary"),
    events[0]!.getFirstPropertyValue("summary"),
  );
  assert.equal(events[1]!.getFirstPropertyValue("sequence"), 0);
  assert.equal(
    String(events[1]!.getFirstPropertyValue("dtstart")),
    target.recurrenceId,
  );
  const next = patchCalendarMeeting(
    changed,
    attendee,
    { ...reply, response: "TENTATIVE" },
    command,
    occurrence(),
  );
  assert.equal(rootOf(next).getAllSubcomponents("vevent").length, 2);
  assert.equal(
    calendarMeeting(next, attendee, occurrence()).selectedResponse,
    "tentative",
  );
  const moved = rootOf(
    patchCalendarMeeting(
      next,
      organizer,
      {
        operation: "reschedule_series",
        exceptions: "preserve_overrides",
        interval: {
          ...timed,
          start: "2026-11-05T10:00:00Z",
          end: "2026-11-05T11:00:00Z",
        },
      },
      command,
    ),
  );
  const replyOnly = moved.getAllSubcomponents("vevent")[1]!;
  assert.equal(
    String(replyOnly.getFirstPropertyValue("recurrence-id")),
    "2026-11-12T10:00:00Z",
  );
  assert.equal(
    String(replyOnly.getFirstPropertyValue("dtstart")),
    "2026-11-12T10:00:00Z",
    "Reply-only exceptions follow the new series time",
  );
  assert.equal(
    replyOnly.getAllProperties("attendee")[0]!.getParameter("partstat"),
    "NEEDS-ACTION",
  );
  events[1]!.removeProperty(events[1]!.getAllProperties("attendee")[0]!);
  assert.throws(
    () =>
      patchCalendarMeeting(
        textOf(events[0]!.parent!),
        attendee,
        reply,
        command,
        occurrence(),
      ),
    /未被邀请/,
  );
});

test("Meeting reply contract retains historical plans and rejects unbounded or injected target fields", () => {
  const legacy = {
    calendarId: "personal",
    objectId: "meeting.ics",
    etag: '"v1"',
    idempotencyKey: command,
    operation: "update",
    scope: "meeting",
    change: { operation: "reply", response: "ACCEPTED" },
  };
  assert.deepEqual(CalendarCommandInput.parse(legacy), legacy);
  assert.equal(
    CalendarCommandInput.safeParse({
      ...legacy,
      change: { ...legacy.change, target: { ...target, address: organizer } },
    }).success,
    false,
  );
  assert.equal(
    CalendarCommandInput.safeParse({
      ...legacy,
      change: {
        ...legacy.change,
        target: {
          ...target,
          window: {
            start: "2026-01-01T00:00:00Z",
            end: "2027-01-01T00:00:00Z",
          },
        },
      },
    }).success,
    false,
  );
});

test("An exception-only attendee can reply without changing or exposing the uninvited master", () => {
  const root = addOverride(
    rootOf(fixture()),
    target.recurrenceId,
    "2026-11-11T15:00:00Z",
    "2026-11-11T16:00:00Z",
  );
  const master = root.getFirstSubcomponent("vevent")!;
  master.removeProperty(
    master
      .getAllProperties("attendee")
      .find((p) => p.getFirstValue() === attendee)!,
  );
  master.updatePropertyWithValue(
    "summary",
    "Private master title not invited to Bob",
  );
  const original = textOf(root);
  const details = calendarMeeting(original, attendee, occurrence());
  assert.equal(details.title, "Special arrangement");
  assert.equal(details.ownResponse, undefined);
  assert.equal(details.series, undefined);
  assert.equal(details.selectedResponse, "tentative");
  const untargeted = calendarMeeting(original, attendee);
  assert.equal(untargeted.title, "Special arrangement");
  assert.equal(untargeted.series, undefined);
  assert.ok(!JSON.stringify(untargeted).includes("Private master"));
  assert.throws(
    () =>
      calendarMeeting(original, attendee, occurrence("2026-11-18T09:00:00Z")),
    /未被邀请/,
  );
  const one = patchCalendarMeeting(
    original,
    attendee,
    { operation: "reply", response: "DECLINED", target },
    command,
    occurrence(),
  );
  assert.deepEqual(
    rootOf(one).getFirstSubcomponent("vevent")!.toJSON(),
    master.toJSON(),
    "Only the invited exception changes",
  );
  assert.deepEqual(calendarMeeting(one, attendee).responses, [
    { recurrenceId: target.recurrenceId, response: "declined" },
  ]);
  const all = patchCalendarMeeting(
    one,
    attendee,
    { operation: "reply", response: "ACCEPTED", target: { scope: "series" } },
    command,
  );
  assert.deepEqual(
    rootOf(all).getFirstSubcomponent("vevent")!.toJSON(),
    master.toJSON(),
    "Series scope does not add the attendee to the master",
  );
  assert.deepEqual(calendarMeeting(all, attendee).responses, [
    { recurrenceId: target.recurrenceId, response: "accepted" },
  ]);
  assert.equal(calendarMeetingRepliesMatch(all, all, attendee), true);
});
