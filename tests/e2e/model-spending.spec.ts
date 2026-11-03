import { testOrigin } from "./origin";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
test("Versioned prices, unknown-charge review, real request admission and AI budget edits work on desktop and mobile", async ({
  page,
}, testInfo) => {
  let missing = false,
    calls = 0;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    const url = message.location().url,
      text = message.text();
    if (
      (url.endsWith("/api/workspace") && text.includes("401")) ||
      (url.includes("/api/model-spending?") && text.includes("403"))
    )
      return;
    errors.push(text);
  });
  const server = createServer(async (req, res) => {
    for await (const c of req) {
    }
    calls++;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "OK" } }],
        ...(missing
          ? {}
          : {
              usage: {
                prompt_tokens: 1000,
                completion_tokens: 1000,
                total_tokens: 2000,
              },
            }),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "进入演示工作区" }).click();
    await expect(
      page.getByRole("heading", { name: "产品共创", exact: true }),
    ).toBeVisible();
    const created = await page.request.post("/api/models", {
      data: {
        name: "费用合成验收 " + randomUUID().slice(0, 6),
        provider: "openai-compatible",
        endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        model: "finance-browser-fixture",
        apiKey: "synthetic-budget-key",
        purpose: "chat",
        scope: "personal",
      },
    });
    expect(created.ok()).toBeTruthy();
    const profile = await created.json();
    const verify = () =>
      page.request.post(`/api/models/${profile.id}/verify`, { data: {} });
    await page
      .getByLabel("应用导航", { exact: true })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page.getByRole("tab", { name: "价格与预算", exact: true }).click();
    const panel = page.getByRole("region", { name: "价格与预算", exact: true });
    await panel
      .getByLabel("费用账户", { exact: true })
      .selectOption(profile.id);
    await expect(
      panel.getByLabel("普通输入单价 / 百万 token", { exact: true }),
    ).toBeVisible();
    for (const [name, value] of [
      ["普通输入单价 / 百万 token", "1"],
      ["输出单价 / 百万 token", "2"],
      ["缓存读取单价 / 百万 token", "1"],
      ["缓存写入单价 / 百万 token", "1"],
      ["每日预算上限", "0.01"],
      ["每请求预留金额", "0.005"],
      ["计价依据", "合成固定单价，只验证金额计算，不是供应商价格"],
    ])
      await panel.getByLabel(name, { exact: true }).fill(value);
    await expect(
      panel.getByRole("button", { name: "保存价格与预算", exact: true }),
    ).toBeDisabled();
    await panel.getByRole("checkbox", { name: /我已核对账户/ }).check();
    await panel
      .getByRole("button", { name: "保存价格与预算", exact: true })
      .click();
    await expect(panel).toContainText("配置版本 1");
    expect((await verify()).ok()).toBeTruthy();
    missing = true;
    expect((await verify()).ok()).toBeTruthy();
    const denied = await verify();
    expect(denied.status()).toBe(400);
    expect((await denied.json()).message).toContain("未知");
    expect(calls).toBe(2);
    await panel
      .getByRole("button", { name: "重新读取费用账户", exact: true })
      .click();
    await expect(panel).toContainText("未知 1");
    const unknown = panel
      .locator(".usage-row")
      .filter({ has: page.getByText("费用未知 · 需核对", { exact: true }) });
    await unknown
      .getByRole("button", { name: "核对请求费用", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "核对请求费用",
      exact: true,
    });
    await dialog.getByLabel("核对金额", { exact: true }).fill("0.004");
    await dialog
      .getByLabel("核对依据", { exact: true })
      .fill("合成员工核对声明 0.004 CNY，不代表系统验证的账单。");
    await dialog.getByRole("checkbox", { name: /我确认金额和依据/ }).check();
    await dialog
      .getByRole("button", { name: "保存费用核对", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(panel).toContainText("已估算/声明 0.007");
    await expect(panel).toContainText("未知 0");
    await panel.getByLabel("每日预算上限", { exact: true }).fill("0.02");
    await panel
      .getByRole("combobox", { name: "费用保存方式", exact: true })
      .selectOption("ai");
    await panel
      .getByRole("combobox", { name: "费用执行服务", exact: true })
      .selectOption("fixture");
    await panel.getByRole("checkbox", { name: /我已核对账户/ }).check();
    const admitted = page.waitForResponse(
      (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
    );
    await panel
      .getByRole("button", { name: "让 AI 保存费用配置", exact: true })
      .click();
    const run = await (await admitted).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/runs/" + run.id)).json()).state,
        { timeout: 20000 },
      )
      .toBe("succeeded");
    await expect(panel).toContainText("配置版本 2");
    missing = false;
    expect((await verify()).ok()).toBeTruthy();
    await panel
      .getByRole("button", { name: "重新读取费用账户", exact: true })
      .click();
    await expect(panel).toContainText("已估算/声明 0.01");
    const view = await (
      await page.request.get(`/api/model-spending?modelProfileId=${profile.id}`)
    ).json();
    const latest = view.rows[0].requests.find(
      (r: any) => r.estimate === "0.003",
    );
    expect(latest).toBeTruthy();
    await page.screenshot({
      path: testInfo.outputPath("model-spending-desktop.png"),
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByLabel("费用账户", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: testInfo.outputPath("model-spending-mobile.png"),
      fullPage: false,
    });
    await page.setViewportSize({ width: 1504, height: 1045 });
    let release!: () => void,
      reads = 0;
    const delayed = new Promise<void>((r) => {
      release = r;
    });
    await page.route("**/api/model-spending**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      reads++;
      if (reads === 1) {
        const previous = await route.fetch();
        await delayed;
        await route.fulfill({ response: previous });
      } else
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ message: "费用管理权限已撤销" }),
        });
    });
    await panel
      .getByRole("button", { name: "重新读取费用账户", exact: true })
      .click();
    await expect.poll(() => reads).toBe(1);
    await panel
      .getByRole("button", { name: "重新读取费用账户", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText("权限已撤销");
    release();
    await expect(panel.getByLabel("计价依据", { exact: true })).toHaveCount(0);
    await expect(panel.locator(".usage-row")).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(page.url()).toBe(testOrigin + "/");
    await expect(page).toHaveTitle(/Hyper Workspace/);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
