import { testOrigin } from "./origin";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
test("Decision proposals require separate version confirmation, preserve histories and replace adopted records on desktop and mobile", async ({
  page,
  request,
}) => {
  await page.request.post("/api/auth/demo", { data: {} });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      ["warning", "error"].includes(m.type()) &&
      !m.text().includes("401 (Unauthorized)")
    )
      errors.push(m.text());
  });
  await page.goto("/");
  await expect(page).toHaveTitle(/Hyper Workspace/);
  expect(page.url()).toBe(testOrigin + "/");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByRole("tab", { name: "决定", exact: true }).click();
  const panel = page.getByRole("region", { name: "项目决定" }),
    title = "合成决定 " + randomUUID();
  await panel
    .getByRole("textbox", { name: "决定标题", exact: true })
    .fill(title);
  await panel
    .getByRole("textbox", { name: "决定内容", exact: true })
    .fill("合成项目先验证业务对象与实际权限，再确认交付。");
  await panel
    .getByRole("textbox", { name: "理由与约束", exact: true })
    .fill("这是测试资料，不是公司制度。");
  await panel
    .getByRole("button", { name: "保存待确认提议", exact: true })
    .click();
  await expect(panel.getByText(/当前保存版本 v1/)).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "确认此决定", exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole("textbox", { name: "决定内容", exact: true })
    .fill("合成人工修订：先检查权限与真实对象，再提交交付验收。");
  await expect(
    panel.getByRole("checkbox", { name: /我已核对已保存的/ }),
  ).toBeDisabled();
  await panel
    .getByRole("button", { name: "保存待确认提议", exact: true })
    .click();
  await expect(panel.getByText(/当前保存版本 v2/)).toBeVisible();
  await panel.getByRole("checkbox", { name: /我已核对已保存的 v2/ }).check();
  await page.screenshot({ path: "/tmp/hyper-delivery-decisions-desktop.png" });
  await panel.getByRole("button", { name: "确认此决定", exact: true }).click();
  await expect(panel.getByText(/当前保存版本 v3.*已确认决定/)).toBeVisible();
  await expect(
    panel.getByRole("textbox", { name: "决定内容", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "新建提议", exact: true }).click();
  await panel
    .getByRole("textbox", { name: "决定标题", exact: true })
    .fill(title + " 替代");
  await panel
    .getByRole("textbox", { name: "决定内容", exact: true })
    .fill("这是合成替代方向，历史仍然保留。");
  await panel
    .getByRole("button", { name: "保存待确认提议", exact: true })
    .click();
  const replacement = panel.getByRole("combobox", {
    name: "确认时替代哪个已有决定（可选）",
  });
  await replacement.selectOption({ label: title + " · v3" });
  await panel.getByRole("checkbox", { name: /我已核对已保存的 v1/ }).check();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel
    .getByRole("button", { name: "确认此决定", exact: true })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: "/tmp/hyper-delivery-decisions-mobile.png" });
  await panel.getByRole("button", { name: "确认此决定", exact: true }).click();
  await expect(panel.getByText(/当前保存版本 v2.*已确认决定/)).toBeVisible();
  await panel
    .getByRole("navigation", { name: "决定列表" })
    .getByRole("button", { name: title + " 已被替代 · v4", exact: true })
    .click();
  await expect(panel.getByText(/当前保存版本 v4.*已被替代/)).toBeVisible();
  await panel.getByText(/决定历史/).click();
  await expect(
    panel.getByText("v3 · 已确认决定 · 人工记录", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("Lost decision save replays the original key and a denied read clears the private editor", async ({
  page,
  request,
}) => {
  await page.request.post("/api/auth/demo", { data: {} });
  const title = "合成请求核对 " + randomUUID(),
    posts: any[] = [];
  let failed = false;
  await page.route("**/api/projects/*/decisions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts.push(route.request().postDataJSON());
    const result = await route.fetch();
    if (!failed) {
      failed = true;
      return route.abort("failed");
    }
    return route.fulfill({ response: result });
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "决定", exact: true }).click();
  const panel = page.getByRole("region", { name: "项目决定" });
  await panel
    .getByRole("textbox", { name: "决定标题", exact: true })
    .fill(title);
  await panel
    .getByRole("textbox", { name: "决定内容", exact: true })
    .fill("合成私有草稿，不应在失去访问后保留。");
  await panel
    .getByRole("button", { name: "保存待确认提议", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "核对原保存请求" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("textbox", { name: "决定标题", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "核对原保存请求" }).click();
  await expect(panel.getByText(/当前保存版本 v1/)).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  await page.route("**/api/decisions/*", (route) =>
    route.fulfill({
      status: 403,
      json: { message: "Synthetic source access revoked" },
    }),
  );
  await panel
    .getByRole("navigation", { name: "决定列表" })
    .getByRole("button", { name: title + " 待确认提议 · v1", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("revoked");
  await expect(
    panel.getByRole("textbox", { name: "决定内容", exact: true }),
  ).toHaveValue("");
  await expect(
    panel.getByRole("textbox", { name: "决定内容", exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole("navigation", { name: "决定列表" }).getByRole("button"),
  ).toHaveCount(0);
});
