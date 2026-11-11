import { expect, test, type Frame, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { login, password, source } from "./helpers";
import { observeOffice } from "./office-helpers";
import {
  acceptOfficeRevisions,
  installOfficeOnboardingHandler,
  recordOfficeReplacement,
  replaceOfficeText,
} from "./office-ui";

const editorOrigin = "http://127.0.0.1:9980";
const python = resolve(".runtime/documents/bin/python");
const owner = "office-alice";
const collaborator = "office-bob";
const authorization =
  "Basic " + Buffer.from(owner + ":" + password).toString("base64");

type Actor = Awaited<ReturnType<typeof login>> & {
  uid: string;
  office: Awaited<ReturnType<typeof observeOffice>>;
  editor?: Page;
  frame?: Frame;
};

test("Two real Office users preserve simultaneous edits, authored comments, and accepted revisions", async ({
  browser,
}) => {
  test.setTimeout(420000);
  const name = "Hyper-shared-office-" + randomUUID() + ".docx";
  const contentUrl = source + "/remote.php/dav/files/" + owner + "/" + name;
  const shareUrl = source + "/ocs/v2.php/apps/files_sharing/api/v1/shares";
  const headers = {
    Authorization: authorization,
    "OCS-APIRequest": "true",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const bytes = execFileSync(
    python,
    ["tests/fixtures/office-collaboration.py", "create"],
    { timeout: 15000 },
  );
  expect(
    (
      await fetch(contentUrl, {
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: authorization },
        body: bytes,
      })
    ).status,
  ).toBe(201);
  const sharing = await fetch(shareUrl + "?format=json", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers,
    body: new URLSearchParams({
      path: "/" + name,
      shareType: "0",
      shareWith: collaborator,
      permissions: "3",
    }),
  });
  expect(sharing.ok).toBe(true);
  const shared = await sharing.json();
  expect(shared.ocs.meta.statuscode).toBe(200);
  const shareId = String(shared.ocs.data.id);
  const actors: Actor[] = [];
  const markers = {
    alice: "alice-" + randomUUID(),
    bob: "bob-" + randomUUID(),
    comment: "comment-" + randomUUID(),
    reply: "reply-" + randomUUID(),
    revision: "revision-" + randomUUID(),
  };
  async function open(uid: string) {
    const session = await login(browser, uid);
    const actor: Actor = {
      ...session,
      uid,
      office: await observeOffice(
        session.context,
        editorOrigin,
        new URL(source).origin,
      ),
    };
    actors.push(actor);
    await expect(
      actor.page.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    await actor.page.getByLabel("知识库", { exact: true }).click();
    await actor.page
      .getByRole("tab", { name: "企业文件", exact: true })
      .click();
    await actor.page
      .locator("article")
      .filter({ hasText: name })
      .getByRole("button", { name: "Office 协作", exact: true })
      .click();
    const opened = actor.context.waitForEvent("page");
    await actor.page
      .getByRole("dialog", { name: "Office 协作" })
      .getByRole("link", { name: "在新标签页打开 Office 文件" })
      .click();
    actor.editor = await opened;
    await actor.office.waitForLoaded(actor.editor);
    actor.frame = actor.office.loadedFrame(actor.editor);
    if (!actor.frame)
      throw new Error("The loaded collaborative editor is unavailable");
    await installOfficeOnboardingHandler(actor.frame);
    return actor as Actor & { editor: Page; frame: Frame };
  }
  async function verify(expected: object) {
    const resultPath = resolve(".runtime", "office-collaboration-saved.docx");
    let summary = "";
    await expect
      .poll(
        async () => {
          const downloaded = await fetch(contentUrl, {
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: { Authorization: authorization },
          });
          if (downloaded.status !== 200) return false;
          writeFileSync(
            resultPath,
            Buffer.from(await downloaded.arrayBuffer()),
          );
          const checked = spawnSync(
            python,
            [
              "tests/fixtures/office-collaboration.py",
              "verify",
              resultPath,
              JSON.stringify(expected),
            ],
            { encoding: "utf8", timeout: 15000 },
          );
          summary = checked.stdout;
          return checked.status === 0;
        },
        {
          timeout: 45000,
          intervals: [1000, 2000],
          message:
            "The source DOCX must preserve the actual collaborative edits and review data",
        },
      )
      .toBe(true);
    console.info("Office collaboration readback:", summary.trim());
  }
  try {
    const alice = await open(owner);
    const bob = await open(collaborator);
    await Promise.all(
      [alice, bob].map(async (actor) => {
        await actor.frame
          .locator("#document-container")
          .click({ position: { x: 300, y: 300 } });
        await replaceOfficeText(
          actor.editor,
          actor.frame,
          actor.uid === owner ? "Alice edit target" : "Bob edit target",
          actor.uid === owner ? markers.alice : markers.bob,
        );
      }),
    );
    await alice.editor.keyboard.press("Control+s");
    await bob.editor.keyboard.press("Control+s");
    await verify({ text: [markers.alice, markers.bob] });

    await alice.frame.locator("#Insert-tab-label").click();
    await alice.frame.locator("#Insert .unoInsertAnnotation").click();
    const annotation = alice.frame.locator(".cool-annotation").last();
    await expect(
      annotation.locator(".modify-annotation .cool-annotation-textarea"),
    ).toBeEditable();
    await annotation
      .locator(".modify-annotation .cool-annotation-textarea")
      .pressSequentially(markers.comment);
    await annotation.locator('[value="Save"]').click();
    await expect
      .poll(
        async () =>
          (
            await bob.frame
              .locator(".cool-annotation-content")
              .allTextContents()
          ).some((text) => text.includes(markers.comment)),
        { message: "The other editor must receive the author's comment" },
      )
      .toBe(true);
    await bob.frame.locator("#comment-annotation-menu-1").click();
    await bob.frame
      .locator(".ui-combobox-entry")
      .filter({ hasText: /^Reply$/ })
      .click();
    await bob.frame
      .locator("#annotation-reply-textarea-1")
      .pressSequentially(markers.reply);
    await bob.frame.locator("#annotation-reply-1").click();
    await expect
      .poll(
        async () =>
          (
            await alice.frame
              .locator(".cool-annotation-content")
              .allTextContents()
          )
            .at(-1)
            ?.includes(markers.reply) === true,
        { message: "The author must receive the collaborator's reply" },
      )
      .toBe(true);
    await bob.editor.keyboard.press("Control+s");
    await verify({
      text: [markers.alice, markers.bob],
      comments: { [owner]: markers.comment, [collaborator]: markers.reply },
    });

    await recordOfficeReplacement(
      alice.editor,
      alice.frame,
      "Revision target",
      markers.revision,
    );
    await verify({
      text: [markers.alice, markers.bob, markers.revision],
      comments: { [owner]: markers.comment, [collaborator]: markers.reply },
      tracked: { author: owner, text: markers.revision },
    });
    await acceptOfficeRevisions(bob.editor, bob.frame);
    await verify({
      text: [markers.alice, markers.bob, markers.revision],
      comments: { [owner]: markers.comment, [collaborator]: markers.reply },
      accepted: true,
    });
  } catch (error) {
    for (const actor of actors)
      if (actor.editor)
        console.error(
          "Office collaboration diagnostics:",
          actor.uid,
          JSON.stringify(await actor.office.diagnostics(actor.editor)),
        );
    throw error;
  } finally {
    for (const actor of actors) await actor.context.close();
    await fetch(shareUrl + "/" + shareId + "?format=json", {
      method: "DELETE",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers,
    });
  }
});
