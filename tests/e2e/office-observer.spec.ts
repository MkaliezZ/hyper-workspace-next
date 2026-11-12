import { expect, test, type Frame } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { observeOffice } from "../nextcloud/office-helpers";

const sourceOrigin = "http://office-source.test";
const editorOrigin = "http://office-editor.test";
const foreignOrigin = "http://office-foreign.test";
const secret = "synthetic-token-must-not-appear";

test("Office connection counts isolate old closed editor sockets without treating a socket as document readiness", async ({
  browser,
}) => {
  const sockets: Socket[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<p>Socket counter fixture</p>");
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(
        request.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    sockets.push(socket as Socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture listener unavailable");
  const origin = "http://127.0.0.1:" + address.port;
  const context = await browser.newContext();
  try {
    const office = await observeOffice(context, origin, sourceOrigin);
    const first = await context.newPage();
    const second = await context.newPage();
    for (const page of [first, second]) {
      await page.goto(origin);
      await page.evaluate(
        (url) => {
          new WebSocket(url);
        },
        origin.replace("http:", "ws:") + "/cool/ws?access_token=" + secret,
      );
      await expect.poll(() => office.connections(page).active).toBe(1);
      expect(office.hasLoaded(page)).toBe(false);
    }
    sockets[0]!.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    await expect
      .poll(() => office.connections(first))
      .toEqual({ created: 1, closed: 1, active: 0 });
    expect(office.connections(second)).toEqual({
      created: 1,
      closed: 0,
      active: 1,
    });
    expect(JSON.stringify(await office.diagnostics(first))).not.toContain(
      secret,
    );
    expect(office.hasLoaded(first)).toBe(false);
  } finally {
    await context.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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
