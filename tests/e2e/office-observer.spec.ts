import { expect, test, type Frame } from "@playwright/test";
import { observeOffice } from "../nextcloud/office-helpers";

const sourceOrigin = "http://office-source.test";
const editorOrigin = "http://office-editor.test";
const foreignOrigin = "http://office-foreign.test";
const secret = "synthetic-token-must-not-appear";

test("Office loading observation rejects unrelated messages and sees the real editor in a nested host", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/cool/"))
        return route.fulfill({ status: 503, body: secret });
      const body =
        url.pathname === "/"
          ? `<iframe name="wrapper" src="${sourceOrigin}/wrapper"></iframe>`
          : url.pathname === "/wrapper"
            ? `<iframe data-cy="coolframe" name="correct" src="${editorOrigin}/editor?access_token=${secret}"></iframe>
             <iframe name="unrelated" src="${editorOrigin}/unrelated"></iframe>
             <iframe data-cy="coolframe" name="foreign" src="${foreignOrigin}/editor"></iframe>`
            : "<p>Synthetic editor protocol fixture</p>";
      return route.fulfill({ contentType: "text/html", body });
    });
    const office = await observeOffice(context, editorOrigin, sourceOrigin);
    const page = await context.newPage();
    await page.goto(sourceOrigin);
    const correct = page.frame({ name: "correct" })!;
    const unrelated = page.frame({ name: "unrelated" })!;
    const foreign = page.frame({ name: "foreign" })!;
    async function status(frame: Frame, value: string) {
      await frame.evaluate(
        ({ target, value }) => {
          window.parent.postMessage(
            JSON.stringify({
              MessageId: "App_LoadingStatus",
              Values: { Status: value },
            }),
            target,
          );
        },
        { target: sourceOrigin, value },
      );
    }

    await status(foreign, "Document_Loaded");
    await status(unrelated, "Document_Loaded");
    await correct.evaluate((target) => {
      window.parent.postMessage("not-json", target);
      window.parent.postMessage(
        JSON.stringify({
          MessageId: "Action_Load_Resp",
          Values: { success: true },
        }),
        target,
      );
    }, sourceOrigin);
    await status(correct, "Frame_Ready");
    await expect
      .poll(async () => (await office.diagnostics(page)).loading.length)
      .toBe(2);
    expect(office.hasLoaded(page)).toBe(false);

    // A loaded document in another tab must not satisfy this page's assertion.
    const otherPage = await context.newPage();
    await otherPage.goto(sourceOrigin);
    await status(otherPage.frame({ name: "correct" })!, "Document_Loaded");
    await office.waitForLoaded(otherPage, 5000);
    expect(office.hasLoaded(page)).toBe(false);

    await status(correct, "Document_Loaded");
    await office.waitForLoaded(page, 5000);
    expect((await office.diagnostics(page)).loading.at(-1)).toMatchObject({
      receiver: "nested",
      kind: "loading",
      status: "Document_Loaded",
    });

    // A real welcome/auxiliary iframe navigation can overlap the asynchronous
    // sender lookup. It must not discard the editor's Document_Loaded event.
    for (let attempt = 0; attempt < 5; attempt++) {
      await status(correct, "Frame_Ready");
      await expect.poll(() => office.hasLoaded(page)).toBe(false);
      await Promise.all([
        status(correct, "Document_Loaded"),
        unrelated.goto(editorOrigin + "/welcome?attempt=" + attempt),
      ]);
      await office.waitForLoaded(page, 5000);
    }

    await correct.evaluate(
      async ({ token }) => {
        await fetch(
          "/cool/" + encodeURIComponent(token) + "/ws?access_token=" + token,
        );
        setTimeout(() => {
          throw new Error(token);
        }, 0);
        console.debug(
          "_onSocketClose: code=1008 wasClean=true reason=" + token,
        );
      },
      { token: secret },
    );
    await expect
      .poll(async () => (await office.diagnostics(page)).network)
      .toEqual(
        expect.arrayContaining([
          { kind: "http-error", route: "editor-session", status: 503 },
          { kind: "page-error" },
          { kind: "socket-close-status", code: 1008, clean: true },
        ]),
      );
    expect(JSON.stringify(await office.diagnostics(page))).not.toContain(
      secret,
    );
    await status(correct, "Failed");
    await expect.poll(() => office.hasLoaded(page)).toBe(false);
    await status(correct, "Document_Loaded");
    await office.waitForLoaded(page, 5000);
    await correct.evaluate(
      (target) =>
        window.parent.postMessage(
          JSON.stringify({
            MessageId: "Action_Load_Resp",
            Values: { success: false },
          }),
          target,
        ),
      sourceOrigin,
    );
    await expect.poll(() => office.hasLoaded(page)).toBe(false);
    await status(correct, "Document_Loaded");
    await office.waitForLoaded(page, 5000);

    const host = page.frame({ name: "wrapper" })!;
    await host.locator('iframe[name="correct"]').evaluate((element) => {
      (element as HTMLElement).style.display = "none";
    });
    const hiddenError = await office.waitForLoaded(page, 200).then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    expect(hiddenError).toContain("must report Document_Loaded");
    expect(hiddenError).not.toContain(secret);
    await host.locator('iframe[name="correct"]').evaluate((element) => {
      (element as HTMLElement).style.display = "";
    });

    await correct.goto(editorOrigin + "/editor?changed=1");
    expect(office.hasLoaded(page)).toBe(false);
    await status(correct, "Document_Loaded");
    await office.waitForLoaded(page, 5000);
    await host
      .locator('iframe[name="correct"]')
      .evaluate((element) => element.replaceWith(element.cloneNode(true)));
    await expect.poll(() => office.hasLoaded(page)).toBe(false);
    await host.goto(sourceOrigin + "/wrapper?changed=1");
    expect(office.hasLoaded(page)).toBe(false);
  } finally {
    await context.close();
  }
});
