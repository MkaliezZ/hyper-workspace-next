import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../../apps/api/src/db/database.js";
import { createCalendarScope } from "../fixtures/calendar-scope.js";
import { CalendarAvailabilityQuery } from "@hyper/contracts/calendar";
import { createCalendarObject } from "../../apps/api/src/core/calendar-codec.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Isolated _test database required");
const db = new Database(url);
before(() => db.migrate());
after(() => db.close());
const query = (ids = ["personal"]) =>
  CalendarAvailabilityQuery.parse({
    calendarIds: ids,
    start: "2026-11-04T00:00:00Z",
    end: "2026-11-05T00:00:00Z",
    timeZone: "Asia/Shanghai",
  });
const utcZone = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Etc/UTC",
  "BEGIN:STANDARD",
  "DTSTART:19700101T000000",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0000",
  "END:STANDARD",
  "END:VTIMEZONE",
  "END:VCALENDAR",
  "",
].join("\r\n");
async function saved(f: Awaited<ReturnType<typeof createCalendarScope>>) {
  const c = await f.service.prepare(f.actor, f.create());
  return f.service.apply(f.actor, c.id);
}

test("Availability combines current employee calendars and source versions without writing, broadcasting or seeing a peer home", async () => {
  const f = await createCalendarScope(db);
  try {
    f.source.calendarIds.add("team");
    const original = await saved(f);
    f.source.objects.set("alice/team/other.ics", {
      version: 1,
      ical: createCalendarObject(
        {
          ...f.create().draft,
          interval: {
            kind: "timed",
            start: "2026-11-04T01:30:00Z",
            end: "2026-11-04T03:00:00Z",
          },
        },
        "other-uid",
        "other-command",
      ),
    });
    const before = f.source.writes,
      r = await f.service.availability(f.actor, query(["personal", "team"]));
    assert.equal(r.state, "evaluated");
    assert.equal(r.reservation, false);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.candidates[0]!.start, "2026-11-04T03:00:00Z");
    assert.equal(r.observations.length, 2);
    assert.equal(r.observations[0]!.objects[0]!.etag, original.sourceEtag);
    assert.equal(f.source.writes, before);
    const peer = await f.service.availability(
      f.peer,
      query(["personal", "team"]),
    );
    assert.equal(peer.busy.length, 0);
    assert.equal(peer.conflicts.length, 0);
  } finally {
    await f.close();
  }
});
test("A concurrent source edit invalidates the complete availability observation", async () => {
  const f = await createCalendarScope(db);
  try {
    const e = await saved(f),
      before = f.source.writes;
    f.source.afterReport = async () => {
      f.source.objects.get("alice/personal/" + e.objectId)!.version++;
    };
    await assert.rejects(f.service.availability(f.actor, query()), /变化/);
    assert.equal(f.source.writes, before);
  } finally {
    await f.close();
  }
});
test("Source or product revocation during an availability read never returns stale suggestions", async () => {
  const f = await createCalendarScope(db);
  try {
    await saved(f);
    const before = f.source.writes;
    f.source.afterReport = async () => {
      f.source.people.get("alice")!.member = false;
    };
    await assert.rejects(f.service.availability(f.actor, query()), /撤销/);
    assert.equal(f.source.writes, before);
  } finally {
    await f.close();
  }
});
test("Raw floating time cannot become trusted free time merely because the source expanded it into UTC", async () => {
  const f = await createCalendarScope(db);
  try {
    const e = await saved(f),
      o = f.source.objects.get("alice/personal/" + e.objectId)!;
    o.ical = o.ical.replace(/(DTSTART|DTEND):(\d{8}T\d{6})Z/g, "$1:$2");
    f.source.expand = (ical) =>
      ical.replace(/(DTSTART|DTEND):(\d{8}T\d{6})\r\n/g, "$1:$2Z\r\n");
    const unknown = await f.service.availability(f.actor, query());
    assert.equal(unknown.state, "blocked");
    assert.equal(unknown.candidates.length, 0);
    assert.ok(
      unknown.unknown.some((x) => x.reason === "unresolved_source_timezone"),
    );
    f.source.timeZones.set("alice/personal", utcZone);
    const known = await f.service.availability(f.actor, query());
    assert.equal(known.state, "evaluated");
    assert.equal(known.observations[0]!.timeZoneId, "Etc/UTC");
    f.source.timeZones.set(
      "alice/personal",
      utcZone.replace("TZOFFSETTO:+0000", "INVALID:+0000"),
    );
    assert.equal(
      (await f.service.availability(f.actor, query())).state,
      "blocked",
    );
  } finally {
    await f.close();
  }
});
test("A changed collection timezone invalidates the snapshot even when event ETags did not change", async () => {
  const f = await createCalendarScope(db);
  try {
    await saved(f);
    f.source.afterReport = async () => {
      f.source.timeZones.set("alice/personal", utcZone);
    };
    await assert.rejects(
      f.service.availability(f.actor, query()),
      /时区已变化/,
    );
  } finally {
    await f.close();
  }
});
test("Availability input cannot introduce identities, duplicates or arbitrary endpoints and an aborted read issues no write", async () => {
  const f = await createCalendarScope(db);
  try {
    await assert.rejects(
      f.service.availability(f.actor, { ...query(), actorId: f.peer.id }),
    );
    await assert.rejects(
      f.service.availability(f.actor, {
        ...query(),
        calendarIds: ["personal", "personal"],
      }),
    );
    await assert.rejects(
      f.service.availability(f.actor, {
        ...query(),
        calendarIds: ["https://other.invalid"],
      }),
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      f.service.availability(f.actor, query(), controller.signal),
    );
    assert.equal(f.source.writes, 0);
  } finally {
    await f.close();
  }
});
