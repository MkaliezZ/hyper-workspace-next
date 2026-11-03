import { testOrigin } from "./origin";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("Work brief clarification, explicit confirmation, bound worker execution, AI revision and denied-read cleanup work on desktop/mobile", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (!["warning", "error"].includes(m.type())) return;
    const url = m.location().url,
      t = m.text();
    if (
      (url.endsWith("/api/workspace") && t.includes("401")) ||
      (url.includes("/work-briefs/") && t.includes("403"))
    )
      return;
    errors.push(t);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "进入演示工作区" }).click();
  await expect(
    page.getByRole("navigation", { name: "工作区导航", exact: true }),
  ).toBeVisible();
  const response = await page.request.post("/api/projects", {
    data: {
      name: "任务澄清 " + randomUUID().slice(0, 6),
      goal: "Synthetic work brief acceptance",
    },
  });
  expect(response.status()).toBe(201);
  const project = await response.json();
  await page.reload();
  await page
    .locator(".project-list")
    .getByRole("button", { name: project.name, exact: true })
    .click();
  await page.getByRole("tab", { name: "任务说明", exact: true }).click();
  const panel = page.getByRole("region", { name: "任务说明", exact: true });
  for (const [name, value] of [
    ["说明标题", "发布说明草稿"],
    ["工作目标", "编写可修改的内部发布说明"],
    ["工作范围", "仅当前项目的已授权记录"],
    ["约束条件", "不自动发送到外部"],
    ["完成标准", "有来源引用和可回读的成果对象"],
    ["待澄清问题（每行一个）", "交付对象是谁？"],
  ])
    await panel.getByRole("textbox", { name, exact: true }).fill(value);
  await panel
    .getByRole("button", { name: "保存说明草稿", exact: true })
    .click();
  await expect(panel).toContainText("当前版本 1");
  await expect(
    panel.getByRole("checkbox", { name: /我已检查保存的当前版本/ }),
  ).toBeDisabled();
  const list = await (
    await page.request.get("/api/projects/" + project.id + "/work-briefs")
  ).json();
  expect(list).toHaveLength(1);
  const brief = list[0];
  const early = await page.request.post("/api/runs", {
    data: {
      conversationId: project.conversationId,
      workflow: "discussion_to_minutes",
      engine: "fixture",
      instruction: "Do not execute an unconfirmed brief",
      briefRef: { id: brief.id, version: 1 },
      idempotencyKey: randomUUID(),
    },
  });
  expect(early.status()).toBe(409);
  await panel
    .getByRole("textbox", { name: "回答：交付对象是谁？", exact: true })
    .fill("公司内部产品团队");
  await panel
    .getByRole("button", { name: "保存澄清回答", exact: true })
    .click();
  await expect(panel).toContainText("当前版本 2");
  await panel.getByRole("checkbox", { name: /我已检查保存的当前版本/ }).check();
  await panel
    .getByRole("button", { name: "确认当前说明", exact: true })
    .click();
  await expect(panel).toContainText("当前版本 3 · 已确认");
  await page.screenshot({
    path: testInfo.outputPath("work-brief-desktop.png"),
    fullPage: true,
  });
  await panel
    .getByRole("button", { name: "按此说明发起任务", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "让 AI 帮你推进工作" });
  await expect(dialog).toContainText("绑定任务说明版本 v3");
  await dialog
    .getByRole("combobox", { name: "执行服务", exact: true })
    .selectOption("fixture");
  await dialog.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get("/api/workspace?projectId=" + project.id)
          ).json()
        ).artifacts.length,
      { timeout: 20000 },
    )
    .toBe(1);
  const work = await (
    await page.request.get("/api/workspace?projectId=" + project.id)
  ).json();
  expect(work.artifacts[0].content).toContain("公司内部产品团队");
  await panel
    .getByRole("combobox", { name: "说明操作方式", exact: true })
    .selectOption("ai");
  await panel
    .getByRole("combobox", { name: "说明执行服务", exact: true })
    .selectOption("fixture");
  await panel
    .getByRole("textbox", { name: "工作目标", exact: true })
    .fill("人工未保存的目标应保留");
  await panel
    .getByRole("button", { name: "AI 整理说明草稿", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "读取保存结果", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    panel.getByRole("textbox", { name: "工作目标", exact: true }),
  ).toHaveValue("人工未保存的目标应保留");
  await panel
    .getByRole("button", { name: "读取保存结果", exact: true })
    .click();
  await expect(panel).toContainText("当前版本 4 · 待补充澄清");
  await expect(
    panel.getByRole("button", { name: "按此说明发起任务", exact: true }),
  ).toHaveCount(0);
  const stale = await page.request.post("/api/runs", {
    data: {
      conversationId: project.conversationId,
      workflow: "discussion_to_minutes",
      engine: "fixture",
      instruction: "Old version must not execute",
      briefRef: { id: brief.id, version: 3 },
      idempotencyKey: randomUUID(),
    },
  });
  expect(stale.status()).toBe(409);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("work-brief-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await expect(
    panel.getByRole("textbox", { name: "工作目标", exact: true }),
  ).toBeVisible();
  const path = "/api/projects/" + project.id + "/work-briefs/" + brief.id;
  const cached = await (await page.request.get(path)).json();
  let release = () => {},
    seen = () => {},
    count = 0;
  const arrived = new Promise<void>((r) => (seen = r)),
    delay = new Promise<void>((r) => (release = r));
  await page.route("**" + path, async (route) => {
    count++;
    if (count === 1) {
      seen();
      await delay;
      await route.fulfill({ json: cached });
    } else
      await route.fulfill({
        status: 403,
        json: { message: "Synthetic brief scope revoked" },
      });
  });
  await panel
    .getByRole("button", { name: "重新读取说明", exact: true })
    .click();
  await arrived;
  await panel
    .getByRole("button", { name: "重新读取说明", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("scope revoked");
  release();
  await expect(
    panel
      .getByRole("combobox", { name: "已有任务说明", exact: true })
      .locator("option"),
  ).toHaveCount(1);
  await expect(
    panel.getByRole("textbox", { name: "工作目标", exact: true }),
  ).toHaveValue("");
  await expect(panel).not.toContainText("演示任务说明");
  expect(page.url()).toBe(testOrigin + "/");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});
