import { testOrigin } from "./origin";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
test("Usage shows actual provider counters and unknowns, supports private AI readback and rejects stale responses after denied reads", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    const url = message.location().url,
      text = message.text();
    if (
      (url.endsWith("/api/workspace") && text.includes("401")) ||
      (url.endsWith("/api/model-usage") && text.includes("403"))
    )
      return;
    errors.push(text);
  });
  const modelName = "usage-browser-" + randomUUID().slice(0, 6);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "OK" } }],
        ...(body.model === modelName
          ? {
              usage: {
                prompt_tokens: 5,
                completion_tokens: 3,
                total_tokens: 8,
              },
            }
          : {}),
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
    for (const model of [modelName, modelName + "-unknown"]) {
      const profile = await page.request.post("/api/models", {
        data: {
          name: model,
          provider: "openai-compatible",
          endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
          model,
          apiKey: "synthetic-browser-usage-key",
          purpose: "chat",
          scope: "personal",
        },
      });
      expect(profile.ok()).toBeTruthy();
      const id = (await profile.json()).id;
      expect(
        (
          await page.request.post(`/api/models/${id}/verify`, { data: {} })
        ).ok(),
      ).toBeTruthy();
    }
    await page
      .getByLabel("应用导航", { exact: true })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page.getByRole("tab", { name: "模型用量", exact: true }).click();
    const panel = page.getByRole("region", { name: "模型用量", exact: true });
    const known = panel
        .locator(".usage-row")
        .filter({ has: page.getByText(modelName, { exact: true }) }),
      unknown = panel.locator(".usage-row").filter({
        has: page.getByText(modelName + "-unknown", { exact: true }),
      });
    await expect(known).toContainText("输入 5 · 输出 3");
    await expect(unknown).toContainText("输入 未知 · 输出 未知");
    await expect(unknown).toContainText("用量未知");
    await panel.getByLabel("用量查询执行服务").selectOption("fixture");
    const admitted = page.waitForResponse(
      (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
    );
    await panel
      .getByRole("button", { name: "让 AI 回读本人用量", exact: true })
      .click();
    const run = await (await admitted).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/runs/" + run.id)).json()).state,
        { timeout: 20000 },
      )
      .toBe("succeeded");
    await expect(panel.getByRole("status")).toContainText("AI 已回读");
    const actual = await (await page.request.get("/api/runs/" + run.id)).json();
    expect(actual.result.receipts[0].summary.requests).toBeGreaterThanOrEqual(
      2,
    );
    expect(actual.result.receipts[0].summary.incomplete).toBeGreaterThanOrEqual(
      1,
    );
    expect(["not-configured", "estimates-and-declarations"]).toContain(
      actual.result.receipts[0].costStatus,
    );
    expect(Array.isArray(actual.result.receipts[0].costs)).toBeTruthy();
    await page.screenshot({
      path: testInfo.outputPath("model-usage-desktop.png"),
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      panel.getByRole("heading", { name: "模型用量", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: testInfo.outputPath("model-usage-mobile.png"),
      fullPage: false,
    });
    await page.setViewportSize({ width: 1504, height: 1045 });
    let release!: () => void;
    const delayed = new Promise<void>((r) => {
      release = r;
    });
    let reads = 0;
    await page.route("**/api/model-usage", async (route) => {
      reads++;
      if (reads === 1) {
        const previous = await route.fetch();
        await delayed;
        await route.fulfill({ response: previous });
      } else
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ message: "用量权限已撤销" }),
        });
    });
    await panel
      .getByRole("button", { name: "刷新用量记录", exact: true })
      .click();
    await expect.poll(() => reads).toBe(1);
    await panel
      .getByRole("button", { name: "刷新用量记录", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText("权限已撤销");
    release();
    await expect(panel.locator(".usage-row")).toHaveCount(0);
    await expect(panel.getByLabel("用量查询执行服务")).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(page.url()).toBe(testOrigin + "/");
    await expect(page).toHaveTitle(/Hyper Workspace/);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
