import {
  expect,
  test,
  type Browser,
  type Frame,
  type Page,
} from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { login, password, source } from "./helpers";
import { observeOffice } from "./office-helpers";
import {
  installOfficeOnboardingHandler,
  recoverOfficeConflict,
  replaceOfficeText,
} from "./office-ui";

const owner = "office-alice";
const collaborator = "office-bob";
const python = resolve(".runtime/documents/bin/python");
const authorization = (uid: string) =>
  "Basic " + Buffer.from(uid + ":" + password).toString("base64");
const dav = (uid: string, name: string) =>
  source + "/remote.php/dav/files/" + uid + "/" + encodeURIComponent(name);
const shareUrl = source + "/ocs/v2.php/apps/files_sharing/api/v1/shares";

type Actor = Awaited<ReturnType<typeof login>> & {
  uid: string;
  office: Awaited<ReturnType<typeof observeOffice>>;
  editor?: Page;
  frame?: Frame;
  launch?: { url: string; body: string; origin: string };
};

function fixture(revisionTarget?: string) {
  return execFileSync(
    python,
    [
      "tests/fixtures/office-collaboration.py",
      "create",
      ...(revisionTarget ? [revisionTarget] : []),
    ],
    { timeout: 15000 },
  );
}

async function content(name: string, uid = owner) {
  return fetch(dav(uid, name), {
    redirect: "error",
    headers: { Authorization: authorization(uid) },
    signal: AbortSignal.timeout(10000),
  });
}

async function writeSource(name: string, bytes: Buffer, etag?: string) {
  return fetch(dav(owner, name), {
    method: "PUT",
    redirect: "error",
    headers: {
      Authorization: authorization(owner),
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
    },
    body: Uint8Array.from(bytes),
    signal: AbortSignal.timeout(10000),
  });
}

