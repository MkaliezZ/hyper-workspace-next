import { test, expect, type Page } from "@playwright/test";
import type {
  CalendarCommandInput,
  CalendarCommandReceipt,
  CalendarOccurrence,
} from "@hyper/contracts/calendar";
async function start(
  page: Page,
  configure?: (view: any) => void,
  runs: () => unknown[] = () => [],
) {
  await page.request.post("/api/auth/demo", { data: {} });
  const view = await (await page.request.get("/api/workspace")).json();
  view.user.demo = false;
  configure?.(view);
  await page.route("**/api/calendar/runs", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: runs() })
      : route.fallback(),
  );
  await page.route("**/api/workspace", (route) =>
    route.fulfill({ json: view }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "日历", exact: true })
    .click();
  return page.getByRole("region", { name: "企业日历", exact: true });
}
test("Calendar AI keeps one admission key after a lost receipt, uses the chosen engine and reopens its private run", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const runId = "75000000-0000-4000-8000-000000000001",
    modelId = "75000000-0000-4000-8000-000000000002";
  let receipt: CalendarCommandReceipt | undefined,
    admissions: any[] = [],
    manualWrites = 0;
  const fullRun = {
    id: runId,
    engine: "hermes",
    workflow: "manage_calendar",
    state: "succeeded",
    instruction: "核对确认的日历计划",
    contextRefs: [],
    result: {
      evidence: "runtime",
      text: "已按来源回执核对",
      receipts: [
        {
          tool: "calendar.manage",
          state: "succeeded",
          observedResult: "matched",
        },
      ],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await page.route("**/api/models", (r) =>
    r.fulfill({
      json: [
        {
          id: modelId,
          name: "合成协议连接",
          model: "protocol-model",
          purpose: "chat",
          provider: "openai-compatible",
          scope: "personal",
          verifiedAt: null,
        },
      ],
    }),
  );
  await page.route("**/api/calendar/calendars", (r) =>
    r.fulfill({
      json: [
        {
          id: "personal",
          name: "合成日历",
          canRead: true,
          canCreate: true,
          canUpdate: true,
          canDelete: true,
        },
      ],
    }),
  );
  await page.route("**/api/calendar/query", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/calendar/commands", (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({ json: receipt ? [receipt] : [] });
    const plan = r.request().postDataJSON();
    receipt = {
      plan,
      id: "75000000-0000-4000-8000-000000000003",
      operation: "create",
      calendarId: "personal",
      objectId: "synthetic.ics",
      title: plan.draft.title,
      state: "prepared",
      error: null,
      stopRequested: false,
      sourceEtag: null,
      observedResult: null,
      acknowledgedAt: null,
      createdAt: new Date().toISOString(),
    };
    return r.fulfill({ json: receipt });
  });
  await page.route("**/api/calendar/commands/*/apply", (r) => {
    manualWrites++;
    return r.fulfill({
      status: 500,
      json: { message: "Unexpected manual write" },
    });
  });
  await page.route("**/api/calendar/runs", (r) => {
    admissions.push(r.request().postDataJSON());
    if (admissions.length === 1) return r.fulfill({ status: 503, body: "" });
    receipt!.sourceRunId = runId;
    receipt!.state = "succeeded";
    receipt!.observedResult = "matched";
    return r.fulfill({ json: fullRun });
  });
  await page.route("**/api/runs/" + runId, (r) => r.fulfill({ json: fullRun }));
  await page.route("**/api/runs/" + runId + "/history*", (r) =>
    r.fulfill({ json: { events: [], after: 0, hasMore: false } }),
  );
  const panel = await start(
    page,
    (view) => {
      for (const engine of ["dsh", "hermes"])
        view.engines[engine] = {
          configured: true,
          operations: ["manage_calendar"],
          modelProviders: ["openai-compatible"],
        };
    },
    () =>
      receipt?.sourceRunId
        ? [
            {
              id: runId,
              state: "succeeded",
              engine: "hermes",
              operation: "read",
              calendarId: "personal",
              createdAt: fullRun.createdAt,
            },
          ]
        : [],
  );
  await panel.getByLabel("日历", { exact: true }).selectOption("personal");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await panel
    .getByLabel("日历操作方式", { exact: true })
    .selectOption("hermes");
  await panel.getByLabel("日历模型连接", { exact: true }).selectOption(modelId);
  await panel.getByRole("button", { name: "新建日程", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建日程", exact: true });
  await dialog.getByLabel("日程标题", { exact: true }).fill("合成 AI 日历操作");
  await dialog
    .getByRole("button", { name: "确认并交给 AI", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("核对原操作");
  await dialog
    .getByRole("button", { name: "确认并交给 AI", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(admissions).toHaveLength(2);
  expect(admissions[0]).toEqual(admissions[1]);
  expect(admissions[0]).toMatchObject({
    engine: "hermes",
    modelProfileId: modelId,
    plan: { operation: "apply", commandId: receipt!.id, confirmed: true },
  });
  expect(manualWrites).toBe(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "查看 AI 执行", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/hyper-next-calendar-ai-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/hyper-next-calendar-ai-mobile.png" });
  await panel
    .getByRole("button", { name: "查看 AI 执行", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.reload();
  await page
    .getByRole("complementary", { name: "应用导航" })
    .getByRole("button", { name: "日历", exact: true })
    .click();
  await page
    .getByRole("region", { name: "本人日历执行历史", exact: true })
    .getByRole("button", { name: "查看执行", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.locator("vite-error-overlay").count()).toBe(0);
  expect(errors).toEqual([]);
});
test("Calendar desktop/mobile manual create and update use durable intents and render source receipts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      ["error", "warning"].includes(message.type()) &&
      !/^Failed to load resource:.*403/u.test(message.text())
    )
      errors.push(message.text());
  });
  const events: CalendarOccurrence[] = [],
    receipts: CalendarCommandReceipt[] = [];
  let prepared = 0,
    applied = 0,
    allowed = true;
  await page.route("**/api/calendar/calendars", (route) =>
    route.fulfill({
      json: allowed
        ? [
            {
              id: "personal",
              name: "个人日历",
              canRead: true,
              canCreate: true,
              canUpdate: true,
              canDelete: true,
            },
          ]
        : [],
      status: 200,
    }),
  );
  await page.route("**/api/calendar/query", (route) =>
    allowed
      ? route.fulfill({ json: events })
      : route.fulfill({ status: 403, json: { message: "日历访问已撤销。" } }),
  );
  await page.route("**/api/calendar/commands", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: receipts });
    const plan = route.request().postDataJSON() as CalendarCommandInput;
    const id = `60000000-0000-4000-8000-${String(++prepared).padStart(12, "0")}`;
    const receipt: CalendarCommandReceipt = {
      id,
      plan,
      operation: plan.operation,
      calendarId: plan.calendarId,
      objectId: plan.operation === "create" ? "new.ics" : plan.objectId,
      state: "prepared",
      title: plan.operation === "create" ? plan.draft.title : "所选日程",
      error: null,
      stopRequested: false,
      sourceEtag: null,
      observedResult: null,
      acknowledgedAt: null,
      createdAt: new Date().toISOString(),
    };
    receipts.unshift(receipt);
    return route.fulfill({ json: receipt });
  });
  await page.route("**/api/calendar/commands/*/apply", async (route) => {
    const receipt = receipts.find((r) => route.request().url().includes(r.id))!;
    expect(route.request().postDataJSON()).toEqual({ confirmed: true });
    applied++;
    if (receipt.plan.operation === "create")
      events.push({
        calendarId: "personal",
        objectId: receipt.objectId,
        etag: '"v1"',
        uid: receipt.id,
        recurrenceId: null,
        title: receipt.plan.draft.title,
        description: receipt.plan.draft.description,
        location: receipt.plan.draft.location,
        start: {
          kind: "instant",
          value: "2026-11-04T01:00:00.000Z",
          timeZone: "UTC",
        },
        end: {
          kind: "instant",
          value: "2026-11-04T02:00:00.000Z",
          timeZone: "UTC",
        },
        status: "confirmed",
        transparency: "opaque",
        truncatedFields: [],
      });
    if (receipt.plan.operation === "update")
      events[0]!.title = receipt.plan.patch.title!;
    receipt.state = "succeeded";
    receipt.observedResult = "matched";
    receipt.sourceEtag = '"v1"';
    receipt.acknowledgedAt = new Date().toISOString();
    return route.fulfill({ json: receipt });
  });
  const panel = await start(page);
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await panel.getByLabel("起始日期", { exact: true }).fill("2026-11-04");
  await panel.getByRole("button", { name: "新建日程", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建日程", exact: true });
  await dialog.getByLabel("日程标题", { exact: true }).fill("日历人工操作验收");
  await dialog.getByLabel("地点", { exact: true }).fill("会议室 A");
  await dialog
    .getByLabel("开始（本机时区）", { exact: true })
    .fill("2026-11-04T09:00");
  await dialog
    .getByLabel("结束（本机时区）", { exact: true })
    .fill("2026-11-04T10:00");
  await dialog.getByRole("button", { name: "保存日程", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "日历人工操作验收", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText("来源结果已核实", { exact: true }),
  ).toBeVisible();
  expect(prepared).toBe(1);
  expect(applied).toBe(1);
  await page.screenshot({
    path: "/tmp/hyper-next-calendar-desktop.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("button", { name: "修改", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "修改日程", exact: true });
  await edit.getByLabel("日程标题", { exact: true }).fill("修改后的日历成果");
  await edit.getByRole("button", { name: "保存日程", exact: true }).click();
  await expect(edit).not.toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "修改后的日历成果", exact: true }),
  ).toBeVisible();
  expect(prepared).toBe(2);
  expect(applied).toBe(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/hyper-next-calendar-mobile.png",
    fullPage: false,
  });
  allowed = false;
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    panel.getByRole("heading", { name: "修改后的日历成果", exact: true }),
  ).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("Calendar unknown outcome can only reconcile after refresh, without resending the source command", async ({
  page,
}) => {
  let applyCalls = 0,
    reconciliations = 0;
  const plan: CalendarCommandInput = {
    operation: "create",
    calendarId: "personal",
    idempotencyKey: "70000000-0000-4000-8000-000000000001",
    draft: {
      title: "等待核对的日程",
      description: "",
      location: "",
      interval: { kind: "all_day", start: "2026-11-04", end: "2026-11-05" },
    },
  };
  const receipt: CalendarCommandReceipt = {
    id: "70000000-0000-4000-8000-000000000002",
    plan,
    operation: "create",
    calendarId: "personal",
    objectId: "unknown.ics",
    state: "recovery_required",
    title: plan.draft.title,
    error: "calendar_delivery_unknown",
    stopRequested: false,
    sourceEtag: null,
    observedResult: null,
    acknowledgedAt: null,
    createdAt: new Date().toISOString(),
  };
  await page.route("**/api/calendar/calendars", (route) =>
    route.fulfill({
      json: [
        {
          id: "personal",
          name: "个人日历",
          canRead: true,
          canCreate: true,
          canUpdate: true,
          canDelete: true,
        },
      ],
    }),
  );
  await page.route("**/api/calendar/query", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/calendar/commands", (route) =>
    route.fulfill({ json: [receipt] }),
  );
  await page.route("**/api/calendar/commands/*/apply", (route) => {
    applyCalls++;
    return route.fulfill({ json: receipt });
  });
  await page.route("**/api/calendar/commands/*/reconcile", (route) => {
    reconciliations++;
    receipt.state = "succeeded";
    receipt.observedResult = "matched";
    receipt.error = null;
    return route.fulfill({ json: receipt });
  });
  const panel = await start(page);
  await expect(panel.getByText("结果待核对", { exact: true })).toBeVisible();
  await page.reload();
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "日历", exact: true })
    .click();
  await panel.getByRole("button", { name: "核对回执", exact: true }).click();
  await expect(
    panel.getByText("来源结果已核实", { exact: true }),
  ).toBeVisible();
  expect(reconciliations).toBe(1);
  expect(applyCalls).toBe(0);
});
