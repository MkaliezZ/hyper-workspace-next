import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
export const source = process.env.NEXTCLOUD_URL!,
  password = process.env.NC_TEST_PASSWORD!,
  origin = process.env.HYPER_TEST_ORIGIN ?? "http://127.0.0.1:5173";
async function grant(popup: Page, uid: string) {
  const errors: string[] = [];
  popup.on("pageerror", (error) =>
    errors.push(error.message.replaceAll(password, "[redacted]").slice(0, 300)),
  );
  try {
    await popup
      .getByRole("link", { name: "Log in", exact: true })
      .or(popup.getByRole("button", { name: "Log in", exact: true }))
      .click({ noWaitAfter: true });
    await popup.locator('input[name="user"]').fill(uid);
    await popup.locator('input[name="password"]').fill(password);
    await popup
      .locator('form[name="login"]')
      .locator('button[type="submit"]')
      .click({ noWaitAfter: true });
    await popup
      .getByRole("button", { name: "Grant access", exact: true })
      .click({ noWaitAfter: true });
  } catch (error) {
    // Synthetic CI accounts only. Never dump cookies, form values, page HTML or request bodies.
    const text = await popup
      .locator("body")
      .innerText({ timeout: 2000 })
      .catch(() => "Page unavailable");
    console.error(
      "Nextcloud authorization UI:",
      text.replaceAll(password, "[redacted]").slice(0, 3000),
    );
    console.error("Nextcloud page errors:", JSON.stringify(errors));
    throw error;
  }
}
export async function login(browser: Browser, uid: string) {
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  await page.goto(origin);
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "使用企业账号登录" }).click();
  await grant(await popup, uid);
  return { context, page };
}
export async function group(method: "POST" | "DELETE", uid: string) {
  const response = await fetch(
    source + "/ocs/v2.php/cloud/users/" + uid + "/groups?format=json",
    {
      method,
      headers: {
        Authorization:
          "Basic " + Buffer.from("nc-admin:" + password).toString("base64"),
        "OCS-APIRequest": "true",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ groupid: "hyper-members" }),
      redirect: "error",
    },
  );
  expect(response.status).toBe(200);
  expect((await response.json()).ocs.meta.statuscode).toBe(200);
}
export async function view(context: BrowserContext) {
  return context.request.get(origin + "/api/workspace");
}
