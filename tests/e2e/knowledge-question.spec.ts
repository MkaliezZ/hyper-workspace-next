import { testOrigin } from "./origin";
import { test, expect } from "@playwright/test";
const files = [
  {
    id: "73000000-0000-4000-8000-000000000001",
    title: "合成甲文档",
    content: "合成甲文档说明第一条流程约束。",
    sourceVersion: "1",
    sourceRef: "fixture:alpha",
    type: "text",
  },
  {
    id: "73000000-0000-4000-8000-000000000002",
    title: "合成乙文档",
    content: "合成乙文档补充第二条流程约束。",
    sourceVersion: "2",
    sourceRef: "fixture:beta",
    type: "text",
  },
];
const runId = "73000000-0000-4000-8000-000000000010";
const citations = files.map((file) => ({
  assetId: file.id,
  title: file.title,
  sourceVersion: file.sourceVersion,
  sourceRef: file.sourceRef,
  start: 0,
  end: file.content.length,
  reference:
    "asset:" +
    file.id +
    "@" +
    file.sourceVersion +
    "#chars=0-" +
    file.content.length,
}));
async function setup(page: any) {
  await page.request.post("/api/auth/demo", { data: {} });
  const view = await (await page.request.get("/api/workspace")).json();
  for (const engine of ["dsh", "hermes"])
    view.engines[engine] = {
      configured: true,
      evidence: "UI protocol fixture",
      operations: ["query_knowledge"],
      modelProviders: ["openai-compatible"],
    };
  await page.route("**/api/workspace**", (route: any) =>
    route.fulfill({ json: view }),
  );
  await page.route("**/api/models", (route: any) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/knowledge?q=*", (route: any) =>
    route.fulfill({ json: files }),
  );
  let posted: any;
  await page.route("**/api/runs", (route: any) => {
    posted = route.request().postDataJSON();
    return route.fulfill({ json: { id: runId, state: "queued" } });
  });
  const result = () => ({
    id: runId,
    state: "succeeded",
    workflow: "query_knowledge",
    engine: "hermes",
    knowledgePlan: posted.knowledgePlan,
    knowledgeAnswer: {
      content:
        "合成回答：两份资料支持分步验收 [" +
        citations[0].reference +
        "] [" +
        citations[1].reference +
        "]，仅覆盖已选片段。",
      citations,
      partial: true,
    },
    result: { text: "Synthetic private retrieval response", receipts: [] },
    contextRefs: citations.map((c) => c.reference),
  });
  await page.route("**/api/runs/" + runId, (route: any) =>
    route.fulfill({ json: result() }),
  );
  await page.route("**/api/knowledge/citation", (route: any) => {
    const input = route.request().postDataJSON(),
      i = files.findIndex((file) => file.id === input.assetId);
    return route.fulfill({
      json: { ...citations[i], content: files[i].content },
    });
  });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "知识库", exact: true })
    .click();
  await page.getByRole("textbox", { name: "检索资料" }).fill("流程约束");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await page.getByRole("checkbox", { name: "加入本次资料问答" }).nth(0).check();
  await page.getByRole("checkbox", { name: "加入本次资料问答" }).nth(1).check();
  return { posted: () => posted };
}
test("Selected multi-file questions keep exact source versions, private answers and readable citations on desktop/mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      ["warning", "error"].includes(m.type()) &&
      !m.text().includes("401 (Unauthorized)")
    )
      errors.push(m.text());
  });
  const state = await setup(page),
    panel = page.getByRole("region", { name: "选定资料 AI 问答" });
  expect(page.url()).toBe(testOrigin + "/");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await panel
    .getByRole("textbox", { name: "资料问题" })
    .fill("比较两份资料的流程约束");
  await panel
    .getByRole("combobox", { name: "问答执行器" })
    .selectOption("hermes");
  await expect(
    panel.getByRole("button", { name: "让 AI 回答选定资料" }),
  ).toBeDisabled();
  await panel
    .getByRole("checkbox", { name: /确认使用已选资料与此问题/ })
    .check();
  await page.screenshot({ path: "/tmp/hyper-delivery-knowledge-desktop.png" });
  await panel.getByRole("button", { name: "让 AI 回答选定资料" }).click();
  await expect(
    panel.getByRole("heading", { name: "私人回答", exact: true }),
  ).toBeVisible();
  expect(state.posted().workflow).toBe("query_knowledge");
  expect(state.posted().engine).toBe("hermes");
  expect(state.posted().knowledgePlan.assetRefs).toEqual(
    files.map(({ id, sourceVersion }) => ({ id, sourceVersion })),
  );
  expect(state.posted().knowledgePlan.query).toBe("比较两份资料的流程约束");
  expect(state.posted()).not.toHaveProperty("content");
  await panel.getByText("实际引用 · 2", { exact: true }).click();
  await panel.getByRole("button", { name: "查看此引用片段" }).first().click();
  const source = panel.getByRole("complementary", { name: "当前来源片段" });
  await expect(source).toContainText(files[0].content);
  await page.setViewportSize({ width: 390, height: 844 });
  await source.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: "/tmp/hyper-delivery-knowledge-mobile.png" });
  await panel.getByRole("button", { name: "关闭来源片段" }).click();
  await expect(source).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("Known source denial clears answers and selections; a late citation cannot restore private content", async ({
  page,
}) => {
  await setup(page);
  const panel = page.getByRole("region", { name: "选定资料 AI 问答" });
  await panel
    .getByRole("checkbox", { name: /确认使用已选资料与此问题/ })
    .check();
  await panel.getByRole("button", { name: "让 AI 回答选定资料" }).click();
  await expect(
    panel.getByRole("heading", { name: "私人回答", exact: true }),
  ).toBeVisible();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (entered = r));
  await page.route("**/api/knowledge/citation", async (route) => {
    entered();
    await gate;
    await route.fulfill({
      json: { ...citations[0], content: "LATE_PRIVATE_CITATION_SENTINEL" },
    });
  });
  await panel.getByText("实际引用 · 2", { exact: true }).click();
  await panel.getByRole("button", { name: "查看此引用片段" }).first().click();
  await seen;
  await page.route("**/api/runs/" + runId, (route) =>
    route.fulfill({
      status: 403,
      json: { message: "Synthetic source permission removed" },
    }),
  );
  await panel.getByRole("button", { name: "重新核对回答来源" }).click();
  await expect(panel.getByRole("alert")).toContainText("permission removed");
  release();
  await expect(
    panel.getByRole("heading", { name: "私人回答", exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByText("LATE_PRIVATE_CITATION_SENTINEL")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("checkbox", { name: "加入本次资料问答" }),
  ).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "资料问题" })).toHaveValue(
    "",
  );
});
