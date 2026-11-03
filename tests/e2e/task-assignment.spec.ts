import { testOrigin } from "./origin";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("Project directory, exact employee assignment and AI unassignment retain versions, fit mobile and clear delayed denied-directory responses", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (!["warning", "error"].includes(m.type())) return;
    const u = m.location().url,
      t = m.text();
    if (
      (u.endsWith("/api/workspace") && t.includes("401")) ||
      (u.endsWith("/directory") && t.includes("403"))
    )
      return;
    errors.push(t);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "进入演示工作区" }).click();
  await expect(
    page.getByRole("navigation", { name: "工作区导航", exact: true }),
  ).toBeVisible();
  const user = (await (await page.request.get("/api/workspace")).json()).user;
  const pr = await page.request.post("/api/projects", {
    data: {
      name: "员工分配 " + randomUUID().slice(0, 6),
      goal: "Synthetic employee identity assignment",
    },
  });
  expect(pr.status()).toBe(201);
  const project = await pr.json();
  const tr = await page.request.post(
    "/api/conversations/" + project.conversationId + "/tasks",
    { data: { title: "按身份分配的合成待办", assignee: "尚未绑定员工" } },
  );
  expect(tr.status()).toBe(201);
  const task = await tr.json();
  await page.reload();
  await page
    .locator(".project-list")
    .getByRole("button", { name: project.name, exact: true })
    .click();
  await page.getByRole("tab", { name: "任务", exact: true }).click();
  await page.getByText("项目成员与真实身份", { exact: true }).click();
  const directory = page.getByRole("region", {
    name: "项目成员目录",
    exact: true,
  });
  await expect(directory).toContainText(user.id);
  await directory
    .getByRole("textbox", { name: "查找项目成员", exact: true })
    .fill(user.id);
  await expect(directory.locator(".member-list li")).toHaveCount(1);
  await directory
    .getByRole("textbox", { name: "查找项目成员", exact: true })
    .fill("");
  await directory
    .getByRole("combobox", { name: "成员执行服务", exact: true })
    .selectOption("fixture");
  await directory
    .getByRole("button", { name: "AI 读取项目成员", exact: true })
    .click();
  await expect(directory.getByRole("status")).toContainText("AI 已回读", {
    timeout: 20000,
  });
  await page
    .getByRole("button", { name: "修改待办：" + task.title, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "修改待办", exact: true });
  await dialog.getByText("按真实员工身份分配", { exact: true }).click();
  const panel = dialog.getByRole("region", {
    name: "待办员工分配",
    exact: true,
  });
  await expect(
    panel.getByRole("combobox", { name: "分配员工", exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole("combobox", { name: "分配员工", exact: true })
    .selectOption(user.id);
  await panel.getByRole("checkbox", { name: /我已核对待办/ }).check();
  await panel
    .getByRole("button", { name: "保存员工分配", exact: true })
    .click();
  await expect(dialog).toContainText("当前已保存 v2");
  await expect(
    dialog.getByRole("textbox", { name: "负责人文字标记", exact: true }),
  ).toBeDisabled();
  let saved = await (await page.request.get("/api/tasks/" + task.id)).json();
  expect(saved.current.assigneeId).toBe(user.id);
  expect(saved.current.assignee).toBe(user.name);
  expect(saved.history[0].snapshot.assigneeId).toBe(user.id);
  await page.screenshot({
    path: testInfo.outputPath("task-assignment-desktop.png"),
    fullPage: true,
  });
  await panel
    .getByRole("combobox", { name: "分配方式", exact: true })
    .selectOption("ai");
  await panel
    .getByRole("combobox", { name: "成员执行服务", exact: true })
    .selectOption("fixture");
  await panel
    .getByRole("combobox", { name: "分配员工", exact: true })
    .selectOption("");
  await panel.getByRole("checkbox", { name: /我已核对待办/ }).check();
  await panel
    .getByRole("button", { name: "AI 保存员工分配", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("AI 已保存", {
    timeout: 20000,
  });
  await dialog
    .getByRole("button", { name: "读取当前版本", exact: true })
    .click();
  await expect(dialog).toContainText("当前已保存 v3");
  saved = await (await page.request.get("/api/tasks/" + task.id)).json();
  expect(saved.current.assigneeId).toBeNull();
  expect(saved.current.assignee).toBe("待分配");
  expect(
    saved.history.find((v: any) => v.version === 2).snapshot.assigneeId,
  ).toBe(user.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("task-assignment-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBeTruthy();
  const path = "/api/projects/" + project.id + "/directory",
    cached = await (await page.request.get(path)).json();
  let count = 0,
    release = () => {},
    seen = () => {};
  const delay = new Promise<void>((r) => (release = r)),
    arrived = new Promise<void>((r) => (seen = r));
  await page.route("**" + path, async (route) => {
    count++;
    if (count === 1) {
      seen();
      await delay;
      await route.fulfill({ json: cached });
    } else
      await route.fulfill({
        status: 403,
        json: { message: "Synthetic directory scope revoked" },
      });
  });
  await panel
    .getByRole("button", { name: "重新读取可分配员工", exact: true })
    .click();
  await arrived;
  await panel
    .getByRole("button", { name: "重新读取可分配员工", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("scope revoked");
  release();
  await expect(
    panel
      .getByRole("combobox", { name: "分配员工", exact: true })
      .locator("option"),
  ).toHaveCount(1);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(directory.getByRole("alert")).toContainText("scope revoked");
  await expect(directory.locator(".member-list li")).toHaveCount(0);
  expect(page.url()).toBe(testOrigin + "/");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});
