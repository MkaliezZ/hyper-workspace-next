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
  const response = await page.request.post("/api/projects", {
    headers,
    data: {
      name: "成果验收 " + randomUUID().slice(0, 6),
      goal: "验证员工确认、版本与历史",
    },
  });
  expect(response.status()).toBe(201);
  const project = await response.json();
  const started = await page.request.post("/api/runs", {
    headers,
    data: {
      conversationId: project.conversationId,
      workflow: "discussion_to_minutes",
      instruction: "生成明确标记的验收演示成果。",
      engine: "fixture",
      idempotencyKey: randomUUID(),
    },
  });
  expect(started.status()).toBe(201);
  const run = await started.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/runs/" + run.id)).json()).state,
      { timeout: 20000 },
    )
    .toBe("succeeded");
  const artifactId = (
    await (await page.request.get("/api/runs/" + run.id)).json()
  ).result.receipts[0].id;
  await page.reload();
  await page
    .locator(".project-list")
    .getByRole("button", { name: project.name, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "成果", exact: true }).click();
  await page.locator(".artifact-list-row").first().click();
  const panel = page.getByRole("region", { name: "成果验收" });
  await expect(
    panel.getByRole("button", { name: "记录验收决定", exact: true }),
  ).toBeDisabled();
  return { project, artifactId, panel };
}

test("Version-bound human and AI acceptance preserve manual edits, display review history and reset a new version to draft", async ({
  page,
}) => {
  test.setTimeout(60000);
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
    if (["warning", "error"].includes(m.type())) errors.push(m.text());
  });
  const { artifactId, panel } = await seed(page);
  authenticated = true;
  const editor = page.getByRole("textbox", { name: "成果内容", exact: true });
  const original = await editor.inputValue();
  await panel
    .getByRole("textbox", { name: "验收意见", exact: true })
    .fill("员工已检查第一版的来源与分工。");
  await panel.getByRole("checkbox").check();
  await panel
    .getByRole("combobox", { name: "验收决定", exact: true })
    .selectOption("request_changes");
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await panel
    .getByRole("combobox", { name: "验收决定", exact: true })
    .selectOption("accept");
  await panel.getByRole("checkbox").check();
  await panel
    .getByRole("button", { name: "记录验收决定", exact: true })
    .click();
  await expect(panel.locator(".artifact-review-current")).toContainText(
    "v1 · 已验收 · 验收修订 1",
  );
  await expect(panel.locator(".artifact-review-history li")).toHaveCount(1);
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  await editor.fill(original + "\n未保存编辑");
  await expect(panel).toContainText("编辑框有未保存内容");
  await expect(
    panel.getByRole("button", { name: "记录验收决定", exact: true }),
  ).toBeDisabled();
  await editor.fill(original);
  await panel
    .getByRole("combobox", { name: "验收决定", exact: true })
    .selectOption("request_changes");
  await panel
    .getByRole("combobox", { name: "验收记录方式", exact: true })
    .selectOption("ai");
  await panel
    .getByRole("combobox", { name: "验收执行器", exact: true })
    .selectOption("fixture");
  await panel
    .getByRole("textbox", { name: "验收意见", exact: true })
    .fill("员工要求补充负责人核对；AI 仅记录决定。");
  await panel.getByRole("checkbox").check();
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const submitted = route.request().postDataJSON();
    expect(submitted.artifactId).toBe(artifactId);
    expect(submitted.artifactReviewPlan).toMatchObject({
      decision: "request_changes",
      confirmed: true,
      expectedVersion: 1,
      expectedReviewRevision: 1,
    });
    expect(JSON.stringify(submitted)).not.toContain(original);
    const response = await route.fetch();
    entered();
    await gate;
    await route.fulfill({ response });
  });
  await panel
    .getByRole("button", { name: "让 AI 记录决定", exact: true })
    .click();
  await pending;
  const unsaved = original + "\nAI 代执行期间的人工修改必须保留。";
  await editor.fill(unsaved);
  release();
  await expect(panel.locator(".artifact-review-current")).toContainText(
    "待修改",
    { timeout: 20000 },
  );
  await expect(editor).toHaveValue(unsaved);
  await expect(panel.locator(".artifact-review-history li")).toHaveCount(2);
  await expect(panel.locator(".artifact-review-history")).toContainText(
    "AI 代执行，员工确认",
  );
  expect(page.url()).toBe(testOrigin + "/");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await panel.locator(".artifact-review-current").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/hyper-artifact-review-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel
    .getByRole("textbox", { name: "验收意见", exact: true })
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
  await page.screenshot({ path: "/tmp/hyper-artifact-review-mobile.png" });
  let refreshing!: () => void, releaseRefresh!: () => void;
  const refreshStarted = new Promise<void>((r) => (refreshing = r)),
    refreshGate = new Promise<void>((r) => (releaseRefresh = r));
  await page.route("**/api/workspace?*", async (route) => {
    const response = await route.fetch();
    refreshing();
    await refreshGate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await refreshStarted;
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(editor).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "保存新版本", exact: true }),
  ).toBeDisabled();
  releaseRefresh();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(".artifact-list-row").first().click();
  await expect(panel.locator(".artifact-review-current")).toContainText(
    "v2 · 草稿 · 验收修订 0",
  );
  await expect(panel.locator(".artifact-review-history li")).toHaveCount(2);
  await expect(editor).toHaveValue(unsaved);
  const saved = await (
    await page.request.get("/api/artifacts/" + artifactId)
  ).json();
  expect(saved.current.acceptedVersion).toBeNull();
  expect(saved.current.content).toBe(unsaved);
  expect(saved.reviews.map((r: any) => r.version)).toEqual([1, 1]);
  expect(errors).toEqual([]);
});

