import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  NextcloudCalendarProvider,
  CalendarSourceRejected,
} from "../../apps/api/src/providers/nextcloud-calendar.js";
import { source, password } from "./helpers.js";

test("Real CalDAV discovers source permissions and conditionally creates, queries, updates and removes private events", async () => {
  const calendarId = "hyper-calendar-" + randomUUID();
  const objectId = "event-" + randomUUID() + ".ics";
  const uid = randomUUID();
  const config = {
    publicUrl: source,
    transportUrl: source,
    providerKey: "nextcloud:calendar-ci",
    workspaceId: process.env.NEXTCLOUD_WORKSPACE_ID!,
    memberGroup: "hyper-members",
    bootstrapAdminIds: [],
  };
  const alice = new NextcloudCalendarProvider(
    config,
    { loginName: "calendar-alice", appPassword: password },
    "calendar-alice",
  );
  const bob = new NextcloudCalendarProvider(
    config,
    { loginName: "calendar-bob", appPassword: password },
    "calendar-bob",
  );
  const url =
    source + "/remote.php/dav/calendars/calendar-alice/" + calendarId + "/";
  const authorization =
    "Basic " + Buffer.from("calendar-alice:" + password).toString("base64");
  const ical = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hyper//CalDAV source test//EN",
    "BEGIN:VEVENT",
    "UID:" + uid,
    "DTSTAMP:20261104T000000Z",
    "DTSTART:20261104T010000Z",
    "DTEND:20261104T020000Z",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "SUMMARY:Synthetic private calendar source test",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const created = await fetch(url, {
    method: "MKCALENDAR",
    redirect: "error",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>Hyper synthetic calendar</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>',
  });
  expect(created.status).toBe(201);
  await created.body?.cancel();
  try {
    const calendar = (await alice.calendars()).find((c) => c.id === calendarId);
    expect(calendar).toMatchObject({
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
    });
    await alice.create(calendarId, objectId, ical);
    const saved = await alice.read(calendarId, objectId);
    expect(saved.uid).toBe(uid);
    expect(saved.ical).toContain("RRULE:FREQ=WEEKLY;COUNT=3");
    const queried = await alice.query(calendarId, {
      start: "2026-11-01T00:00:00Z",
      end: "2026-12-01T00:00:00Z",
    });
    expect(queried.map((event) => event.uid)).toEqual([uid]);
    expect(queried[0]?.etag).toBe(saved.etag);
    expect((await bob.calendars()).some((c) => c.id === calendarId)).toBe(
      false,
    );
    await expect(bob.read(calendarId, objectId)).rejects.toBeInstanceOf(
      CalendarSourceRejected,
    );
    await expect(
      alice.create(calendarId, objectId, ical),
    ).rejects.toMatchObject({ status: 412 });
    await alice.replace(
      calendarId,
      objectId,
      saved.etag,
      ical.replace(
        "Synthetic private calendar source test",
        "Synthetic updated source test",
      ),
    );
    const updated = await alice.read(calendarId, objectId);
    expect(updated.etag).not.toBe(saved.etag);
    expect(updated.ical).toContain("Synthetic updated source test");
    await expect(
      alice.replace(calendarId, objectId, saved.etag, ical),
    ).rejects.toMatchObject({ status: 412 });
    await expect(
      alice.remove(calendarId, objectId, saved.etag),
    ).rejects.toMatchObject({ status: 412 });
    await alice.remove(calendarId, objectId, updated.etag);
    await expect(alice.read(calendarId, objectId)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await alice.query(calendarId, {
        start: "2026-11-01T00:00:00Z",
        end: "2026-12-01T00:00:00Z",
      }),
    ).toEqual([]);
  } finally {
    const removed = await fetch(url, {
      method: "DELETE",
      redirect: "error",
      headers: { Authorization: authorization },
    });
    expect(removed.status).toBe(204);
    await removed.body?.cancel();
  }
});
