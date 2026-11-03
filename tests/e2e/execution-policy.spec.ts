import { testOrigin } from "./origin";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("Execution rules show effective scope, save directly or through AI, reject stale changes and apply task limits", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "进入演示工作区" }).click();
  await expect(
    page.getByRole("heading", { name: "产品共创", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const name = "执行规则验证 " + randomUUID().slice(0, 6);
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page
    .getByLabel("当前目标", { exact: true })
    .fill("合成项目：验证规则范围与回执");
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/projects") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const project = await (await created).json();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page
    .getByLabel("应用导航", { exact: true })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page.getByRole("tab", { name: "执行规则", exact: true }).click();
  const panel = page.getByRole("region", { name: "执行规则", exact: true });
  await expect(panel.getByLabel("规则范围")).toBeVisible();
  await panel.getByLabel("规则范围").selectOption("project");
  await panel.getByLabel("业务动作上限", { exact: true }).fill("4");
  await expect(
    panel.getByRole("button", { name: "保存执行规则", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("checkbox", { name: /我已核对/ }).check();
  await panel
    .getByRole("button", { name: "保存执行规则", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("执行规则已保存");
  await expect(panel).toContainText("当前版本：1");
  await expect(panel).toContainText("4 个业务动作");
  await panel.getByLabel("业务动作上限", { exact: true }).fill("2");
  await panel.getByLabel("保存方式").selectOption("ai");
  await panel.getByLabel("规则执行服务").selectOption("fixture");
  await panel.getByRole("checkbox", { name: /我已核对/ }).check();
  const admitted = page.waitForResponse(
    (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "发起 AI 规则配置", exact: true })
    .click();
  const run = await (await admitted).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/runs/" + run.id)).json()).state,
      { timeout: 20000 },
    )
    .toBe("succeeded");
  await expect(panel).toContainText("当前版本：2");
  await expect(panel).toContainText("2 个业务动作");
  const result = await (await page.request.get("/api/runs/" + run.id)).json();
  expect(result.result.receipts[0]).toMatchObject({
    scope: "project",
    revision: 2,
    rules: { maxActions: 2 },
  });
  const stale = await page.request.post(
    `/api/projects/${project.id}/execution-policy`,
    {
      data: {
        scope: "project",
        expectedRevision: 1,
        rules: { maxActions: 8 },
        confirmed: true,
        idempotencyKey: randomUUID(),
      },
    },
  );
  expect(stale.status()).toBe(409);
  await page.screenshot({
    path: testInfo.outputPath("execution-policy-desktop.png"),
    fullPage: false,
  });
  await testInfo.attach("execution-policy-desktop", {
    path: testInfo.outputPath("execution-policy-desktop.png"),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByLabel("规则范围")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("execution-policy-mobile.png"),
    fullPage: false,
  });
  await testInfo.attach("execution-policy-mobile", {
    path: testInfo.outputPath("execution-policy-mobile.png"),
    contentType: "image/png",
  });
  await page.setViewportSize({ width: 1504, height: 1045 });
  await page.getByRole("button", { name: "发起任务", exact: true }).click();
  await page
    .getByRole("combobox", { name: "执行服务", exact: true })
    .selectOption("fixture");
  await page.getByText("本次执行限制", { exact: true }).click();
  await page.getByLabel("本次动作上限", { exact: true }).fill("0");
  const bounded = page.waitForResponse(
    (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  const task = await (await bounded).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/runs/" + task.id)).json()).state,
      { timeout: 20000 },
    )
    .toBe("failed");
  expect(
    (await (await page.request.get("/api/runs/" + task.id)).json()).error,
  ).toContain("动作数量");
  expect(errors).toEqual([]);
  expect(page.url()).toBe(testOrigin + "/");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});
