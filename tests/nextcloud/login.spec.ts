import { test, expect } from "@playwright/test";
import { source, password, origin, login, group, view } from "./helpers";
import { Database } from "../../apps/api/src/db/database.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
import { execFileSync } from "node:child_process";
import { Agent, get } from "node:http";
import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
const db = new Database(process.env.TEST_DATABASE_URL);
if (!source || !password || !process.env.TEST_DATABASE_URL?.endsWith("_test"))
  throw new Error(
    "Only an isolated synthetic Nextcloud test environment is allowed.",
  );
test.afterAll(async () => {
  await db.close();
});
test("Idle HTTP clients leave a bounded source worker pool available for fresh identity traffic", async () => {
  const endpoint = source + "/status.php",
    agent = new Agent({ keepAlive: true, maxSockets: 24, maxFreeSockets: 24 });
  let completed = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const clients = Array.from(
    { length: 24 },
    () =>
      new Promise<void>((resolve) => {
        const request = get(endpoint, { agent }, (response) => {
          response.resume();
          response.once("end", () => {
            if (++completed === 8) release();
            resolve();
          });
        });
        request.setTimeout(12000, () => request.destroy());
        request.once("error", () => resolve());
        request.once("close", () => resolve());
      }),
  );
  let gateTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate,
      new Promise<never>((_resolve, reject) => {
        gateTimeout = setTimeout(
          () =>
            reject(new Error("Source clients did not reach the bounded gate.")),
          12000,
        );
      }),
    ]);
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).installed).toBe(true);
  } finally {
    clearTimeout(gateTimeout);
    agent.destroy();
    await Promise.allSettled(clients);
  }
});
test("Cold source login assets on a slow connection leave capacity for device-flow polling", async ({
  browser,
}) => {
  test.setTimeout(180000);
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const page = await context.newPage(),
      pollFailures: number[] = [];
    page.on("response", (response) => {
      if (
        response.url().endsWith("/api/auth/nextcloud/poll") &&
        response.status() >= 400
      )
        pollFailures.push(response.status());
    });
    // Real source assets and HTTP connections; no fulfilled requests or synthetic login response.
    let throttle: Promise<void> | undefined;
    context.on("page", (popup) => {
      throttle = (async () => {
        const cdp = await context.newCDPSession(popup);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 100,
          downloadThroughput: 64 * 1024,
          uploadThroughput: 64 * 1024,
        });
      })();
    });
    await page.goto(origin);
    const opened = page.waitForEvent("popup");
    const started = page.waitForResponse((response) =>
      response.url().endsWith("/api/auth/nextcloud/start"),
    );
    await page
      .getByRole("button", { name: "使用企业账号登录", exact: true })
      .click();
    const popup = await opened;
    const loginUrl = (await (await started).json()).loginUrl;
    await throttle;
    await popup
      .getByRole("link", { name: "Log in", exact: true })
      .or(popup.getByRole("button", { name: "Log in", exact: true }))
      .click({ timeout: 120000 });
    await popup.locator('input[name="user"]').fill("employee-one");
    await popup.locator('input[name="password"]').fill(password);
    await popup.locator('form[name="login"] button[type="submit"]').click();
    await popup
      .getByRole("button", { name: "Grant access", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible({ timeout: 30000 });
    expect(pollFailures).toEqual([]);
    expect((await (await view(context)).json()).user.demo).toBe(false);
    const flowToken = new URL(loginUrl).pathname.split("/").at(-1)!;
    const sourceLogs = execFileSync(
      "docker",
      ["logs", "hyper-nextcloud-test"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (sourceLogs.includes(flowToken))
      throw new Error(
        "Source access logs exposed a one-shot authorization token.",
      );
    expect(sourceLogs).toMatch(/hyper_source status=\d{3} duration_us=\d+/);
  } finally {
    await context.close();
  }
});
test("Real Nextcloud Login Flow v2 returns a source-backed product session and persists a discussion", async ({
  browser,
}) => {
  const { context, page } = await login(browser, "employee-one");
  try {
    await expect(
      page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    const response = await view(context),
      workspace = await response.json();
    expect(response.status()).toBe(200);
    expect(workspace.user.role).toBe("admin");
    expect(workspace.user.demo).toBe(false);
    expect(workspace.user.identityCredentialId).toBeUndefined();
    const cookies = await context.cookies(origin),
      session = cookies.find((c) => c.name === "hyper_session")!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe("Strict");
    expect(await page.evaluate(() => document.cookie)).not.toContain(
      "hyper_session",
    );
    const message = "真实 Nextcloud 测试账号授权后的产品讨论";
    await page.getByRole("textbox", { name: "讨论内容" }).fill(message);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    const sourceIdentity = (
      await db.pool.query(
        "SELECT remote_uid FROM cw_external_identities WHERE user_id=$1",
        [workspace.user.id],
      )
    ).rows[0];
    expect(sourceIdentity.remote_uid).toBe("employee-one");
  } finally {
    await context.close();
  }
});
test("Real per-device app token revocation and source group removal constrain subsequent product requests", async ({
  browser,
}) => {
  const one = await login(browser, "employee-two"),
    two = await login(browser, "employee-two");
  try {
    await expect(
      one.page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    await expect(
      two.page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    const first = await (await view(one.context)).json(),
      second = await (await view(two.context)).json();
    expect(first.user.id).toBe(second.user.id);
    expect(first.user.role).toBe("member");
    const sessionCookie = (await one.context.cookies(origin)).find(
      (c) => c.name === "hyper_session",
    )!.value;
    const { digest } = await import("../../apps/api/src/core/credentials.js");
    const credential = (
      await db.pool.query(
        "SELECT c.login_name,c.credential_enc FROM cw_sessions s JOIN cw_identity_credentials c ON c.id=s.identity_credential_id WHERE s.token_hash=$1",
        [digest(sessionCookie)],
      )
    ).rows[0];
    const token = new Vault().decrypt(credential.credential_enc);
    const revoked = await fetch(
      source + "/ocs/v2.php/core/apppassword?format=json",
      {
        method: "DELETE",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(credential.login_name + ":" + token).toString("base64"),
          "OCS-APIRequest": "true",
        },
        redirect: "error",
      },
    );
    expect(revoked.status).toBe(200);
    expect((await view(one.context)).status()).toBe(401);
    expect((await view(two.context)).status()).toBe(200);
    await group("DELETE", "employee-two");
    expect((await view(two.context)).status()).toBe(403);
    await group("POST", "employee-two");
    const again = await login(browser, "employee-two");
    try {
      await expect(again.page.getByRole("alert")).toContainText(
        "产品权限已撤销",
      );
    } finally {
      await again.context.close();
    }
  } finally {
    await one.context.close();
    await two.context.close();
  }
});
test("Upstream admin status does not grant product admin; flow endpoints enforce Origin and browser binding", async ({
  browser,
  request,
}) => {
  const { context, page } = await login(browser, "nc-admin");
  try {
    await expect(
      page.getByRole("heading", { name: "团队讨论", exact: true }),
    ).toBeVisible();
    expect((await (await view(context)).json()).user.role).toBe("member");
    const wrong = await request.post(origin + "/api/auth/nextcloud/start", {
      headers: { Origin: "https://attacker.invalid" },
      data: {},
    });
    expect(wrong.status()).toBe(403);
    const start = await context.request.post(
      origin + "/api/auth/nextcloud/start",
      { headers: { Origin: origin }, data: {} },
    );
    const flow = await start.json();
    expect(start.status()).toBe(201);
    expect(Object.keys(flow).sort()).toEqual([
      "expiresAt",
      "flowId",
      "loginUrl",
    ]);
    const stolen = await request.post(origin + "/api/auth/nextcloud/poll", {
      headers: { Origin: origin },
      data: { flowId: flow.flowId },
    });
    expect(stolen.status()).toBe(403);
    expect(
      (
        await context.request.post(origin + "/api/auth/nextcloud/cancel", {
          headers: { Origin: origin },
          data: { flowId: flow.flowId },
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await context.request.post(origin + "/api/auth/nextcloud/poll", {
          headers: { Origin: origin },
          data: { flowId: flow.flowId },
        })
      ).status(),
    ).toBe(410);
    // Cancelling a separate pending flow must preserve the existing device session.
    expect((await view(context)).status()).toBe(200);
    expect(
      (
        await context.request.post(origin + "/api/auth/logout", {
          headers: { Origin: origin },
          data: {},
        })
      ).status(),
    ).toBe(201);
    expect((await view(context)).status()).toBe(401);
  } finally {
    await context.close();
  }
});

test("An approval assignment requires current real Nextcloud membership at the moment of signing", async ({
  browser,
}) => {
  test.setTimeout(180000);
  const reviewerUid = "calendar-bob";
  const contexts: BrowserContext[] = [];
  let revoked = false;
  async function employee(uid: string) {
    const loginResult = await login(browser, uid);
    contexts.push(loginResult.context);
    await expect
      .poll(async () => (await view(loginResult.context)).status())
      .toBe(200);
    const workspace = await (await view(loginResult.context)).json();
    return { context: loginResult.context, user: workspace.user };
  }
  const post = (context: BrowserContext, path: string, data: object) =>
    context.request.post(origin + "/api/approvals/" + path, {
      headers: { Origin: origin },
      data: { ...data, idempotencyKey: randomUUID() },
    });
  try {
    const admin = await employee("employee-one");
    const applicant = await employee("calendar-alice");
    const reviewer = await employee(reviewerUid);
    const publication = await post(admin.context, "flows", {
      definition: {
        title: "Synthetic approval source boundary",
        fields: [
          { key: "reason", label: "Reason", kind: "text", required: true },
        ],
        stages: [
          {
            label: "Review",
            steps: [
              {
                key: "sign",
                label: "Sign",
                reviewers: [reviewer.user.id],
                requiredApprovals: 1,
              },
            ],
          },
        ],
      },
    });
    await expect(publication).toBeOK();
    const { id: flowId, version } = await publication.json();
    const created = await post(applicant.context, "requests", {
      flowId,
      version,
    });
    await expect(created).toBeOK();
    const draft = await created.json();
    const actions = "requests/" + draft.id + "/actions";
    const submitted = await post(applicant.context, actions, {
      operation: "submit",
      expectedRevision: draft.revision,
      form: { reason: "Synthetic scenario" },
      confirmed: true,
    });
    await expect(submitted).toBeOK();
    const active = await submitted.json();
    await expect(
      await reviewer.context.request.get(
        origin + "/api/approvals/requests/" + draft.id,
      ),
    ).toBeOK();
    await group("DELETE", reviewerUid);
    revoked = true;
    const vote = {
      operation: "review",
      attempt: active.attempt,
      step: "sign",
      assignmentVersion: 1,
      decision: "approve",
      confirmed: true,
    };
    expect((await post(reviewer.context, actions, vote)).status()).toBe(403);
    const unchanged = await applicant.context.request.get(
      origin + "/api/approvals/requests/" + draft.id,
    );
    await expect(unchanged).toBeOK();
    expect(await unchanged.json()).toMatchObject({
      state: "active",
      revision: active.revision,
    });
    await group("POST", reviewerUid);
    revoked = false;
    const restored = await employee(reviewerUid);
    expect(restored.user.id).toBe(reviewer.user.id);
    const signed = await post(restored.context, actions, vote);
    await expect(signed).toBeOK();
    expect(await signed.json()).toMatchObject({
      state: "approved",
      revision: active.revision + 1,
    });
  } finally {
    if (revoked) await group("POST", reviewerUid);
    await Promise.all(contexts.map((context) => context.close()));
  }
});
