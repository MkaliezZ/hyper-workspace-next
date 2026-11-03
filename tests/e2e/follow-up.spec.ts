import { testOrigin } from "./origin";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

test("Task checks stay quiet without changes and merge current facts once after manual edits", async ({
  page,
}) => {
  const errors: string[] = [];
  let authenticated = false;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // The unauthenticated workspace probe intentionally returns 401 before login.
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
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  const name = "静默跟进验证 " + randomUUID().slice(0, 6);
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page
    .getByLabel("当前目标", { exact: true })
    .fill("演示检查安静、变化有据的跟进");
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/projects") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const project = await (await created).json();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  expect(page.url()).toBe(testOrigin + "/");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  const check = async (reason: string) => {
    await page.getByRole("button", { name: "发起任务", exact: true }).click();
    await page
      .getByRole("combobox", { name: "工作类型", exact: true })
      .selectOption("follow_up");
    await expect(page.getByRole("dialog")).toContainText("本次为单次检查");
    await page
      .getByRole("combobox", { name: "执行服务", exact: true })
      .selectOption("fixture");
    await page
      .getByRole("textbox", { name: "工作要求", exact: true })
      .fill("检查当前项目待办实际变化。");
    const admitted = page.waitForResponse(
      (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    const run = await (await admitted).json();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/runs/" + run.id)).json()).state,
        { timeout: 20000 },
      )
      .toBe("succeeded");
    await expect(page.locator(".run-strip").getByRole("status")).toContainText(
      reason,
    );
    return (await (await page.request.get("/api/runs/" + run.id)).json()).result
      .receipts[0];
  };
  const first = await check("已建立待办检查基线");
  expect(first.notify).toBe(false);
  await expect(page.locator(".message-row")).toHaveCount(0);
  await check("待办无变化");
  await expect(page.locator(".message-row")).toHaveCount(0);

  await page.getByRole("button", { name: "添加待办", exact: true }).click();
  await page.getByLabel("待办事项", { exact: true }).fill("核对上线清单");
  await page.getByLabel("负责人", { exact: true }).fill("演示员工");
  await page.getByRole("button", { name: "创建待办", exact: true }).click();
  const second = await page.request.post(
    "/api/conversations/" + project.conversationId + "/tasks",
    {
      headers: { Origin: testOrigin },
      data: { title: "确认验收记录", assignee: "演示同事", dueDate: null },
    },
  );
  expect(second.status()).toBe(201);
  const changed = await check("待办变化已合并为一条项目消息");
  expect(changed.changes).toHaveLength(2);
  await expect(page.locator(".message-row")).toHaveCount(1);
  await expect(page.locator(".message-row")).toContainText("新增 2 项");
  await expect(page.locator(".message-row")).toContainText("核对上线清单");
  await expect(page.locator(".message-row")).toContainText("确认验收记录");
  await page.screenshot({ path: "/tmp/hyper-follow-up-changed.png" });
  const quiet = await check("待办无变化");
  expect(quiet.notificationMessageId).toBeNull();
  await expect(page.locator(".message-row")).toHaveCount(1);
  await page.screenshot({ path: "/tmp/hyper-follow-up-quiet.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".run-strip").getByRole("status")).toContainText(
    "未向项目发消息",
  );
  await expect(page.getByRole("textbox", { name: "讨论内容" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "/tmp/hyper-follow-up-mobile.png" });
});
