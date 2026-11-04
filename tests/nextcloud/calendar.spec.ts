import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { calendarOccurrences } from "../../apps/api/src/core/calendar-projection.js";
import {
  NextcloudCalendarProvider,
  CalendarSourceRejected,
} from "../../apps/api/src/providers/nextcloud-calendar.js";
import { source, password, login, origin } from "./helpers.js";

test("Real CalDAV and product UI preserve source permissions, versions, recurring instances and private command receipts", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const prefix = process.env.HYPER_CALENDAR_TEST_PREFIX ?? "calendar";
  const aliceUid = prefix + "-alice",
    bobUid = prefix + "-bob";
  const calendarId = "hyper-calendar-" + randomUUID();
  const objectId = "event-" + randomUUID() + ".ics";
  const uid = randomUUID();
  const config = {
    publicUrl: source,
    transportUrl: source,
    providerKey: "nextcloud:calendar-ci",
    workspaceId: process.env.NEXTCLOUD_WORKSPACE_ID!,
    memberGroup: process.env.NEXTCLOUD_MEMBER_GROUP ?? "hyper-members",
    bootstrapAdminIds: [],
  };
  const alice = new NextcloudCalendarProvider(
    config,
    { loginName: aliceUid, appPassword: password },
    aliceUid,
  );
  const bob = new NextcloudCalendarProvider(
    config,
    { loginName: bobUid, appPassword: password },
    bobUid,
  );
  const url =
    source + "/remote.php/dav/calendars/" + aliceUid + "/" + calendarId + "/";
  const authorization =
    "Basic " + Buffer.from(aliceUid + ":" + password).toString("base64");
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
    const occurrences = calendarOccurrences(
      await alice.occurrences(calendarId, {
        start: "2026-11-01T00:00:00Z",
        end: "2026-12-01T00:00:00Z",
      }),
    );
    expect(occurrences.map((event) => event.start.value)).toEqual([
      "2026-11-04T01:00:00.000Z",
      "2026-11-11T01:00:00.000Z",
      "2026-11-18T01:00:00.000Z",
    ]);
    expect(
      occurrences.every(
        (event) => event.uid === uid && event.etag === saved.etag,
      ),
    ).toBe(true);
    const actor = await login(browser, aliceUid);
    try {
      // Separate source/API readiness from a missing rendered selector in failure evidence.
      try {
        await expect(
          actor.page.getByRole("navigation", { name: "工作区导航" }),
        ).toBeVisible({ timeout: 60000 });
      } catch (error) {
        // Static UI messages only: no cookies, login-flow URLs, values or source content.
        console.error(
          "Calendar product readiness",
          JSON.stringify({
            headings: await actor.page.getByRole("heading").allTextContents(),
            alerts: await actor.page.getByRole("alert").allTextContents(),
            status: await actor.page.getByRole("status").allTextContents(),
          }).replaceAll(password, "[redacted]"),
        );
        throw error;
      }
      const sourceList = await actor.context.request.get(
        origin + "/api/calendar/calendars",
      );
      await expect(sourceList).toBeOK();
      expect(
        (await sourceList.json()).some((c: any) => c.id === calendarId),
      ).toBe(true);
      await actor.page
        .getByRole("navigation", { name: "工作区导航" })
        .getByRole("button", { name: "日历", exact: true })
        .click();
      const panel = actor.page.getByRole("region", {
        name: "企业日历",
        exact: true,
      });
      await expect(panel).toBeVisible();
      await panel.getByLabel("日历", { exact: true }).selectOption(calendarId);
      await panel.getByLabel("起始日期", { exact: true }).fill("2026-11-04");
      await expect(
        panel.getByRole("heading", {
          name: "Synthetic private calendar source test",
          exact: true,
        }),
      ).toBeVisible({ timeout: 60000 });
      await panel
        .getByRole("button", { name: "新建日程", exact: true })
        .click();
      const dialog = actor.page.getByRole("dialog", {
        name: "新建日程",
        exact: true,
      });
      await dialog
        .getByLabel("日程标题", { exact: true })
        .fill("Synthetic product calendar event");
      await dialog.getByLabel("地点", { exact: true }).fill("Synthetic room");
      await dialog
        .getByLabel("开始（本机时区）", { exact: true })
        .fill("2026-11-04T09:00");
      await dialog
        .getByLabel("结束（本机时区）", { exact: true })
        .fill("2026-11-04T10:00");
      await dialog
        .getByRole("button", { name: "保存日程", exact: true })
        .click();
      await expect(dialog).not.toBeVisible({ timeout: 60000 });
      await expect(
        panel.getByRole("heading", {
          name: "Synthetic product calendar event",
          exact: true,
        }),
      ).toBeVisible({ timeout: 60000 });
      const receipts = await (
        await actor.context.request.get(origin + "/api/calendar/commands")
      ).json();
      const receipt = receipts.find(
        (r: any) => r.title === "Synthetic product calendar event",
      );
      expect(receipt.state).toBe("succeeded");
      expect(receipt.observedResult).toBe("matched");
      const original = await alice.read(calendarId, receipt.objectId);
      expect(original.uid).toBe(receipt.id + "@hyper-workspace");
      const prepared = await actor.context.request.post(
        origin + "/api/calendar/commands",
        {
          headers: { Origin: origin },
          data: {
            operation: "update",
            calendarId,
            objectId: receipt.objectId,
            etag: original.etag,
            scope: "series",
            patch: { title: "Synthetic product update" },
            idempotencyKey: randomUUID(),
          },
        },
      );
      expect(prepared.ok()).toBe(true);
      const update = await prepared.json();
      const changed = await actor.context.request.post(
        origin + "/api/calendar/commands/" + update.id + "/apply",
        { headers: { Origin: origin }, data: { confirmed: true } },
      );
      expect(changed.ok()).toBe(true);
      const changedReceipt = await changed.json();
      expect(changedReceipt.state).toBe("succeeded");
      expect((await alice.read(calendarId, receipt.objectId)).ical).toContain(
        "Synthetic product update",
      );
      const removal = await actor.context.request.post(
        origin + "/api/calendar/commands",
        {
          headers: { Origin: origin },
          data: {
            operation: "delete",
            calendarId,
            objectId: receipt.objectId,
            etag: changedReceipt.sourceEtag,
            scope: "series",
            idempotencyKey: randomUUID(),
          },
        },
      );
      expect(removal.ok()).toBe(true);
      const remove = await removal.json();
      const removed = await actor.context.request.post(
        origin + "/api/calendar/commands/" + remove.id + "/apply",
        { headers: { Origin: origin }, data: { confirmed: true } },
      );
      expect(removed.ok()).toBe(true);
      expect((await removed.json()).observedResult).toBe("absent");
      await expect(
        alice.read(calendarId, receipt.objectId),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await actor.context.close();
    }
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
