import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import type { CalendarOccurrence } from "@hyper/contracts/calendar";
import { NextcloudCalendarProvider } from "../../apps/api/src/providers/nextcloud-calendar.js";
import { login, origin, password, source, view } from "./helpers.js";
import { meetingOverride } from "../fixtures/calendar-meetings.js";

test("Nextcloud delivers an internal invitation, propagates a reply and processes organizer cancellation", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const aliceUid = "calendar-alice",
    bobUid = "calendar-bob";
  const title = "Synthetic scheduling " + randomUUID();
  const day = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const end = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
  const contexts: BrowserContext[] = [];
  try {
    const alice = await login(browser, aliceUid);
    contexts.push(alice.context);
    const bob = await login(browser, bobUid);
    contexts.push(bob.context);
    // Nextcloud granting access and the workspace setting its session are separate steps.
    await Promise.all(
      contexts.map((context) =>
        expect.poll(async () => (await view(context)).status()).toBe(200),
      ),
    );
    const post = async (
      context: BrowserContext,
      path: string,
      data: unknown,
    ) => {
      const result = await context.request.post(
        origin + "/api/calendar/" + path,
        {
          headers: { Origin: origin },
          data,
        },
      );
      if (!result.ok()) {
        const problem = await result.json().catch(() => ({}));
        throw new Error(
          `${path}: ${result.status()} ${String(problem.message ?? "").slice(0, 300)}`,
        );
      }
      return result.json();
    };
    const calendars = async (context: BrowserContext) => {
      const result = await context.request.get(
        origin + "/api/calendar/calendars",
      );
      await expect(result).toBeOK();
      return (await result.json()) as { id: string; canInvite?: boolean }[];
    };
    const find = async (
      context: BrowserContext,
      ids: string[],
      uid?: string,
    ) => {
      for (const id of ids) {
        const events: CalendarOccurrence[] = await post(context, "query", {
          calendarId: id,
          start: day + "T00:00:00Z",
          end: end + "T00:00:00Z",
        });
        const occurrence = events.find((item) =>
          uid ? item.uid === uid : item.title === title,
        );
        if (occurrence) return occurrence;
      }
    };
    const address = ({ calendarId, objectId, etag }: CalendarOccurrence) => ({
      calendarId,
      objectId,
      etag,
    });
    const owned = (await calendars(alice.context)).find(
      (calendar) => calendar.canInvite,
    );
    expect(owned).toBeDefined();
    const bobCalendars = (await calendars(bob.context)).map(
      (calendar) => calendar.id,
    );
    expect(bobCalendars.length).toBeGreaterThan(0);

    await alice.page
      .getByRole("navigation", { name: "工作区导航" })
      .getByRole("button", { name: "日历", exact: true })
      .click();
    const panel = alice.page.getByRole("region", {
      name: "企业日历",
      exact: true,
    });
    await panel.getByLabel("日历", { exact: true }).selectOption(owned!.id);
    await panel.getByLabel("起始日期", { exact: true }).fill(day);
    await panel.getByRole("button", { name: "新建日程", exact: true }).click();
    const form = alice.page.getByRole("dialog", {
      name: "新建日程",
      exact: true,
    });
    await form.getByLabel("日程标题", { exact: true }).fill(title);
    await form.getByLabel("日程时区", { exact: true }).fill("UTC");
    await form
      .getByLabel("开始（指定时区）", { exact: true })
      .fill(day + "T09:00");
    await form
      .getByLabel("结束（指定时区）", { exact: true })
      .fill(day + "T10:00");
    await form
      .getByRole("button", { name: "选择参会员工", exact: true })
      .click();
    await form.getByLabel("搜索员工", { exact: true }).fill(bobUid);
    await form.getByRole("button", { name: / · calendar-bob$/ }).click();
    await form
      .getByRole("button", { name: "创建会议并邀请", exact: true })
      .click();
    await expect(form).not.toBeVisible({ timeout: 60000 });
    let event = await find(alice.context, [owned!.id]);
    expect(event?.meeting).toBe(true);
    const uid = event!.uid;
    const organizer = await post(alice.context, "meeting", address(event!));
    const fixtureProvider = new NextcloudCalendarProvider(
      {
        publicUrl: source,
        transportUrl: source,
        providerKey: "nextcloud:scheduling-ci",
        workspaceId: process.env.NEXTCLOUD_WORKSPACE_ID!,
        memberGroup: process.env.NEXTCLOUD_MEMBER_GROUP ?? "hyper-members",
        bootstrapAdminIds: [],
      },
      { loginName: aliceUid, appPassword: password },
      aliceUid,
    );
    const sourceCopy = await fixtureProvider.read(
      event!.calendarId,
      event!.objectId,
    );
    const sourceStatus = new ICAL.Component(ICAL.parse(sourceCopy.ical))
      .getFirstSubcomponent("vevent")
      ?.getFirstProperty("attendee")
      ?.getParameter("schedule-status");
    const statusCode = String(sourceStatus ?? "").match(
      /^[1-5]\.\d+(?=;|$)/u,
    )?.[0];
    expect(
      organizer,
      "Source attendee SCHEDULE-STATUS " + (statusCode ?? "unreported"),
    ).toMatchObject({
      role: "organizer",
      invitations: [
        {
          employeeUid: bobUid,
          delivery: "delivered",
          response: "needs_action",
        },
      ],
    });
    let received: CalendarOccurrence | undefined;
    await expect
      .poll(
        async () => {
          received = await find(bob.context, bobCalendars, uid);
          return received?.meeting;
        },
        { timeout: 20000 },
      )
      .toBe(true);
    const attendee = await post(bob.context, "meeting", address(received!));
    expect(attendee).toMatchObject({
      role: "attendee",
      ownResponse: "needs_action",
    });
    await bob.page
      .getByRole("navigation", { name: "工作区导航" })
      .getByRole("button", { name: "日历", exact: true })
      .click();
    const bobPanel = bob.page.getByRole("region", {
      name: "企业日历",
      exact: true,
    });
    await bobPanel
      .getByLabel("日历", { exact: true })
      .selectOption(received!.calendarId);
    await bobPanel.getByLabel("起始日期", { exact: true }).fill(day);
    const eventCard = bobPanel.locator(".calendar-event").filter({
      has: bob.page.getByRole("heading", { name: title, exact: true }),
    });
    await eventCard
      .getByRole("button", { name: "查看会议与回复", exact: true })
      .click();
    const replyForm = bob.page.getByRole("dialog", {
      name: "会议与参会回复",
      exact: true,
    });
    await expect(
      replyForm.getByText("本人回复：待回复", { exact: true }),
    ).toBeVisible();
    await replyForm
      .getByLabel("会议操作", { exact: true })
      .selectOption("ACCEPTED");
    await replyForm
      .getByRole("button", { name: "确认提交会议操作", exact: true })
      .click();
    await expect(replyForm).not.toBeVisible({ timeout: 60000 });
    await expect(
      bobPanel.getByText("本人回复：已接受", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () => {
          event = await find(alice.context, [owned!.id], uid);
          const current =
            event && (await post(alice.context, "meeting", address(event)));
          return current?.invitations?.[0]?.response;
        },
        { timeout: 20000 },
      )
      .toBe("accepted");
    const edit = await post(alice.context, "commands", {
      ...address(event!),
      operation: "update",
      scope: "meeting",
      idempotencyKey: randomUUID(),
      change: {
        operation: "edit",
        patch: {
          interval: {
            kind: "timed",
            start: day + "T10:30:00Z",
            end: day + "T11:30:00Z",
          },
        },
      },
    });
    expect(
      await post(alice.context, `commands/${edit.id}/apply`, {
        confirmed: true,
      }),
    ).toMatchObject({
      state: "succeeded",
      meeting: { role: "organizer", cancelled: false },
    });
    await expect
      .poll(
        async () => {
          const rescheduled = await find(bob.context, bobCalendars, uid);
          return rescheduled?.start.value;
        },
        { timeout: 20000 },
      )
      .toBe(day + "T10:30:00.000Z");
    event = await find(alice.context, [owned!.id], uid);
    const cancel = await post(alice.context, "commands", {
      ...address(event!),
      operation: "update",
      scope: "meeting",
      idempotencyKey: randomUUID(),
      change: { operation: "cancel" },
    });
    expect(
      await post(alice.context, `commands/${cancel.id}/apply`, {
        confirmed: true,
      }),
    ).toMatchObject({
      state: "succeeded",
      meeting: { role: "organizer", cancelled: true },
    });
    await expect
      .poll(
        async () => {
          const current = await find(bob.context, bobCalendars, uid);
          return current?.status ?? "absent";
        },
        { timeout: 20000 },
      )
      .toMatch(/^(cancelled|absent)$/);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("Real CalDAV preserves recurring meeting exceptions and propagates scoped replies and whole-series reschedule across DST", async ({
  browser,
}) => {
  test.setTimeout(300000);
  const contexts: BrowserContext[] = [];
  const aliceUid = "calendar-alice",
    bobUid = "calendar-bob";
  const provider = new NextcloudCalendarProvider(
    {
      publicUrl: source,
      transportUrl: source,
      providerKey: "nextcloud:scheduling-ci",
      workspaceId: process.env.NEXTCLOUD_WORKSPACE_ID!,
      memberGroup: process.env.NEXTCLOUD_MEMBER_GROUP ?? "hyper-members",
      bootstrapAdminIds: [],
    },
    { loginName: aliceUid, appPassword: password },
    aliceUid,
  );
  let created: { calendarId: string; objectId: string } | undefined;
  try {
    const alice = await login(browser, aliceUid);
    contexts.push(alice.context);
    const bob = await login(browser, bobUid);
    contexts.push(bob.context);
    await Promise.all(
      contexts.map((context) =>
        expect.poll(async () => (await view(context)).status()).toBe(200),
      ),
    );
    const post = async (
      context: BrowserContext,
      path: string,
      data: unknown,
    ) => {
      const response = await context.request.post(
        origin + "/api/calendar/" + path,
        { headers: { Origin: origin }, data },
      );
      if (!response.ok()) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          `${path}: ${response.status()} ${String(body.message ?? "").slice(0, 300)}`,
        );
      }
      return response.json();
    };
    const calendars = async (context: BrowserContext) => {
      const response = await context.request.get(
        origin + "/api/calendar/calendars",
      );
      await expect(response).toBeOK();
      return (await response.json()) as { id: string; canInvite?: boolean }[];
    };
    const calendar = (await calendars(alice.context)).find(
      (item) => item.canInvite,
    )!;
    expect(calendar).toBeDefined();
    const bobIds = (await calendars(bob.context)).map((item) => item.id);
    const plan = await post(alice.context, "commands", {
      operation: "create",
      calendarId: calendar.id,
      idempotencyKey: randomUUID(),
      invitees: [bobUid],
      draft: {
        title: "Synthetic recurring scheduling " + randomUUID(),
        description: "DST and per-occurrence scheduling",
        location: "Synthetic room",
        interval: {
          kind: "zoned",
          timeZone: "America/New_York",
          start: "2030-03-03T09:00:00",
          end: "2030-03-03T10:00:00",
        },
        repeat: { frequency: "WEEKLY", interval: 1, count: 4 },
      },
    });
    created = { calendarId: calendar.id, objectId: plan.objectId };
    expect(
      await post(alice.context, `commands/${plan.id}/apply`, {
        confirmed: true,
      }),
    ).toMatchObject({ state: "succeeded" });
    const initial = await provider.read(created.calendarId, created.objectId);
    const uid = initial.uid;
    // The source calendar already contains a moved instance and one excluded date.
    const fixture = new ICAL.Component(
      ICAL.parse(
        meetingOverride(
          initial.ical,
          "2030-03-10T13:00:00Z",
          "2030-03-10T16:00:00Z",
          "2030-03-10T17:00:00Z",
        ),
      ),
    );
    fixture
      .getFirstSubcomponent("vevent")!
      .addPropertyWithValue(
        "exdate",
        ICAL.Time.fromString("2030-03-24T13:00:00Z", undefined),
      );
    for (const component of fixture.getAllSubcomponents("vevent"))
      component.updatePropertyWithValue("sequence", 1);
    await provider.replaceMeeting(
      created.calendarId,
      created.objectId,
      initial.etag,
      fixture.toString() + "\r\n",
    );
    const window = {
      start: "2030-03-01T00:00:00Z",
      end: "2030-04-01T00:00:00Z",
    };
    const events = async (context: BrowserContext, ids: string[]) => {
      const all: CalendarOccurrence[] = [];
      for (const calendarId of ids)
        all.push(...(await post(context, "query", { calendarId, ...window })));
      return all
        .filter((event) => event.uid === uid)
        .sort((a, b) => a.start.value.localeCompare(b.start.value));
    };
    let bobEvents: CalendarOccurrence[] = [];
    await expect
      .poll(
        async () => {
          bobEvents = await events(bob.context, bobIds);
          return bobEvents.map((item) => item.start.value);
        },
        { timeout: 30000 },
      )
      .toEqual([
        "2030-03-03T14:00:00.000Z",
        "2030-03-10T16:00:00.000Z",
        "2030-03-17T13:00:00.000Z",
      ]);
    const address = ({ calendarId, objectId, etag }: CalendarOccurrence) => ({
      calendarId,
      objectId,
      etag,
    });
    const change = async (
      context: BrowserContext,
      event: CalendarOccurrence,
      mutation: unknown,
    ) => {
      const prepared = await post(context, "commands", {
        ...address(event),
        operation: "update",
        scope: "meeting",
        idempotencyKey: randomUUID(),
        change: mutation,
      });
      const saved = await post(context, `commands/${prepared.id}/apply`, {
        confirmed: true,
      });
      expect(saved).toMatchObject({
        state: "succeeded",
        observedResult: "matched",
      });
      expect(
        await post(context, `commands/${prepared.id}/apply`, {
          confirmed: true,
        }),
      ).toMatchObject({
        id: prepared.id,
        state: "succeeded",
        sourceEtag: saved.sourceEtag,
      });
      return saved;
    };
    const rawResponses = async () => {
      const current = await provider.read(
        created!.calendarId,
        created!.objectId,
      );
      return new ICAL.Component(ICAL.parse(current.ical))
        .getAllSubcomponents("vevent")
        .map((component) => ({
          key:
            component.getFirstPropertyValue("recurrence-id") instanceof
            ICAL.Time
              ? (
                  component.getFirstPropertyValue(
                    "recurrence-id",
                  ) as InstanceType<typeof ICAL.Time>
                )
                  .convertToZone(ICAL.Timezone.utcTimezone)
                  .toString()
              : null,
          status: component
            .getAllProperties("attendee")
            .find((item) => String(item.getFirstValue()).includes(bobUid))
            ?.getParameter("partstat"),
        }))
        .sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""));
    };
    const second = bobEvents.find(
      (item) => item.recurrenceId === "2030-03-10T13:00:00Z",
    )!;
    expect(second).toBeDefined();
    await change(bob.context, second, {
      operation: "reply",
      response: "DECLINED",
      target: {
        scope: "occurrence",
        recurrenceId: second.recurrenceId,
        window,
      },
    });
    await expect.poll(rawResponses, { timeout: 30000 }).toEqual([
      { key: null, status: "NEEDS-ACTION" },
      { key: "2030-03-10T13:00:00Z", status: "DECLINED" },
    ]);
    bobEvents = await events(bob.context, bobIds);
    await change(bob.context, bobEvents[0]!, {
      operation: "reply",
      response: "ACCEPTED",
      target: { scope: "series" },
    });
    await expect.poll(rawResponses, { timeout: 30000 }).toEqual([
      { key: null, status: "ACCEPTED" },
      { key: "2030-03-10T13:00:00Z", status: "ACCEPTED" },
    ]);
    bobEvents = await events(bob.context, bobIds);
    const third = bobEvents.find(
      (item) => item.recurrenceId === "2030-03-17T13:00:00Z",
    )!;
    await change(bob.context, third, {
      operation: "reply",
      response: "TENTATIVE",
      target: { scope: "occurrence", recurrenceId: third.recurrenceId, window },
    });
    await expect.poll(rawResponses, { timeout: 30000 }).toEqual([
      { key: null, status: "ACCEPTED" },
      { key: "2030-03-10T13:00:00Z", status: "ACCEPTED" },
      { key: "2030-03-17T13:00:00Z", status: "TENTATIVE" },
    ]);
    const organizerEvents = await events(alice.context, [calendar.id]);
    await change(alice.context, organizerEvents[0]!, {
      operation: "reschedule_series",
      exceptions: "preserve_overrides",
      interval: {
        kind: "zoned",
        timeZone: "America/New_York",
        start: "2030-03-04T10:00:00",
        end: "2030-03-04T11:00:00",
      },
    });
    await expect
      .poll(
        async () => {
          bobEvents = await events(bob.context, bobIds);
          return bobEvents.map((item) => ({
            key: item.recurrenceId,
            start: item.start.value,
          }));
        },
        { timeout: 30000 },
      )
      .toEqual([
        { key: "2030-03-04T15:00:00Z", start: "2030-03-04T15:00:00.000Z" },
        { key: "2030-03-11T14:00:00Z", start: "2030-03-10T16:00:00.000Z" },
        { key: "2030-03-18T14:00:00Z", start: "2030-03-18T14:00:00.000Z" },
      ]);
    const rescheduled = await provider.read(
      created.calendarId,
      created.objectId,
    );
    const rescheduledRoot = new ICAL.Component(ICAL.parse(rescheduled.ical));
    expect(
      String(
        rescheduledRoot
          .getFirstSubcomponent("vevent")!
          .getFirstPropertyValue("rrule"),
      ),
    ).toBe("FREQ=WEEKLY;COUNT=4");
    const excluded = rescheduledRoot
      .getFirstSubcomponent("vevent")!
      .getFirstPropertyValue("exdate") as InstanceType<typeof ICAL.Time>;
    expect(excluded.convertToZone(ICAL.Timezone.utcTimezone).toString()).toBe(
      "2030-03-25T14:00:00Z",
    );
    const reset = await rawResponses();
    expect(reset.find((item) => item.key === null)?.status).toBe(
      "NEEDS-ACTION",
    );
    expect(
      reset.find((item) => item.key === "2030-03-18T14:00:00Z")?.status,
    ).toBe("NEEDS-ACTION");
    await change(bob.context, bobEvents[0]!, {
      operation: "reply",
      response: "ACCEPTED",
      target: { scope: "series" },
    });
    await expect.poll(rawResponses, { timeout: 30000 }).toEqual([
      { key: null, status: "ACCEPTED" },
      { key: "2030-03-11T14:00:00Z", status: "ACCEPTED" },
      { key: "2030-03-18T14:00:00Z", status: "ACCEPTED" },
    ]);
    const finalEvents = await events(alice.context, [calendar.id]);
    const details = await post(
      alice.context,
      "meeting",
      address(finalEvents[0]!),
    );
    expect(details.invitations[0]).toMatchObject({
      employeeUid: bobUid,
      response: "accepted",
      instances: [
        { recurrenceId: "2030-03-11T14:00:00Z", response: "accepted" },
        { recurrenceId: "2030-03-18T14:00:00Z", response: "accepted" },
      ],
    });
  } finally {
    if (created) {
      const current = await provider
        .read(created.calendarId, created.objectId)
        .catch(() => null);
      if (current)
        await provider.remove(
          created.calendarId,
          created.objectId,
          current.etag,
        );
    }
    await Promise.all(contexts.map((context) => context.close()));
  }
});
