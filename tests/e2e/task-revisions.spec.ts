import { testOrigin } from "./origin";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const headers = { Origin: testOrigin };
async function seed(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "进入演示工作区" }).click();
  await expect(
    page.getByRole("heading", { name: "产品共创", exact: true }),
  ).toBeVisible();
  const make = async (name: string) =>
    await (
      await page.request.post("/api/projects", {
        headers,
        data: {
          name: name + randomUUID().slice(0, 6),
          goal: "Task revision browser fixture",
        },
      })
    ).json();
  const project = await make("待办修改 "),
    next = await make("隔离目标 ");
  const response = await page.request.post(
    "/api/conversations/" + project.conversationId + "/tasks",
    {
      headers,
      data: {
        title: "待办修改演示",
        assignee: "文字负责人",
        dueDate: "2026-11-10",
      },
    },
  );
  expect(response.status()).toBe(201);
  const task = await response.json();
  await page.reload();
  await page
    .locator(".project-list")
    .getByRole("button", { name: project.name, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "任务", exact: true }).click();
  await page
    .getByRole("button", { name: "修改待办：" + task.title, exact: true })
    .click();
  const panel = page.getByRole("region", { name: "待办修改" });
  await expect(
    panel.getByRole("textbox", { name: "待办标题", exact: true }),
  ).toHaveValue(task.title);
  return { project, next, task, panel };
}
test("Manual and AI task edits retain versions, preserve a manual draft and require explicit reload on desktop and mobile", async ({
  page,
}) => {
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
  const { task, panel } = await seed(page);
  authenticated = true;
  const title = panel.getByRole("textbox", { name: "待办标题", exact: true });
  await title.fill("人工修改的标题");
  await panel
    .getByRole("textbox", { name: "负责人文字标记", exact: true })
    .fill("未绑定的人员标签");
  await panel.getByLabel("待办截止日期", { exact: true }).fill("");
  await panel
    .getByRole("combobox", { name: "待办状态", exact: true })
    .selectOption("done");
  await panel
    .getByRole("button", { name: "保存待办修改", exact: true })
    .click();
  await expect(panel).toContainText("当前已保存 v2");
  await expect(panel.locator(".task-version-history li")).toHaveCount(2);
  expect(
    (await (await page.request.get("/api/tasks/" + task.id)).json()).current
      .dueDate,
  ).toBeNull();
  await panel
    .getByRole("combobox", { name: "待办修改方式", exact: true })
    .selectOption("ai");
  await panel
    .getByRole("combobox", { name: "待办执行器", exact: true })
    .selectOption("fixture");
  await panel
    .getByRole("textbox", { name: "待办修改要求", exact: true })
    .fill("仅改进选定待办的标题");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/runs/*", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await gate;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  const submitted = page.waitForRequest(
    (r) => r.url().endsWith("/api/runs") && r.method() === "POST",
  );
  await panel
    .getByRole("button", { name: "让 AI 修改待办", exact: true })
    .click();
  const input = (await submitted).postDataJSON();
  expect(input.taskId).toBe(task.id);
  expect(input.expectedTaskVersion).toBe(2);
  await expect(panel).toContainText("已发起修改");
  await title.fill("AI 运行期间保留的人工草稿");
  release();
  await expect(panel).toContainText("当前已保存 v3", { timeout: 20000 });
  await expect(title).toHaveValue("AI 运行期间保留的人工草稿");
  await expect(panel).toContainText("已有新版");
  await expect(
    panel.getByRole("button", { name: "保存待办修改", exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole("button", {
      name: "读取当前版本（将替换编辑内容）",
      exact: true,
    })
    .click();
  await expect(title).toHaveValue("演示修改后的待办");
  await expect(panel.locator(".task-version-history li")).toHaveCount(3);
  await expect(panel).toContainText("AI 修改");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  expect(page.url()).toBe(testOrigin + "/");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/hyper-task-revision-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel
    .getByRole("textbox", { name: "待办修改要求", exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(false);
  await page.screenshot({ path: "/tmp/hyper-task-revision-mobile.png" });
  expect(errors).toEqual([]);
});
for (const mode of ["human", "ai"])
  test(`Late ${mode} task mutation responses cannot restore another project's editor or Run`, async ({
    page,
  }) => {
    const { task, next, panel } = await seed(page);
    if (mode === "ai") {
      await panel
        .getByRole("combobox", { name: "待办修改方式", exact: true })
        .selectOption("ai");
      await panel
        .getByRole("combobox", { name: "待办执行器", exact: true })
        .selectOption("fixture");
      await panel
        .getByRole("textbox", { name: "待办修改要求", exact: true })
        .fill("旧项目修改要求");
    } else
      await panel
        .getByRole("textbox", { name: "待办标题", exact: true })
        .fill("旧项目人工修改");
    let entered!: () => void, release!: () => void;
    const pending = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r)),
      endpoint = mode === "ai" ? "/api/runs" : "/api/tasks/" + task.id;
    await page.route("**" + endpoint, async (route) => {
      if (route.request().method() === "GET") return route.continue();
      entered();
      await gate;
      await route.fulfill({
        status: 201,
        json:
          mode === "ai"
            ? { id: randomUUID(), state: "queued" }
            : { ...task, version: 2 },
      });
    });
    await panel
      .getByRole("button", {
        name: mode === "ai" ? "让 AI 修改待办" : "保存待办修改",
        exact: true,
      })
      .click();
    await pending;
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .locator(".project-list")
      .getByRole("button", { name: next.name, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: next.name, exact: true }),
    ).toBeVisible();
    const completed = page.waitForResponse(
      (r) => r.url().endsWith(endpoint) && r.request().method() !== "GET",
    );
    release();
    await completed;
    await page.getByRole("tab", { name: "任务", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".task-table-row")).toHaveCount(0);
    await expect(page.locator(".run-strip")).toHaveCount(0);
  });