async function sharing(method: "POST" | "DELETE", nameOrId: string) {
  const response = await fetch(
    shareUrl + (method === "DELETE" ? "/" + nameOrId : "") + "?format=json",
    {
      method,
      redirect: "error",
      headers: {
        Authorization: authorization(owner),
        "OCS-APIRequest": "true",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      ...(method === "POST"
        ? {
            body: new URLSearchParams({
              path: "/" + nameOrId,
              shareType: "0",
              shareWith: collaborator,
              permissions: "3",
            }),
          }
        : {}),
      signal: AbortSignal.timeout(10000),
    },
  );
  expect(response.ok).toBe(true);
  const value = await response.json();
  expect(value.ocs.meta.statuscode).toBe(200);
  return method === "POST" ? String(value.ocs.data.id) : undefined;
}

async function actor(browser: Browser, uid: string, actors: Actor[]) {
  const session = await login(browser, uid);
  const value: Actor = {
    ...session,
    uid,
    office: await observeOffice(
      session.context,
      "http://127.0.0.1:9980",
      new URL(source).origin,
    ),
  };
  session.context.on("request", (request) => {
    const address = new URL(request.url());
    if (
      request.method() === "POST" &&
      address.origin === "http://127.0.0.1:9980" &&
      /^\/browser\/[^/]+\/cool\.html$/.test(address.pathname)
    ) {
      // Keep the actual bearer-bound launch only in memory. It must never be
      // included in assertions, traces, diagnostics or test attachments.
      value.launch = {
        url: request.url(),
        body: request.postData() ?? "",
        origin: request.headers().origin ?? "",
      };
    }
  });
  actors.push(value);
  await expect(
    value.page.getByRole("navigation", { name: "工作区导航" }),
  ).toBeVisible();
  return value;
}

async function revokedLaunchDenied(launch: Actor["launch"]) {
  if (!launch) return false;
  try {
    const response = await fetch(launch.url, {
      method: "POST",
      redirect: "error",
      headers: {
        Origin: launch.origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: launch.body,
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 403) {
      await response.body?.cancel();
      return false;
    }
    const body = await response.json();
    return body?.error === "source_denied";
  } catch {
    // Fetch errors can contain the bearer-bearing address. Return only a
    // boolean so a failure cannot expose it through a Playwright stack trace.
    return false;
  }
}

async function open(value: Actor, name: string) {
  await value.page.reload();
  await value.page.getByLabel("知识库", { exact: true }).click();
  await value.page.getByRole("tab", { name: "企业文件", exact: true }).click();
  await value.page
    .locator("article")
    .filter({ hasText: name })
    .getByRole("button", { name: "Office 协作", exact: true })
    .click();
  const opened = value.context.waitForEvent("page");
  await value.page
    .getByRole("dialog", { name: "Office 协作" })
    .getByRole("link", { name: "在新标签页打开 Office 文件" })
    .click();
  value.editor = await opened;
  await value.office.waitForLoaded(value.editor);
  value.frame = value.office.loadedFrame(value.editor);
  if (!value.frame)
    throw new Error("The authorized loaded Office frame is unavailable");
  await installOfficeOnboardingHandler(value.frame);
  return value as Actor & { editor: Page; frame: Frame };
}

async function verify(name: string, expected: object) {
  const resultPath = resolve(".runtime", "office-access-saved.docx");
  await expect
    .poll(
      async () => {
        const response = await content(name);
        if (response.status !== 200) return false;
        writeFileSync(resultPath, Buffer.from(await response.arrayBuffer()));
        return (
          spawnSync(
            python,
            [
              "tests/fixtures/office-collaboration.py",
              "verify",
              resultPath,
              JSON.stringify(expected),
            ],
            { timeout: 15000 },
          ).status === 0
        );
      },
      {
        timeout: 45000,
        intervals: [1000, 2000],
        message:
          "The authoritative source must preserve the required edits and reject forbidden content",
      },
    )
    .toBe(true);
}

async function report(actors: Actor[]) {
  for (const value of actors)
    if (value.editor)
      console.error(
        "Office access diagnostics:",
        value.uid,
        JSON.stringify(await value.office.diagnostics(value.editor)),
      );
}

test("Revoking a real Office share isolates the already active collaborator", async ({
  browser,
}) => {
  test.setTimeout(360000);
  const name = "Hyper-revoke-" + randomUUID() + ".docx";
  const before = "permitted-" + randomUUID();
  const after = "owner-after-revocation-" + randomUUID();
  const privateComment = "private-after-revocation-" + randomUUID();
  const forbidden = "forbidden-after-revocation-" + randomUUID();
  const actors: Actor[] = [];
  let shareId: string | undefined;
  try {
    expect((await writeSource(name, fixture())).status).toBe(201);
    shareId = await sharing("POST", name);
    const alice = await open(await actor(browser, owner, actors), name);
    const bob = await open(await actor(browser, collaborator, actors), name);
    await bob.frame
      .locator("#document-container")
      .click({ position: { x: 300, y: 300 } });
    await replaceOfficeText(bob.editor, bob.frame, "Bob edit target", before);
    await bob.editor.keyboard.press("Control+s");
    await verify(name, { text: [before] });

    const connected = bob.office.connections(bob.editor);
    expect(connected.active).toBeGreaterThan(0);
    // Freeze the productive session's binding before mutation. Any later
    // automatic launch or reconnect must not replace this evidence.
    const boundLaunch = bob.launch ? { ...bob.launch } : undefined;
    expect(!!boundLaunch).toBe(true);
    await sharing("DELETE", shareId!);
    shareId = undefined;
    expect((await content(name, collaborator)).status).toBe(404);
    // Observe the already productive connection closing after the source
    // mutation. The gateway does not impersonate a COOL revocation message.
    await expect
      .poll(
        () => {
          const current = bob.office.connections(bob.editor);
          return current.closed > connected.closed && current.active === 0;
        },
        {
          timeout: 30000,
          message:
            "The gateway must close the collaborator's already active Office connection",
        },
      )
      .toBe(true);
    expect(
      await revokedLaunchDenied(boundLaunch),
      "The gateway must reject the revoked user's previously authorized launch token",
    ).toBe(true);
    if (!bob.editor.isClosed()) {
      await bob.editor.keyboard.type(forbidden);
      await bob.editor.keyboard.press("Control+s");
    }
    await alice.frame
      .locator("#document-container")
      .click({ position: { x: 300, y: 300 } });
    await replaceOfficeText(
      alice.editor,
      alice.frame,
      "Alice edit target",
      after,
    );
    await alice.frame.locator("#Insert-tab-label").click();
    await alice.frame.locator("#Insert .unoInsertAnnotation").click();
    const comment = alice.frame.locator(".cool-annotation").last();
    await comment
      .locator(".modify-annotation .cool-annotation-textarea")
      .pressSequentially(privateComment);
    await comment.locator('[value="Save"]').click();
    await alice.editor.keyboard.press("Control+s");
    await verify(name, {
      text: [before, after],
      absent: [forbidden],
      comments: { [owner]: privateComment },
    });
    expect(bob.office.connections(bob.editor).active).toBe(0);
    expect(
      bob.frame.isDetached() ||
        !(
          await bob.frame.locator(".cool-annotation-content").allTextContents()
        ).some((text) => text.includes(privateComment)),
      "The revoked editor must not receive the owner's subsequent comment",
    ).toBe(true);
  } catch (error) {
    await report(actors);
    throw error;
  } finally {
    for (const value of actors) await value.context.close();
    if (shareId) await sharing("DELETE", shareId);
  }
});

test("A real Office storage conflict preserves the external version and recovers edits in a new file", async ({
  browser,
}) => {
  test.setTimeout(360000);
  const name = "Hyper-conflict-" + randomUUID() + ".docx";
  const external = "external-" + randomUUID();
  const unsaved = "unsaved-" + randomUUID();
  const actors: Actor[] = [];
  try {
    expect((await writeSource(name, fixture())).status).toBe(201);
    const alice = await open(await actor(browser, owner, actors), name);
    const original = await content(name);
    expect(original.status).toBe(200);
    const etag = original.headers.get("etag");
    expect(!!etag).toBe(true);
    const modified = Date.parse(original.headers.get("last-modified") ?? "");
    expect(Number.isFinite(modified)).toBe(true);
    await original.body?.cancel();
    // Nextcloud stores whole-second mtimes. A genuinely later source write is
    // needed to exercise WOPI's timestamp conflict, not a same-tick replacement.
    await expect
      .poll(() => Date.now() > modified + 1100, {
        timeout: 3000,
        intervals: [200],
      })
      .toBe(true);
    await alice.frame
      .locator("#document-container")
      .click({ position: { x: 300, y: 300 } });
    await replaceOfficeText(
      alice.editor,
      alice.frame,
      "Revision target",
      unsaved,
    );
    expect((await writeSource(name, fixture(external), etag!)).status).toBe(
      204,
    );
    await verify(name, { text: [external], absent: [unsaved] });
    await alice.editor.keyboard.press("Control+s");
    const conflict = alice.frame.locator(
      "#modal-dialog-document-conflict-popup",
    );
    await expect
      .poll(() => conflict.isVisible(), {
        timeout: 30000,
        message: "The live editor must expose the storage conflict",
      })
      .toBe(true);
    await verify(name, { text: [external], absent: [unsaved] });
    await recoverOfficeConflict(alice.frame);
    const recovered = name.replace(/\.docx$/, "_new.docx");
    await verify(recovered, { text: [unsaved], absent: [external] });
    await verify(name, { text: [external], absent: [unsaved] });
    await alice.editor.close();
    await open(alice, recovered);
    console.info(
      "Office conflict recovery: original preserved; saved copy reopened",
    );
  } catch (error) {
    await report(actors);
    throw error;
  } finally {
    for (const value of actors) await value.context.close();
  }
});
