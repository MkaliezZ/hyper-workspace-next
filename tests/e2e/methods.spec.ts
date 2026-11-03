import { testOrigin } from "./origin";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const headers = { Origin: testOrigin };
async function seed(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "进入演示工作区" }).click();
  await expect(
    page.getByRole("navigation", { name: "工作区导航" }),
  ).toBeVisible();
  const create = async (name: string) => {
    const r = await page.request.post("/api/projects", {
      headers,
      data: {
        name: name + randomUUID().slice(0, 6),
        goal: "Methods browser synthetic fixture",
      },
    });
    expect(r.status()).toBe(201);
    return r.json();
  };
  const project = await create("方法复用 "),
    next = await create("方法隔离 ");
  const response = await page.request.post("/api/runs", {
    headers,
    data: {
      conversationId: project.conversationId,
      workflow: "discussion_to_minutes",
      engine: "fixture",
      instruction: "Synthetic source artifact for method UI.",
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const run = await response.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/runs/" + run.id)).json()).state,
      { timeout: 20000 },
    )
    .toBe("succeeded");
  const artifact = (
    await (await page.request.get("/api/runs/" + run.id)).json()
  ).result.receipts.find((r: any) => r.tool === "artifact.create");
  await page.reload();
  await page
    .locator(".project-list")
    .getByRole("button", { name: project.name, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: project.name, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "知识库", exact: true })
    .click();
  await page.getByRole("tab", { name: "方法与模板", exact: true }).click();
  const panel = page.getByRole("region", { name: "方法与模板" });
  await panel
    .getByRole("combobox", { name: "方法来源成果", exact: true })
    .selectOption(artifact.id);
  return { project, next, artifact, panel };
}
test("Maintainer transfer displays identity choices and preserves a versioned manual receipt on desktop/mobile", async ({
  page,
}) => {
  const { panel } = await seed(page);
  await panel
    .getByRole("textbox", { name: "方法标题", exact: true })
    .fill("合成：维护人移交");
  await panel
    .getByRole("textbox", { name: "方法内容", exact: true })
    .fill("这是界面验收资料，非企业制度。");
  await panel
    .getByRole("button", { name: "保存候选方法", exact: true })
    .click();
  await expect(
    panel.getByRole("button", {
      name: "打开方法：合成：维护人移交",
      exact: true,
    }),
  ).toBeVisible();
  await panel
    .getByRole("combobox", { name: "方法管理操作", exact: true })
    .selectOption("transfer");
  const person = panel.getByRole("combobox", {
    name: "方法新维护人",
    exact: true,
  });
  await expect(person.locator("option")).toHaveCount(2);
  await expect(
    panel.getByRole("button", { name: "执行已确认操作", exact: true }),
  ).toBeDisabled();
  await person.selectOption("00000000-0000-4000-8000-000000000012");
  await panel
    .getByRole("checkbox", {
      name: "我已核对当前方法版本、依据和范围，确认上述管理操作",
      exact: true,
    })
    .check();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(person).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/methods/actions") &&
      response.request().method() === "POST",
  );
  await panel
    .getByRole("button", { name: "执行已确认操作", exact: true })
    .click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const receipt = await response.json();
  expect(receipt.operation).toBe("transfer");
  expect(receipt.maintainerId).toBe("00000000-0000-4000-8000-000000000012");
  expect(receipt.version).toBe(1);
  expect(receipt.revision).toBe(2);
  const detail = await (
    await page.request.get("/api/methods/" + receipt.id)
  ).json();
  expect(detail.current.maintainerName).toBe("陈远");
  expect(detail.versions).toHaveLength(1);
});
test("Manual candidate verification, publication, actual worker reuse and withdrawal preserve versions and stay usable on desktop/mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let authenticated = false;
  page.on("console", (m) => {
    if (
      !authenticated &&
      m.location().url.endsWith("/api/workspace") &&
      m.text().includes("401")
    )
      return;
    if (["error", "warning"].includes(m.type())) errors.push(m.text());
  });
  const { project, panel } = await seed(page);
  authenticated = true;
  await panel
    .getByRole("textbox", { name: "方法标题", exact: true })
    .fill("演示：证据核对 SOP");
  await panel
    .getByRole("textbox", { name: "方法内容", exact: true })
    .fill("仅为演示：先识别来源与版本，再保存可核对结果。");
  await panel
    .getByRole("button", { name: "保存候选方法", exact: true })
    .click();
  await expect(
    panel.getByRole("button", {
      name: "打开方法：演示：证据核对 SOP",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel.getByRole("textbox", { name: "方法标题", exact: true }),
  ).toHaveValue("演示：证据核对 SOP");
  await expect(panel.getByText(/候选，尚未验证/)).toBeVisible();
  await panel
    .getByRole("textbox", { name: "方法验证依据", exact: true })
    .fill("演示员工核对了来源和样例，未作为真实公司质量验证。");
  const confirm = panel.getByRole("checkbox", {
    name: "我已核对当前方法版本、依据和范围，确认上述管理操作",
    exact: true,
  });
  await confirm.check();
  await panel
    .getByRole("button", { name: "执行已确认操作", exact: true })
    .click();
  await expect(panel.getByText(/员工已声明验证/)).toBeVisible();
  await panel
    .getByRole("combobox", { name: "方法管理操作", exact: true })
    .selectOption("publish");
  await expect(confirm).not.toBeChecked();
  await confirm.check();
  await panel
    .getByRole("button", { name: "执行已确认操作", exact: true })
    .click();
  await expect(
    panel.getByRole("heading", { name: "使用此版本生成成果", exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("combobox", { name: "方法操作方式", exact: true })
    .selectOption("ai");
  await panel
    .getByRole("textbox", { name: "方法 AI 要求", exact: true })
    .fill("仅修改方法措辞，不生成项目周报。");
  await panel
    .getByRole("combobox", { name: "方法执行器", exact: true })
    .selectOption("fixture");
  await panel
    .getByRole("textbox", { name: "方法复用要求", exact: true })
    .fill("用这个已发布的演示 SOP 整理项目周报，未知明确标识。");
  await expect(
    panel.getByRole("textbox", { name: "方法 AI 要求", exact: true }),
  ).toHaveValue("仅修改方法措辞，不生成项目周报。");
  const admitted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/runs"),
  );
  await panel
    .getByRole("button", { name: "使用当前已发布版本", exact: true })
    .click();
  const admission = await admitted;
  expect(admission.request().postDataJSON().instruction).toBe(
    "用这个已发布的演示 SOP 整理项目周报，未知明确标识。",
  );
  const run = await admission.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/runs/" + run.id)).json()).state,
    )
    .toBe("succeeded");
  await panel.getByText("版本、操作与本人复用记录", { exact: true }).click();
  await expect(panel.locator(".method-history")).toContainText("succeeded");
  await panel.getByRole("button", { name: "新建方法", exact: true }).click();
  await expect(
    panel.getByRole("textbox", { name: "方法 AI 要求", exact: true }),
  ).toHaveValue("");
  await panel
    .getByRole("button", { name: "打开方法：演示：证据核对 SOP", exact: true })
    .click();
  await expect(
    panel.getByRole("textbox", { name: "方法 AI 要求", exact: true }),
  ).toHaveValue("");
  await expect(
    panel.getByRole("textbox", { name: "方法复用要求", exact: true }),
  ).toHaveValue("");
  await panel
    .getByRole("combobox", { name: "方法操作方式", exact: true })
    .selectOption("human");
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await panel
    .getByRole("heading", { name: "方法与模板", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/hyper-methods-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel
    .getByRole("heading", { name: "使用此版本生成成果", exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/hyper-methods-mobile.png" });
  await panel
    .getByRole("combobox", { name: "方法管理操作", exact: true })
    .selectOption("withdraw");
  await panel
    .getByRole("textbox", { name: "方法撤回原因", exact: true })
    .fill("演示方法已停用。");
  await confirm.check();
  await panel
    .getByRole("textbox", { name: "方法撤回原因", exact: true })
    .fill("演示方法已停用，后续任务不得复用。");
  await expect(confirm).not.toBeChecked();
  await confirm.check();
  await panel
    .getByRole("button", { name: "执行已确认操作", exact: true })
    .click();
  await expect(
    panel.getByRole("heading", { name: "使用此版本生成成果", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await (
        await page.request.get("/api/projects/" + project.id + "/methods")
      ).json()
    )[0].state,
  ).toBe("withdrawn");
  expect(errors).toEqual([]);
});
test("AI candidate creation and revision retain manual drafts until explicit reload and show version conflicts", async ({
  page,
}) => {
  const { panel } = await seed(page);
  await panel
    .getByRole("textbox", { name: "方法标题", exact: true })
    .fill("创建期间保留的人工标题");
  await panel
    .getByRole("textbox", { name: "方法内容", exact: true })
    .fill("创建期间保留的人工内容");
  await panel
    .getByRole("combobox", { name: "方法操作方式", exact: true })
    .selectOption("ai");
  await panel
    .getByRole("combobox", { name: "方法执行器", exact: true })
    .selectOption("fixture");
  await panel
    .getByRole("textbox", { name: "方法 AI 要求", exact: true })
    .fill("从选定演示成果整理候选，不自行验证或发布。");
  await panel
    .getByRole("button", { name: "让 AI 保存候选方法", exact: true })
    .click();
  const candidate = panel.getByRole("button", {
    name: "打开方法：演示方法候选",
    exact: true,
  });
  await expect(candidate).toBeVisible();
  await expect(
    panel.getByRole("textbox", { name: "方法内容", exact: true }),
  ).toHaveValue("创建期间保留的人工内容");
  await candidate.click();
  await expect(
    panel.getByRole("textbox", { name: "方法标题", exact: true }),
  ).toHaveValue("演示方法候选");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/runs/*", async (route) => {
    if (route.request().method() === "GET") await gate;
    await route.continue();
  });
  await panel
    .getByRole("textbox", { name: "方法 AI 要求", exact: true })
    .fill("修订保存的候选版本。");
  await panel
    .getByRole("button", { name: "让 AI 保存候选方法", exact: true })
    .click();
  const content = panel.getByRole("textbox", { name: "方法内容", exact: true });
  await expect(content).toBeEnabled();
  await content.fill("AI 执行期间人工写下的草稿必须保留");
  release();
  await expect(
    panel.getByText(
      "已有新的内容或状态，人工草稿已保留。请读取当前版本后再操作。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(content).toHaveValue("AI 执行期间人工写下的草稿必须保留");
  await expect(
    panel.getByRole("button", { name: "让 AI 保存候选方法", exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole("button", {
      name: "读取当前方法版本（将替换编辑内容）",
      exact: true,
    })
    .click();
  await expect(content).toHaveValue(/演示候选方法/);
});
test("A denied method read clears private drafts and discards an earlier delayed list response", async ({
  page,
}) => {
  const { project, panel } = await seed(page);
  await panel
    .getByRole("textbox", { name: "方法标题", exact: true })
    .fill("合成来源私有方法");
  await panel
    .getByRole("textbox", { name: "方法内容", exact: true })
    .fill("源访问失效后不应恢复的合成正文");
  await panel
    .getByRole("button", { name: "保存候选方法", exact: true })
    .click();
  await expect(
    panel.getByRole("textbox", { name: "方法标题", exact: true }),
  ).toHaveValue("合成来源私有方法");
  const method = (
    await (
      await page.request.get("/api/projects/" + project.id + "/methods")
    ).json()
  )[0];
  let release!: () => void,
    arrive!: () => void,
    settle!: () => void,
    first = true;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    arrived = new Promise<void>((r) => {
      arrive = r;
    }),
    settled = new Promise<void>((r) => {
      settle = r;
    });
  await page.route(
    "**/api/projects/" + project.id + "/methods",
    async (route) => {
      if (first) {
        first = false;
        const response = await route.fetch();
        arrive();
        await gate;
        await route.fulfill({ response });
        settle();
      } else await route.fulfill({ json: [] });
    },
  );
  await arrived;
  await page.route("**/api/methods/" + method.id, (route) =>
    route.fulfill({ status: 404, json: { message: "合成来源权限已失效。" } }),
  );
  await panel
    .getByRole("button", { name: "读取当前方法版本", exact: true })
    .click();
  await expect(
    panel.getByRole("textbox", { name: "方法内容", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", {
      name: "打开方法：合成来源私有方法",
      exact: true,
    }),
  ).toHaveCount(0);
  release();
  await settled;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    panel.getByRole("button", {
      name: "打开方法：合成来源私有方法",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("textbox", { name: "方法内容", exact: true }),
  ).toHaveCount(0);
});

for (const mode of ["human", "ai"])
  test(`Late ${mode} method responses cannot restore private drafts or a Run after project switch`, async ({
    page,
  }) => {
    const { next, panel } = await seed(page);
    await panel
      .getByRole("textbox", { name: "方法标题", exact: true })
      .fill("迟到的方法候选");
    await panel
      .getByRole("textbox", { name: "方法内容", exact: true })
      .fill("仅属于旧项目的人工草稿");
    if (mode === "ai") {
      await panel
        .getByRole("combobox", { name: "方法操作方式", exact: true })
        .selectOption("ai");
      await panel
        .getByRole("combobox", { name: "方法执行器", exact: true })
        .selectOption("fixture");
      await panel
        .getByRole("textbox", { name: "方法 AI 要求", exact: true })
        .fill("旧项目的方法操作。");
    }
    let release!: () => void, seen!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      arrived = new Promise<void>((r) => {
        seen = r;
      });
    await page.route(
      mode === "ai" ? "**/api/runs" : "**/api/projects/*/methods/actions",
      async (route) => {
        const response = await route.fetch();
        seen();
        await gate;
        await route.fulfill({ response });
      },
    );
    await panel
      .getByRole("button", {
        name: mode === "ai" ? "让 AI 保存候选方法" : "保存候选方法",
        exact: true,
      })
      .click();
    await arrived;
    await page
      .locator(".project-list")
      .getByRole("button", { name: next.name, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: next.name, exact: true }),
    ).toBeVisible();
    release();
    await page
      .getByRole("navigation", { name: "工作区导航" })
      .getByRole("button", { name: "知识库", exact: true })
      .click();
    await page.getByRole("tab", { name: "方法与模板", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "方法内容", exact: true }),
    ).toHaveValue("");
    await expect(
      page.getByRole("button", {
        name: "打开方法：迟到的方法候选",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "方法来源成果", exact: true }),
    ).toHaveValue("");
  });
