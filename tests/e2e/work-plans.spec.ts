import { testOrigin } from "./origin";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const headers = { Origin: testOrigin };
async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { data: {} });
  const response = await page.request.post("/api/projects", {
    headers,
    data: {
      name: "工作计划 " + randomUUID().slice(0, 6),
      goal: "Synthetic work planning UI; no model quality claim",
    },
  });
  expect(response.status()).toBe(201);
  const project = await response.json();
  await page.goto("/");
  await page
    .locator(".project-list")
    .getByRole("button", { name: project.name, exact: true })
    .click();
  await page.getByRole("tab", { name: "工作计划", exact: true }).click();
  const panel = page.getByRole("region", { name: "工作计划与澄清" });
  await panel
    .getByRole("button", { name: "整理工作计划", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "执行服务", exact: true })
    .selectOption("fixture");
  const posted = page.waitForResponse(
    (r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  const started = await (await posted).json();
  await expect(
    panel.getByRole("textbox", {
      name: "请说明这项工作的交付对象。",
      exact: true,
    }),
  ).toBeVisible();
  return { project, panel, id: started.id };
}
test("Work planning keeps clarification, human takeover, exact identity confirmation and real receipts across reload and mobile navigation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { project, panel, id } = await setup(page);
  await expect(
    panel.getByRole("button", { name: "执行已确认工作计划", exact: true }),
  ).toHaveCount(0);
  const before = await (
    await page.request.get("/api/workspace?projectId=" + project.id)
  ).json();
  expect(before.tasks).toHaveLength(0);
  expect(before.artifacts).toHaveLength(0);
  await panel
    .getByRole("textbox", { name: "请说明这项工作的交付对象。", exact: true })
    .fill("这是合成验收对象，不是真实公司资料。");
  await panel
    .getByRole("button", { name: "保存澄清结果", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "执行已确认工作计划", exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole("button", { name: "人工接管并修改计划", exact: true })
    .click();
  await panel
    .getByRole("textbox", { name: "步骤标题", exact: true })
    .nth(0)
    .fill("人工接管后的合成待办");
  await panel
    .getByRole("button", { name: "保存人工修改并重新核对", exact: true })
    .click();
  // Editing retains the explicit question; answer it for the new proposal revision.
  await panel
    .getByRole("textbox", { name: "请说明这项工作的交付对象。", exact: true })
    .fill("人工重新确认的合成验收对象");
  await panel
    .getByRole("button", { name: "保存澄清结果", exact: true })
    .click();
  await expect(panel).toContainText("人工接管后的合成待办");
  await page.setViewportSize({ width: 390, height: 844 });
  const confirm = panel.getByRole("checkbox", {
    name: "我已检查所有步骤、员工 ID、目标版本和完整正文，确认执行当前计划",
    exact: true,
  });
  await confirm.check();
  await panel
    .getByRole("button", { name: "执行已确认工作计划", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/runs/" + id)).json()).state,
    )
    .toBe("succeeded");
  await expect(panel).toContainText("已保存实际业务记录");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  const after = await (
    await page.request.get("/api/workspace?projectId=" + project.id)
  ).json();
  expect(after.tasks).toHaveLength(1);
  expect(after.tasks[0].title).toBe("人工接管后的合成待办");
  expect(after.tasks[0].assigneeId).toBe(after.user.id);
  expect(after.artifacts).toHaveLength(1);
  await page.screenshot({
    path: "/tmp/hyper-work-plan-mobile.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1504, height: 1045 });
  await page.reload();
  await page
    .locator(".project-list")
    .getByRole("button", { name: project.name, exact: true })
    .click();
  await page.getByRole("tab", { name: "工作计划", exact: true }).click();
  await expect(
    panel.getByRole("combobox", { name: "已保存的工作计划" }),
  ).toHaveValue(id);
  await panel.getByText("实际执行回执", { exact: true }).click();
  await expect(panel).toContainText("task.assign");
  await page.screenshot({
    path: "/tmp/hyper-work-plan-desktop.png",
    fullPage: false,
  });
  expect(errors).toEqual([]);
});
test("Pending plan denies stale source reads and does not expose an old proposal after a rejected refresh", async ({
  page,
}) => {
  const { panel, id } = await setup(page);
  await page.route("**/api/runs/" + id + "/plan", (route) =>
    route.fulfill({ status: 403, json: { message: "合成来源权限已撤销。" } }),
  );
  await panel
    .getByRole("button", { name: "重新读取当前计划", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("合成来源权限已撤销");
  await expect(
    panel.getByRole("textbox", {
      name: "请说明这项工作的交付对象。",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "人工接管并修改计划", exact: true }),
  ).toHaveCount(0);
});
