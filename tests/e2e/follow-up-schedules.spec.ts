import { testOrigin } from "./origin";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function project(page: Page, name: string) {
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page
    .getByLabel("当前目标", { exact: true })
    .fill("演示有限次数的定时跟进");
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/projects") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const saved = await (await response).json();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return saved;
}
test("Finite schedules run through the worker and share direct and AI pause/resume/cancel controls", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  let authenticated = false;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      !authenticated &&
      m.location().url.endsWith("/api/workspace") &&
      m.text().includes("401")
    )
      return;
    if (["error", "warning"].includes(m.type())) errors.push(m.text());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "进入演示工作区" }).click();
  await expect(
    page.getByRole("heading", { name: "产品共创", exact: true }),
  ).toBeVisible();
  authenticated = true;
  const saved = await project(page, "跟进调度 " + randomUUID().slice(0, 6));
  const path = "/api/conversations/" + saved.conversationId + "/follow-ups";
  const records = async () =>
    (await (await page.request.get(path)).json()) as any[];
  try {
    await page.getByRole("tab", { name: "任务", exact: true }).click();
    const panel = page.getByRole("region", { name: "我的定时跟进" });
    await expect(panel).toBeVisible();
    await panel
      .getByRole("combobox", { name: "跟进执行器" })
      .selectOption("fixture");
    await panel.getByRole("spinbutton", { name: "跟进间隔分钟" }).fill("15");
    await panel.getByRole("spinbutton", { name: "跟进次数上限" }).fill("4");
    await panel
      .getByRole("button", { name: "保存定时跟进", exact: true })
      .click();
    await expect(panel.locator(".follow-up-row")).toHaveCount(1);
    await expect
      .poll(
        async () => {
          const row = (await records())[0];
          if (!row?.lastRunId) return "waiting";
          return (
            await (await page.request.get("/api/runs/" + row.lastRunId)).json()
          ).state;
        },
        { timeout: 35000 },
      )
      .toBe("succeeded");
    const first = (await records())[0];
    expect(first.checksStarted).toBe(1);
    expect(
      (
        await (
          await page.request.get("/api/workspace?projectId=" + saved.id)
        ).json()
      ).messages,
    ).toHaveLength(0);
    await panel.getByRole("button", { name: "暂停跟进", exact: true }).click();
    await expect(panel.locator(".follow-up-row")).toContainText("已暂停");
    await panel
      .getByRole("combobox", { name: "跟进配置方式" })
      .selectOption("ai");
    await panel.getByRole("button", { name: "AI 恢复", exact: true }).click();
    await expect(panel.locator(".follow-up-row")).toContainText("定时检查中", {
      timeout: 20000,
    });
    await panel.getByRole("button", { name: "AI 取消", exact: true }).click();
    await expect(panel.locator(".follow-up-row")).toContainText("已取消", {
      timeout: 20000,
    });
    expect((await records())[0].state).toBe("cancelled");
    await panel
      .getByRole("combobox", { name: "跟进执行器" })
      .selectOption("fixture");
    await panel.getByRole("spinbutton", { name: "跟进间隔分钟" }).fill("60");
    await panel.getByRole("spinbutton", { name: "跟进次数上限" }).fill("3");
    const configured = page.waitForRequest(
      (r) => r.url().endsWith("/api/runs") && r.method() === "POST",
    );
    await panel
      .getByRole("button", { name: "让 AI 创建跟进", exact: true })
      .click();
    expect((await configured).postDataJSON().followUpPlan).toEqual({
      operation: "create",
      intervalMinutes: 60,
      maxChecks: 3,
    });
    await expect(panel.locator(".follow-up-row")).toHaveCount(2, {
      timeout: 20000,
    });
    const active = panel
      .locator(".follow-up-row")
      .filter({ hasText: "定时检查中" });
    await expect(active).toContainText("每 60 分钟");
    await expect(active).toContainText("/3 次");
    await active.scrollIntoViewIfNeeded();
    expect(page.url()).toBe(testOrigin + "/");
    await expect(page).toHaveTitle(/Hyper Workspace/);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.screenshot({
      path: "/tmp/hyper-follow-up-schedules-desktop.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await active.scrollIntoViewIfNeeded();
    await expect(
      active.getByRole("button", { name: "AI 取消", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: "/tmp/hyper-follow-up-schedules-mobile.png",
    });
    expect(errors).toEqual([]);
  } finally {
    for (const row of await records())
      if (["active", "paused"].includes(row.state))
        await page.request.post(path, {
          headers: { Origin: testOrigin },
          data: {
            plan: {
              operation: "cancel",
              scheduleId: row.id,
              expectedVersion: row.version,
            },
            engine: "fixture",
            idempotencyKey: randomUUID(),
          },
        });
  }
});

for (const mode of ["direct", "ai"])
  test(`Late ${mode} configuration responses cannot restore the prior project's schedule or Run`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "进入演示工作区" }).click();
    await expect(
      page.getByRole("heading", { name: "产品共创", exact: true }),
    ).toBeVisible();
    const a = await project(page, "旧跟进 " + randomUUID().slice(0, 6));
    const b = await project(page, "新跟进 " + randomUUID().slice(0, 6));
    await page
      .locator(".project-list")
      .getByRole("button", { name: a.name, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: a.name, exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "任务", exact: true }).click();
    const panel = page.getByRole("region", { name: "我的定时跟进" });
    await panel
      .getByRole("combobox", { name: "跟进执行器" })
      .selectOption("fixture");
    await panel
      .getByRole("combobox", { name: "跟进配置方式" })
      .selectOption(mode);
    await panel.getByRole("spinbutton", { name: "跟进次数上限" }).fill("2");
    let entered!: () => void, release!: () => void;
    const pending = new Promise<void>((resolve) => (entered = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      mode === "ai"
        ? "**/api/runs"
        : "**/api/conversations/" + a.conversationId + "/follow-ups",
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        entered();
        await gate;
        await route.fulfill({
          status: 201,
          json: { id: "00000000-0000-4000-8000-000000009999", state: "queued" },
        });
      },
    );
    await panel
      .getByRole("button", {
        name: mode === "ai" ? "让 AI 创建跟进" : "保存定时跟进",
        exact: true,
      })
      .click();
    await pending;
    await page
      .locator(".project-list")
      .getByRole("button", { name: b.name, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: b.name, exact: true }),
    ).toBeVisible();
    release();
    await page.getByRole("tab", { name: "任务", exact: true }).click();
    await expect(
      page
        .getByRole("region", { name: "我的定时跟进" })
        .getByRole("spinbutton", { name: "跟进次数上限" }),
    ).toHaveValue("8");
    await expect(page.locator(".follow-up-row")).toHaveCount(0);
    await expect(page.locator(".run-strip")).toHaveCount(0);
  });
