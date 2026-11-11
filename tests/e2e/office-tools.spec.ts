import { test, expect, type Page } from "@playwright/test";
import type { OfficeProposalResult } from "@hyper/contracts/office";

const file = {
  id: "97",
  path: ["办公室方案.docx"],
  name: "办公室方案.docx",
  kind: "file",
  size: 1000,
  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  etag: '"v1"',
  importable: true,
};
const source = {
  path: file.path,
  expectedId: file.id,
  expectedEtag: file.etag,
};
const id = "50000000-0000-4000-8000-000000000007";
const sha = "a".repeat(64);
const engine = "collabora-26.04.6.1/pyuno-26.04.6-1";

async function open(
  page: Page,
  extra: (state: {
    proposal?: OfficeProposalResult;
    allowed: boolean;
  }) => Promise<void>,
) {
  await page.request.post("/api/auth/demo", { data: {} });
  const view = await (await page.request.get("/api/workspace")).json();
  view.user.demo = false;
  view.tasks = [];
  view.artifacts = [];
  for (const name of ["dsh", "hermes"])
    view.engines[name] = {
      configured: true,
      operations: ["draft_office", "apply_office"],
      evidence: "UI protocol fixture",
      modelProviders: ["openai-compatible"],
    };
  const state: { proposal?: OfficeProposalResult; allowed: boolean } = {
    allowed: true,
  };
  await page.route("**/api/workspace", (r) => r.fulfill({ json: view }));
  await page.route("**/api/auth/status", (r) =>
    r.fulfill({
      json: {
        demoEnabled: true,
        nextcloudConfigured: true,
        filesEnabled: true,
        officeEnabled: true,
      },
    }),
  );
  await page.route("**/api/files/list", (r) => r.fulfill({ json: [file] }));
  await page.route("**/api/files/imports", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/models", (r) =>
    r.fulfill({
      json: [
        {
          id,
          name: "协议模型",
          purpose: "chat",
          provider: "openai-compatible",
        },
      ],
    }),
  );
  await page.route("**/api/office/lookup", (r) =>
    state.allowed
      ? r.fulfill({ json: [] })
      : r.fulfill({ status: 403, json: { message: "来源权限已撤销" } }),
  );
  await page.route("**/api/office/inspect", (r) =>
    r.fulfill({
      json: {
        source,
        binding: sha,
        format: "docx",
        sourceSha256: sha,
        engine,
        inspection: {
          paragraphs: [
            { id: "paragraph:0", text: "需要修改的旧段落", editable: true },
            { id: "paragraph:1", text: "含复杂内容的段落", editable: false },
          ],
          appendTarget: "document:end",
        },
      },
    }),
  );
  await page.route("**/api/office/proposals", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ json: state.proposal ? [state.proposal] : [] })
      : r.fallback(),
  );
  await page.route(`**/api/office/proposals/${id}`, (r) =>
    r.fulfill({ json: state.proposal }),
  );
  await extra(state);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: "知识库", exact: true })
    .click();
  await page.getByRole("tab", { name: "企业文件", exact: true }).click();
  await page.getByRole("button", { name: "Office 助手", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Office 助手" }).getByLabel("修改位置"),
  ).toBeVisible();
  return state;
}

test("Office opens one structure inspection despite StrictMode effect replay", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { inspections: 0 };
    Object.assign(window, { officeEffectProbe: state });
    const original = window.fetch;
    window.fetch = (input, options) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      if (url.pathname === "/api/office/inspect") state.inspections++;
      return original.call(window, input, options);
    };
  });
  await open(page, async () => {});
  expect(
    await page.evaluate(
      () =>
        (window as Window & { officeEffectProbe: { inspections: number } })
          .officeEffectProbe.inspections,
    ),
  ).toBe(1);
});

