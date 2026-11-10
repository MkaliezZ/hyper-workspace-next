import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { CalendarOccurrence } from "@hyper/contracts/calendar";
import { login, origin, view } from "./helpers.js";

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
    expect(organizer).toMatchObject({
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