for (const mode of ["AI review", "artifact save"])
  test(`Late ${mode} responses cannot restore a closed artifact editor or the prior project`, async ({
    page,
  }) => {
    const { project, panel, artifactId } = await seed(page);
    const next = await (
      await page.request.post("/api/projects", {
        headers,
        data: {
          name: "验收隔离 " + randomUUID().slice(0, 6),
          goal: "不恢复旧项目内容",
        },
      })
    ).json();
    // Refresh the project list without changing the open dialog's object scope.
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.reload();
    await page
      .locator(".project-list")
      .getByRole("button", { name: project.name, exact: true })
      .click();
    await page.getByRole("tab", { name: "成果", exact: true }).click();
    await page.locator(".artifact-list-row").first().click();
    if (mode === "AI review") {
      await panel
        .getByRole("combobox", { name: "验收记录方式", exact: true })
        .selectOption("ai");
      await panel
        .getByRole("combobox", { name: "验收执行器", exact: true })
        .selectOption("fixture");
      await panel
        .getByRole("textbox", { name: "验收意见", exact: true })
        .fill("员工明确确认的旧项目决定");
      await panel.getByRole("checkbox").check();
    } else {
      await page
        .getByRole("textbox", { name: "成果内容", exact: true })
        .fill("保存请求关闭后不恢复旧项目");
    }
    let entered!: () => void, release!: () => void;
    const pending = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const endpoint =
      mode === "AI review"
        ? "/api/runs"
        : "/api/artifacts/" + artifactId + "/revisions";
    await page.route("**" + endpoint, async (route) => {
      entered();
      await gate;
      await route.fulfill({
        status: 201,
        json: { id: randomUUID(), state: "queued" },
      });
    });
    await page
      .getByRole("button", {
        name: mode === "AI review" ? "让 AI 记录决定" : "保存新版本",
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
      (r) => r.url().endsWith(endpoint) && r.request().method() === "POST",
    );
    release();
    await completed;
    await page.getByRole("tab", { name: "成果", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".run-strip")).toHaveCount(0);
    await expect(page.locator(".artifact-list-row")).toHaveCount(0);
  });

test("Concurrent saved versions require an explicit reload; unavailable review authority removes decision controls", async ({
  page,
}) => {
  const { artifactId, panel } = await seed(page);
  const editor = page.getByRole("textbox", { name: "成果内容", exact: true });
  const original = await editor.inputValue();
  const saved = await page.request.post(
    "/api/artifacts/" + artifactId + "/revisions",
    {
      headers,
      data: {
        expectedVersion: 1,
        content: "另一位员工保存的第二版",
        feedback: "并发修改",
      },
    },
  );
  expect(saved.status()).toBe(201);
  await panel
    .getByRole("textbox", { name: "验收意见", exact: true })
    .fill("员工确认的旧版本意见");
  await panel.getByRole("checkbox").check();
  await panel
    .getByRole("button", { name: "记录验收决定", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("版本已变化");
  await expect(panel).toContainText("成果已有新版");
  await expect(editor).toHaveValue(original);
  await editor.fill("本地人工编辑保留");
  // Protocol UI fixture for the denied-authority presentation; server authorization is tested against live roles.
  await page.route("**/api/artifacts/" + artifactId, async (route) => {
    const data = await (await route.fetch()).json();
    await route.fulfill({ json: { ...data, canReview: false } });
  });
  await panel
    .getByRole("button", { name: "重新读取成果", exact: true })
    .click();
  await expect(editor).toHaveValue("另一位员工保存的第二版");
  await expect(panel).toContainText("仅成果创建人或有项目访问权限");
  await expect(
    panel.getByRole("combobox", { name: "验收决定", exact: true }),
  ).toHaveCount(0);
  await expect(panel.locator(".artifact-review-current")).toContainText(
    "v2 · 草稿",
  );
});