test("Office manual proposals require saved review and explicit copy confirmation; uncertain saves reconcile without a second upload", async ({
  page,
}, testInfo) => {
  let saves = 0,
    creates = 0,
    reconciles = 0;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = await open(page, async (state) => {
    await page.route("**/api/office/proposals", async (r) => {
      if (r.request().method() === "GET")
        return r.fulfill({ json: state.proposal ? [state.proposal] : [] });
      const body = r.request().postDataJSON();
      creates++;
      expect(body.source).toEqual(source);
      expect(body.expectedSha256).toBe(sha);
      expect(body.destination).toEqual([]);
      expect(body.operations).toEqual([
        {
          kind: "writer.replace",
          target: "paragraph:0",
          expectedText: "需要修改的旧段落",
          text: "人工修改的新段落",
        },
      ]);
      state.proposal = {
        id,
        revision: 1,
        state: "prepared",
        sourceStatus: "current",
        source,
        sourceSha256: sha,
        format: "docx",
        title: file.name,
        destination: [],
        targetPath: ["new-copy.docx"],
        operations: body.operations,
        preview: {
          operations: [
            {
              kind: "writer.replace",
              target: "paragraph:0",
              before: "需要修改的旧段落",
              after: "人工修改的新段落",
            },
          ],
          recalculated: false,
          formulaErrors: [],
          reopenedVerified: true,
        },
        engine,
        error: null,
        retryable: false,
        cancelRequested: false,
        outputSha256: null,
        file: null,
        sourceRunId: null,
        applyRunId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return r.fulfill({ json: state.proposal });
    });
    await page.route(`**/api/office/proposals/${id}/apply`, (r) => {
      expect(r.request().postDataJSON()).toMatchObject({
        confirmed: true,
        expectedRevision: 1,
      });
      saves++;
      state.proposal = {
        ...state.proposal!,
        state: "recovery_required",
        outputSha256: "b".repeat(64),
      };
      return r.fulfill({ json: state.proposal });
    });
    await page.route(`**/api/office/proposals/${id}/reconcile`, (r) => {
      reconciles++;
      state.proposal = {
        ...state.proposal!,
        state: "succeeded",
        file: {
          ...file,
          kind: "file",
          id: "98",
          path: ["new-copy.docx"],
          name: "new-copy.docx",
          etag: '"output1"',
        },
      };
      return r.fulfill({ json: state.proposal });
    });
  });
  const dialog = page.getByRole("dialog", { name: "Office 助手" });
  await expect(dialog.getByRole("option", { name: /含复杂内容/ })).toHaveCount(
    0,
  );
  await dialog.getByLabel("修改位置").selectOption("paragraph:0");
  await dialog.getByLabel("修改后内容").fill("人工修改的新段落");
  await dialog
    .getByRole("button", { name: "加入修改方案", exact: true })
    .click();
  expect(saves).toBe(0);
  await dialog
    .getByRole("button", { name: "校验并保存方案", exact: true })
    .click();
  await expect(
    dialog.getByRole("region", { name: "Office 修改前后对照" }),
  ).toContainText("需要修改的旧段落");
  await expect(
    dialog.getByRole("button", { name: "确认生成可编辑副本" }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await expect(
    dialog.getByRole("button", { name: "确认生成可编辑副本" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "编辑条目 1", exact: true }).click();
  await dialog.getByLabel("修改后内容").fill("尚未加入方案的输入");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "确认生成可编辑副本" }),
  ).toBeDisabled();
  await expect(dialog).toContainText("输入尚未加入修改方案");
  await dialog.getByRole("button", { name: "放弃输入" }).click();
  await dialog.getByRole("checkbox").check();
  await page.screenshot({
    path: testInfo.outputPath("office-tools-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("office-tools-mobile.png"),
  });
  await dialog.getByRole("button", { name: "确认生成可编辑副本" }).click();
  await expect(dialog).toContainText("保存结果尚未确认");
  await expect(
    dialog.getByRole("button", { name: "确认生成可编辑副本" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "核对实际保存结果" }).click();
  await expect(dialog).toContainText("副本已保存并回读校验");
  expect(creates).toBe(1);
  expect(saves).toBe(1);
  expect(reconciles).toBe(1);
  state.allowed = false;
  await expect(
    dialog.getByText("人工修改的新段落", { exact: true }),
  ).toHaveCount(0, { timeout: 12000 });
  await expect(dialog.getByLabel("修改位置")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Both Office assistant choices submit a bound draft request and never upload on drafting", async ({
  page,
}) => {
  const drafts: any[] = [];
  await open(page, async () => {
    await page.route("**/api/office/runs", (r) => {
      drafts.push(r.request().postDataJSON());
      return r.fulfill({ json: { id, state: "failed" } });
    });
    await page.route(`**/api/runs/${id}`, (r) =>
      r.fulfill({
        json: {
          id,
          state: "failed",
          workflow: "draft_office",
          engine: "dsh",
          instruction: "synthetic",
          error: "明确的协议测试结果",
        },
      }),
    );
    await page.route(`**/api/runs/${id}/events**`, (r) =>
      r.fulfill({ json: [] }),
    );
  });
  const dialog = page.getByRole("dialog", { name: "Office 助手" });
  for (const executor of ["dsh", "hermes"]) {
    await dialog.getByLabel("执行方式").selectOption(executor);
    await dialog
      .getByRole("combobox", { name: "模型", exact: true })
      .selectOption(id);
    await dialog.getByLabel("希望如何修改").fill("简化第一段，保留事实");
    await dialog.getByRole("button", { name: "起草修改方案" }).click();
    await expect.poll(() => drafts.length).toBe(executor === "dsh" ? 1 : 2);
    const last = drafts.at(-1);
    expect(last.engine).toBe(executor);
    expect(last.plan).toEqual({
      operation: "draft",
      source,
      expectedSha256: sha,
      destination: [],
      instruction: "简化第一段，保留事实",
    });
    expect(last.plan.confirmed).toBeUndefined();
    expect(last.plan.operations).toBeUndefined();
  }
});
