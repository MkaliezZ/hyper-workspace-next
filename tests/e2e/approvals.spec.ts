import { expect, test, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { issueSession } from "../../apps/api/src/core/security.js";

test("The approval workbench publishes a flow, submits a form and records a confirmed mobile review", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl || !new URL(dbUrl).pathname.endsWith("_test"))
    throw Error("Isolated test database required");
  const db = new Database(dbUrl);
  const workspaceId = randomUUID(),
    admin = randomUUID(),
    requester = randomUUID(),
    reviewer = randomUUID();
  const project = randomUUID();
  const contexts: BrowserContext[] = [];
  const origin = process.env.HYPER_TEST_ORIGIN ?? "http://127.0.0.1:5173";
  async function open(userId: string, mobile = false) {
    const context = await browser.newContext({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1504, height: 1045 },
    });
    contexts.push(context);
    await context.addCookies([
      {
        name: "hyper_session",
        value: await issueSession(db, userId, workspaceId, true),
        url: origin,
        httpOnly: true,
      },
    ]);
    const page = await context.newPage();
    await page.goto(origin);
    const nav = page.getByRole(mobile ? "complementary" : "navigation", {
      name: mobile ? "应用导航" : "工作区导航",
    });
    await nav.getByRole("button", { name: "审批", exact: true }).click();
    return {
      page,
      panel: page.getByRole("region", { name: "企业审批", exact: true }),
    };
  }
  try {
    await db.pool.query(
      "INSERT INTO cw_workspaces(id,name)VALUES($1,'Synthetic approval UI')",
      [workspaceId],
    );
    for (const [id, name, role] of [
      [admin, "流程管理员", "admin"],
      [requester, "申请员工", "member"],
      [reviewer, "审批员工", "member"],
    ] as const) {
      await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
        id,
        name,
      ]);
      await db.pool.query(
        "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,$3)",
        [workspaceId, id, role],
      );
    }
    await db.pool.query(
      "INSERT INTO cw_projects(id,workspace_id,name) VALUES($1,$2,'审批合成项目')",
      [project, workspaceId],
    );
    await db.pool.query(
      "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES($1,$2,$3)",
      [randomUUID(), workspaceId, project],
    );
    const manager = await open(admin);
    await manager.panel
      .getByRole("button", { name: "发布新流程", exact: true })
      .click();
    const publish = manager.page.getByRole("dialog", {
      name: "发布审批流程",
      exact: true,
    });
    await publish
      .getByRole("textbox", { name: "流程名称", exact: true })
      .fill("采购申请验收");
    await publish
      .getByRole("textbox", { name: "字段 1 名称", exact: true })
      .fill("金额（分）");
    await publish
      .getByRole("combobox", { name: "字段 1 类型", exact: true })
      .selectOption("integer");
    await publish
      .getByRole("button", { name: "添加字段", exact: true })
      .click();
    await publish
      .getByRole("textbox", { name: "字段 2 名称", exact: true })
      .fill("用途说明");
    await publish
      .getByRole("textbox", { name: "阶段 1 名称", exact: true })
      .fill("部门核对");
    await publish
      .getByRole("textbox", { name: "阶段 1 步骤 1 名称", exact: true })
      .fill("审批意见");
    await publish
      .getByRole("textbox", { name: "审批人 ID", exact: true })
      .fill(reviewer);
    await publish
      .getByRole("button", { name: "添加审批人", exact: true })
      .click();
    await publish
      .getByRole("button", { name: "添加条件", exact: true })
      .click();
    await publish
      .getByRole("combobox", { name: "比较方式", exact: true })
      .selectOption("gte");
    await publish
      .getByRole("spinbutton", { name: "条件值", exact: true })
      .fill("10000");
    await manager.page.screenshot({
      path: "/tmp/hyper-next-approval-builder.png",
    });
    await publish
      .getByRole("button", { name: "确认发布流程版本", exact: true })
      .click();
    await expect(publish).not.toBeVisible();

    const worker = await open(requester);
    await worker.panel
      .getByRole("combobox", { name: "审批流程", exact: true })
      .selectOption({ label: "采购申请验收 · v1" });
    await worker.panel
      .getByRole("button", { name: "发起申请", exact: true })
      .click();
    const detail = worker.panel.getByRole("article", { name: "审批详情" });
    await detail
      .getByRole("spinbutton", { name: "金额（分）", exact: true })
      .fill("15000");
    await detail
      .getByRole("textbox", { name: "用途说明", exact: true })
      .fill("合成样例 · 会议室用品");
    await detail
      .getByRole("button", { name: "确认提交申请", exact: true })
      .click();
    await expect(detail.getByText("审批中", { exact: true })).toBeVisible();
    await detail
      .getByRole("button", { name: "催办 审批员工", exact: true })
      .click();
    await expect(worker.panel.getByRole("status")).toContainText("催办已记录");
    await worker.page.screenshot({
      path: "/tmp/hyper-next-approvals-desktop.png",
    });

    const checker = await open(reviewer, true);
    await checker.panel
      .getByRole("region", { name: "待处理催办" })
      .getByRole("button", { name: /采购申请验收/ })
      .click();
    const review = checker.panel.getByRole("article", { name: "审批详情" });
    await expect(
      review.getByText("合成样例 · 会议室用品", { exact: true }),
    ).toBeVisible();
    await review.getByRole("button", { name: "同意", exact: true }).click();
    const confirm = checker.page.getByRole("dialog", {
      name: "确认同意",
      exact: true,
    });
    await confirm
      .getByRole("textbox", { name: "处理说明", exact: true })
      .fill("已核对合成采购用途");
    await checker.page.screenshot({
      path: "/tmp/hyper-next-approvals-mobile.png",
    });
    await confirm
      .getByRole("button", { name: "确认操作", exact: true })
      .click();
    await expect(review.getByText("已通过", { exact: true })).toBeVisible();
    await expect(
      checker.panel.getByRole("region", { name: "待处理催办" }),
    ).toHaveCount(0);
    expect(
      await checker.page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await worker.panel
      .getByRole("button", { name: "刷新", exact: true })
      .click();
    await expect(detail.getByText("已通过", { exact: true })).toBeVisible();
    await detail.getByText(/审批记录/).click();
    await expect(
      detail.getByText("已核对合成采购用途", { exact: true }),
    ).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await db.close();
  }
});
