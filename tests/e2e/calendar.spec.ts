import { test, expect, type Page } from "@playwright/test";
import type {
  CalendarCommandInput,
  CalendarCommandReceipt,
  CalendarLinkChange,
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
  await page.route("**/api/calendar/series-rule", (route) =>
    route.fulfill({
      json: {
        rules: ["FREQ=WEEKLY;COUNT=3"],
        simple: { frequency: "WEEKLY", interval: 1, count: 3 },
        exceptionCount: 1,
      },
    }),
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
      objectId: plan.operation === "create" ? id + ".ics" : plan.objectId,
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
    const plan = receipt.plan;
    if (plan.operation === "update") {
      if (plan.scope === "series") events[0]!.title = plan.patch.title!;
      else if (plan.scope === "occurrence") {
        const index = events.findIndex(
          (event) =>
            event.objectId === plan.objectId &&
            event.recurrenceId === plan.target.recurrenceId,
        );
        expect(index).toBeGreaterThanOrEqual(0);
        if (plan.change.operation === "cancel") events.splice(index, 1);
        else {
          const event = events[index]!;
          event.title = plan.change.patch.title!;
          event.etag = '"v2"';
        }
      }
    }
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
  events.push(
    {
      ...events[0]!,
      objectId: "weekly.ics",
      recurrenceId: "2026-11-04T01:00:00Z",
      title: "重复日程第一场",
    },
    {
      ...events[0]!,
      objectId: "weekly.ics",
      recurrenceId: "2026-11-05T01:00:00Z",
      title: "重复日程第二场",
      start: {
        kind: "instant",
        value: "2026-11-05T01:00:00.000Z",
        timeZone: "UTC",
      },
      end: {
        kind: "instant",
        value: "2026-11-05T02:00:00.000Z",
        timeZone: "UTC",
      },
    },
  );
  await panel.getByRole("button", { name: "刷新", exact: true }).click();
  const recurring = (name: string) =>
    panel
      .locator(".calendar-event")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
  await recurring("重复日程第一场")
    .getByRole("button", { name: "修改本次", exact: true })
    .click();
  const one = page.getByRole("dialog", {
    name: "修改本次重复日程",
    exact: true,
  });
  await one.getByLabel("日程标题", { exact: true }).fill("仅本次更新");
  await one.getByRole("button", { name: "保存日程", exact: true }).click();
  await expect(one).not.toBeVisible();
  expect(receipts[0]?.plan).toMatchObject({
    operation: "update",
    scope: "occurrence",
    etag: '"v1"',
    target: { recurrenceId: "2026-11-04T01:00:00Z" },
    change: { operation: "edit", patch: { title: "仅本次更新" } },
  });
  await recurring("仅本次更新")
    .getByRole("button", { name: "取消本次", exact: true })
    .click();
  const cancelOne = page.getByRole("dialog", {
    name: "取消本次重复日程",
    exact: true,
  });
  await cancelOne
    .getByRole("button", { name: "确认取消本次", exact: true })
    .click();
  await expect(cancelOne).not.toBeVisible();
  expect(receipts[0]?.plan).toMatchObject({
    operation: "update",
    scope: "occurrence",
    etag: '"v2"',
    target: { recurrenceId: "2026-11-04T01:00:00Z" },
    change: { operation: "cancel" },
  });
  await expect(recurring("仅本次更新")).toHaveCount(0);
  await expect(recurring("重复日程第二场")).toBeVisible();
  await recurring("重复日程第二场")
    .getByRole("button", { name: "调整重复规则", exact: true })
    .click();
  const ruleForm = page.getByRole("dialog", {
    name: "调整整组重复规则",
    exact: true,
  });
  await expect(ruleForm.getByText(/已有单次例外 1 条/)).toBeVisible();
  await ruleForm.getByLabel("重复总次数（含首次）", { exact: true }).fill("4");
  await ruleForm
    .getByRole("button", { name: "确认修改重复规则", exact: true })
    .click();
  await expect(ruleForm).not.toBeVisible();
  expect(receipts[0]?.plan).toMatchObject({
    operation: "update",
    scope: "series_rule",
    repeat: { frequency: "WEEKLY", interval: 1, count: 4 },
  });

  await panel.getByRole("button", { name: "新建日程", exact: true }).click();
  await dialog
    .getByLabel("日程标题", { exact: true })
    .fill("指定时区的重复日程");
  await dialog.getByLabel("重复规则", { exact: true }).selectOption("WEEKLY");
  await dialog.getByLabel("日程时区", { exact: true }).fill("America/New_York");
  await dialog.getByLabel("重复总次数（含首次）", { exact: true }).fill("3");
  await dialog
    .getByLabel("开始（指定时区）", { exact: true })
    .fill("2027-03-07T09:00");
  await dialog
    .getByLabel("结束（指定时区）", { exact: true })
    .fill("2027-03-07T10:00");
  await page.screenshot({
    path: "/tmp/hyper-next-calendar-recurrence-mobile.png",
  });
  await dialog.getByRole("button", { name: "保存日程", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(receipts[0]?.plan).toMatchObject({
    operation: "create",
    draft: {
      title: "指定时区的重复日程",
      repeat: { frequency: "WEEKLY", interval: 1, count: 3 },
      interval: {
        kind: "zoned",
        timeZone: "America/New_York",
        start: "2027-03-07T09:00:00",
        end: "2027-03-07T10:00:00",
      },
    },
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

test("Calendar discovery and editing remain available while private history is slow", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
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
  await page.route("**/api/calendar/commands", async (r) => {
    await pending;
    await r.fulfill({ json: [] }).catch(() => {});
  });
  try {
    const panel = await start(page);
    await expect(panel.getByLabel("日历", { exact: true })).toHaveValue(
      "personal",
    );
    await panel.getByRole("button", { name: "新建日程", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "新建日程", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .last()
      .click();
  } finally {
    release();
  }
});

test("Availability results stay private, show source-based candidates and are reopened from AI receipts on mobile", async ({
  page,
}) => {
  const modelId = "76000000-0000-4000-8000-000000000001",
    runId = "76000000-0000-4000-8000-000000000002";
  let writes = 0,
    plan: any,
    result: any;
  const fullRun = () => ({
    id: runId,
    engine: "hermes",
    workflow: "manage_calendar",
    state: "succeeded",
    contextRefs: [],
    instruction: "核对选择的排期条件",
    result: {
      text: "已核对来源快照",
      evidence: "runtime",
      receipts: [
        {
          tool: "calendar.manage",
          state: "succeeded",
          operation: "availability",
          availability: result,
        },
      ],
    },
  });
  const response = (body: any) => ({
    state: "evaluated",
    timeZone: body.timeZone,
    window: { start: body.start, end: body.end },
    checkedAt: "2026-11-04T00:00:00Z",
    busy: [
      {
        start: "2026-11-04T01:00:00Z",
        end: "2026-11-04T02:00:00Z",
        event: {
          calendarId: "personal",
          objectId: "synthetic.ics",
          recurrenceId: null,
          etag: '"v1"',
        },
        tentative: false,
      },
    ],
    conflicts: [],
    conflictsTruncated: false,
    unknown: [],
    candidates: [
      { start: "2026-11-04T02:00:00Z", end: "2026-11-04T03:00:00Z" },
      { start: "2026-11-04T03:00:00Z", end: "2026-11-04T04:00:00Z" },
    ],
    candidateLimit: 20,
    skippedWindows: [],
    reservation: false,
    observations: [
      {
        calendarId: "personal",
        timeZoneId: null,
        objects: [{ objectId: "synthetic.ics", etag: '"v1"' }],
      },
    ],
  });
  await page.route("**/api/models", (r) =>
    r.fulfill({
      json: [
        {
          id: modelId,
          name: "排期协议连接",
          model: "protocol-model",
          purpose: "chat",
          provider: "openai-compatible",
          scope: "personal",
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
    if (r.request().method() !== "GET") writes++;
    return r.fulfill({ json: [] });
  });
  await page.route("**/api/calendar/availability", (r) => {
    result = response(r.request().postDataJSON());
    return r.fulfill({ json: result });
  });
  await page.route("**/api/calendar/runs", (r) => {
    plan = r.request().postDataJSON();
    result = response(plan.plan.query);
    return r.fulfill({ json: fullRun() });
  });
  await page.route("**/api/runs/" + runId, (r) =>
    r.fulfill({ json: fullRun() }),
  );
  await page.route("**/api/runs/" + runId + "/history*", (r) =>
    r.fulfill({ json: { events: [], after: 0, hasMore: false } }),
  );
  const panel = await start(page, (view) => {
    view.engines.hermes = {
      configured: true,
      operations: ["manage_calendar"],
      modelProviders: ["openai-compatible"],
    };
  });
  await panel.getByLabel("起始日期", { exact: true }).fill("2026-11-04");
  const planner = panel.getByRole("region", {
    name: "忙闲与候选时段",
    exact: true,
  });
  await planner.getByLabel("排期时区", { exact: true }).fill("Asia/Shanghai");
  await planner
    .getByRole("button", { name: "查询忙闲与候选", exact: true })
    .click();
  await expect(planner.getByText(/1 段占用/)).toBeVisible();
  await expect(planner.locator(".calendar-slots li")).toHaveCount(2);
  await planner.screenshot({
    path: "/tmp/hyper-next-calendar-availability-desktop.png",
  });
  await panel
    .getByLabel("日历操作方式", { exact: true })
    .selectOption("hermes");
  await panel.getByLabel("日历模型连接", { exact: true }).selectOption(modelId);
  await planner
    .getByRole("button", { name: "由 AI 核对排期", exact: true })
    .click();
  const details = page.getByRole("dialog");
  await expect(details.locator(".calendar-slots li")).toHaveCount(2);
  expect(plan).toMatchObject({
    engine: "hermes",
    modelProfileId: modelId,
    plan: {
      operation: "availability",
      query: { calendarIds: ["personal"], timeZone: "Asia/Shanghai" },
    },
  });
  expect(writes).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(details.getByText(/尚未预订或发送邀请/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/hyper-next-calendar-availability-mobile.png",
  });
});

test("A permission denial aborts delayed history so stale private commands cannot reappear", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
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
  await page.route("**/api/calendar/availability", (r) =>
    r.fulfill({ status: 403, json: { message: "日历权限已撤销。" } }),
  );
  await page.route("**/api/calendar/commands", async (r) => {
    await pending;
    await r
      .fulfill({
        json: [
          {
            title: "不应恢复的私有操作",
            state: "prepared",
            createdAt: "2026-11-04T00:00:00Z",
          },
        ],
      })
      .catch(() => {});
  });
  try {
    const panel = await start(page);
    await panel
      .getByRole("region", { name: "忙闲与候选时段", exact: true })
      .getByRole("button", { name: "查询忙闲与候选", exact: true })
      .click();
    await expect(
      panel.getByRole("region", { name: "忙闲与候选时段", exact: true }),
    ).not.toBeVisible();
    release();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      panel.getByText("不应恢复的私有操作", { exact: true }),
    ).not.toBeVisible();
    await expect(
      panel.getByLabel("日历", { exact: true }).locator("option"),
    ).toHaveCount(1);
  } finally {
    release();
  }
});

test("A mobile employee selects exact invitees and sees separately reported delivery and response", async ({
  page,
}) => {
  await page.route("**/api/organization?**", (route) =>
    route.fulfill({
      json: { rows: [{ uid: "bob", name: "鲍明" }], nextOffset: null },
    }),
  );
  await page.route("**/api/calendar/calendars", (route) =>
    route.fulfill({
      json: [
        {
          id: "personal",
          name: "个人日历",
          canRead: true,
          canCreate: true,
          canInvite: true,
          canUpdate: true,
          canDelete: true,
        },
      ],
    }),
  );
  await page.route("**/api/calendar/query", (route) =>
    route.fulfill({ json: [] }),
  );
  const id = "76000000-0000-4000-8000-000000000001";
  let receipt: CalendarCommandReceipt | undefined;
  let applied = 0;
  await page.route("**/api/calendar/commands", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: receipt ? [receipt] : [] });
    const plan = route.request().postDataJSON() as CalendarCommandInput;
    expect(plan).toMatchObject({
      operation: "create",
      invitees: ["bob"],
      draft: { title: "合成会议排期" },
    });
    receipt = {
      id,
      calendarId: "personal",
      objectId: "meeting.ics",
      title: "合成会议排期",
      operation: "create",
      plan,
      state: "prepared",
      error: null,
      stopRequested: false,
      sourceEtag: null,
      observedResult: null,
      acknowledgedAt: null,
      createdAt: new Date().toISOString(),
    };
    return route.fulfill({ json: receipt });
  });
  await page.route("**/api/calendar/commands/" + id + "/apply", (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirmed: true });
    applied++;
    receipt = {
      ...receipt!,
      state: "succeeded",
      observedResult: "matched",
      sourceEtag: '"v2"',
      invitations: [
        {
          employeeUid: "bob",
          delivery: "unreported",
          response: "needs_action",
        },
      ],
    };
    return route.fulfill({ json: receipt });
  });
  const panel = await start(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("button", { name: "新建日程", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建日程", exact: true });
  await dialog.getByLabel("日程标题", { exact: true }).fill("合成会议排期");
  await dialog
    .getByRole("button", { name: "选择参会员工", exact: true })
    .click();
  await dialog.getByLabel("搜索员工", { exact: true }).fill("bob");
  await dialog.getByRole("button", { name: "鲍明 · bob", exact: true }).click();
  await expect(
    dialog.getByRole("list", { name: "已选参会员工" }),
  ).toContainText("鲍明 · bob");
  await dialog
    .getByRole("button", { name: "收起员工目录", exact: true })
    .click();
  expect(applied).toBe(0);
  await dialog
    .getByRole("button", { name: "创建会议并邀请", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const facts = panel.getByRole("list", { name: "参会邀请状态" });
  await expect(facts).toContainText("bob · 来源未报告送达 · 待回复");
  expect(applied).toBe(1);
  await facts.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/hyper-next-calendar-invitation-mobile.png",
  });
});

test("Candidate booking keeps the confirmed slot and guides a requery when the source fills it", async ({
  page,
}) => {
  const slot = { start: "2026-11-04T02:00:00Z", end: "2026-11-04T03:00:00Z" };
  const id = "77000000-0000-4000-8000-000000000001";
  let receipt: CalendarCommandReceipt | undefined;
  let applies = 0;
  await page.route("**/api/calendar/calendars", (route) =>
    route.fulfill({
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
  await page.route("**/api/calendar/query", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/calendar/availability", (route) => {
    const query = route.request().postDataJSON();
    return route.fulfill({
      json: {
        state: "evaluated",
        timeZone: query.timeZone,
        checkedAt: "2026-11-04T00:00:00Z",
        window: { start: query.start, end: query.end },
        busy: [],
        conflicts: [],
        conflictsTruncated: false,
        unknown: [],
        candidates: [slot],
        candidateLimit: 20,
        skippedWindows: [],
        reservation: false,
        observations: [],
      },
    });
  });
  await page.route("**/api/calendar/commands", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: receipt ? [receipt] : [] });
    const plan = route.request().postDataJSON() as CalendarCommandInput;
    expect(plan).toMatchObject({
      operation: "create",
      booking: { calendarIds: ["personal"], timeZone: "Asia/Shanghai" },
      draft: { title: "候选时段验收", interval: { kind: "timed", ...slot } },
    });
    receipt = {
      id,
      calendarId: "personal",
      objectId: "candidate.ics",
      title: "候选时段验收",
      operation: "create",
      plan,
      state: "prepared",
      error: null,
      stopRequested: false,
      sourceEtag: null,
      observedResult: null,
      acknowledgedAt: null,
      createdAt: new Date().toISOString(),
    };
    return route.fulfill({ json: receipt });
  });
  await page.route("**/api/calendar/commands/" + id + "/apply", (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirmed: true });
    applies++;
    receipt = {
      ...receipt!,
      state: "failed",
      error: "calendar_slot_no_longer_available",
    };
    return route.fulfill({ json: receipt });
  });
  const panel = await start(page);
  await panel.getByLabel("起始日期", { exact: true }).fill("2026-11-04");
  const planner = panel.getByRole("region", {
    name: "忙闲与候选时段",
    exact: true,
  });
  await planner.getByLabel("排期时区", { exact: true }).fill("Asia/Shanghai");
  await planner
    .getByRole("button", { name: "查询忙闲与候选", exact: true })
    .click();
  await planner
    .getByRole("button", { name: "用此时段新建", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "新建日程", exact: true });
  await expect(editor.getByText(/所选候选时段.*Asia\/Shanghai/)).toBeVisible();
  await expect(editor.getByLabel("重复规则", { exact: true })).toHaveCount(0);
  await expect(
    editor.getByLabel("开始（本机时区）", { exact: true }),
  ).toHaveCount(0);
  await editor.getByLabel("日程标题", { exact: true }).fill("候选时段验收");
  expect(applies).toBe(0);
  await page.screenshot({
    path: "/tmp/hyper-next-calendar-booking-desktop.png",
  });
  await editor
    .getByRole("button", { name: "确认预约并复核时段", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText(
    "请关闭并重新查询候选时段",
  );
  await expect(
    editor.getByRole("button", { name: "确认预约并复核时段", exact: true }),
  ).toBeDisabled();
  expect(applies).toBe(1);
});

test("Calendar links a task on mobile, retries a lost receipt and removes the private link", async ({
  page,
}) => {
  const event = {
    calendarId: "personal",
    objectId: "synthetic-link.ics",
    etag: '"v3"',
  };
  const taskId = "79000000-0000-4000-8000-000000000001";
  const requests: CalendarLinkChange[] = [];
  let current: CalendarLinkChange | null = null;
  await page.route("**/api/calendar/calendars", (route) =>
    route.fulfill({
      json: [{ id: "personal", name: "合成日历", canRead: true }],
    }),
  );
  await page.route("**/api/calendar/commands", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/calendar/query", (route) =>
    route.fulfill({
      json: [
        {
          ...event,
          uid: "synthetic-link",
          recurrenceId: null,
          title: "项目里程碑排期",
          description: "",
          location: "",
          start: { kind: "date", value: "2026-11-04" },
          end: { kind: "date", value: "2026-11-05" },
          status: "confirmed",
          transparency: "opaque",
          truncatedFields: [],
        } satisfies CalendarOccurrence,
      ],
    }),
  );
  await page.route("**/api/calendar/links/query", (route) => {
    expect(route.request().postDataJSON()).toEqual(event);
    return route.fulfill({
      json: current?.linked
        ? [{ target: current.target, label: "核对里程碑" }]
        : [],
    });
  });
  await page.route("**/api/calendar/links/change", (route) => {
    const input = route.request().postDataJSON() as CalendarLinkChange;
    expect(input).toMatchObject({
      event,
      confirmed: true,
      target: { kind: "task", taskId, taskVersion: 2 },
    });
    requests.push(input);
    current = input;
    if (requests.length === 1)
      return route.fulfill({
        status: 502,
        json: { message: "暂时无法取得操作回执。" },
      });
    return route.fulfill({
      json: {
        id: input.idempotencyKey,
        linked: input.linked,
        target: input.target,
        sourceEtag: event.etag,
        recordedAt: "2026-11-04T00:00:00Z",
      },
    });
  });
  const panel = await start(page, (view) => {
    view.tasks = [
      { id: taskId, title: "核对里程碑", version: 2, status: "open" },
    ];
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByLabel("起始日期", { exact: true }).fill("2026-11-04");
  await panel
    .getByRole("button", { name: "关联项目与待办", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "关联项目与待办",
    exact: true,
  });
  await dialog.getByRole("combobox", { name: "关联待办" }).selectOption(taskId);
  const save = dialog.getByRole("button", {
    name: "确认保存关联",
    exact: true,
  });
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("暂时无法取得操作回执");
  await save.click();
  await expect(dialog.getByRole("status")).toHaveText("关联已保存");
  await expect(
    dialog.getByText("待办 · 核对里程碑", { exact: true }),
  ).toBeVisible();
  expect(requests[0]).toEqual(requests[1]);
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/hyper-next-calendar-link-mobile.png" });
  await dialog.getByRole("button", { name: "确认移除", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("关联已移除");
  await expect(
    dialog.getByText("暂无可访问的关联。", { exact: true }),
  ).toBeVisible();
  expect(requests[2]?.idempotencyKey).not.toBe(requests[0]?.idempotencyKey);
});
