import { expect, test } from "@playwright/test";
import {
  installOfficeOnboardingHandler,
  recordOfficeReplacement,
  recoverOfficeConflict,
} from "../nextcloud/office-ui";

test("Office onboarding handles late welcome frames and preserves unrelated dialogs", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const source = "http://office-ui-source.test";
  const editor = "http://office-ui-editor.test";
  try {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const body =
        url.origin === source
          ? `<iframe name="editor" src="${editor}/editor" width="800" height="600"></iframe>`
          : url.pathname === "/welcome"
            ? `<body>Welcome<button id="welcome-close" onclick="parent.postMessage('dismiss-welcome', '${editor}')">Close</button></body>`
            : `<style>.overlay { display:none; position:fixed; inset:0; background:white; z-index:5; }</style>
             <button id="edit" onclick="document.body.dataset.edited='true'">Edit</button>
             <div class="iframe-welcome-wrap overlay"><iframe name="iframe-welcome-form" src="${editor}/welcome"></iframe></div>
             <div id="modal-dialog-onboarding-tour-overlay" class="overlay"><button onclick="this.parentElement.style.display='none'">Skip</button></div>
             <div id="unrelated" class="overlay">A save error that must remain visible</div>
             <script>window.addEventListener('message', event => {
               if (event.origin === '${editor}' && event.source === document.querySelector('iframe').contentWindow && event.data === 'dismiss-welcome') {
                 document.querySelector('.iframe-welcome-wrap').style.display='none';
                 setTimeout(() => document.querySelector('#modal-dialog-onboarding-tour-overlay').style.display='block', 0);
               }
             });</script>`;
      return route.fulfill({ contentType: "text/html", body });
    });
    const page = await context.newPage();
    await page.goto(source);
    const frame = page.frame({ name: "editor" })!;
    await installOfficeOnboardingHandler(frame);
    // The prompt appears only after the first onboarding check would have
    // returned, reproducing the multi-user CI failure without a real service.
    await frame.evaluate(() => {
      (
        document.querySelector(".iframe-welcome-wrap") as HTMLElement
      ).style.display = "block";
    });
    await frame.locator("#edit").click({ timeout: 5000 });
    await expect(frame.locator("body")).toHaveAttribute("data-edited", "true");
    await expect(frame.locator(".iframe-welcome-wrap")).toBeHidden();
    await expect(
      frame.locator("#modal-dialog-onboarding-tour-overlay"),
    ).toBeHidden();

    await frame.evaluate(() => {
      (document.querySelector("#unrelated") as HTMLElement).style.display =
        "block";
    });
    const clicked = await frame
      .locator("#edit")
      .click({ timeout: 500 })
      .then(
        () => true,
        () => false,
      );
    expect(clicked).toBe(false);
    await expect(frame.locator("#unrelated")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Office revision recording closes its real menu overlay before editing", async ({
  browser,
}) => {
  const context = await browser.newContext();
  context.setDefaultTimeout(1500);
  try {
    await context.route("http://office-ui-editor.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<style>[hidden] { display:none !important }
          #document-container { width:750px;height:400px;margin-top:80px }
          #Review-container { margin-top:60px }
          #document-header { position:fixed;top:0;left:0;right:0;height:50px;z-index:8 }
          .jsdialog-overlay { position:fixed;inset:0;z-index:5 }
          #menu { position:fixed;left:200px;top:80px;z-index:6;background:white }
          </style><div id="document-header"><button id="Review-tab-label">Review</button></div>
          <div id="Review-container"><div id="overflow-button-review-tracking" class="menubutton">
            <button class="arrowbackground" onclick="document.querySelector('#menu').hidden=false;document.querySelector('.jsdialog-overlay').hidden=false">More</button>
          </div></div>
          <div id="overflow-button-review-tracking-dropdown-overlay" class="jsdialog-overlay cancellable" hidden
            onclick="this.hidden=true;document.querySelector('#menu').hidden=true"></div>
          <div id="menu" hidden><div class="unoTrackChanges"><button class="unobutton"
            onclick="document.body.dataset.recording='true'">Record</button></div></div>
          <div id="document-container">Document</div>
          <div id="searchterm" hidden><input id="searchterm-input-dialog"><input id="replaceterm-input-dialog">
            <button id="replaceall-button" onclick="document.body.dataset.replacement=document.querySelector('#replaceterm-input-dialog').value">Replace all</button></div>
          <script>window.addEventListener('keydown', event => {
            if(event.ctrlKey && event.key==='h') {event.preventDefault();document.querySelector('#searchterm').hidden=false;}
            if(event.key==='Escape') document.querySelector('#searchterm').hidden=true;
            if(event.ctrlKey && event.key==='s') {event.preventDefault();document.body.dataset.saved='true';}
          });</script>`,
      }),
    );
    const page = await context.newPage();
    await page.setContent(
      '<iframe name="editor" width="900" height="600" src="http://office-ui-editor.test/review"></iframe>',
    );
    const frame = page.frame({ name: "editor" })!;
    await recordOfficeReplacement(page, frame, "Original", "Replacement");
    await expect(frame.locator("body")).toHaveAttribute(
      "data-recording",
      "true",
    );
    await expect(frame.locator("body")).toHaveAttribute(
      "data-replacement",
      "Replacement",
    );
    await expect(frame.locator("body")).toHaveAttribute("data-saved", "true");
    expect(await frame.locator(".jsdialog-overlay").isVisible()).toBe(false);
  } finally {
    await context.close();
  }
});

test("Office conflict recovery chooses a new file and never falls back to overwriting", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await context.route("http://office-ui-editor.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<div id="modal-dialog-document-conflict-popup" hidden>
          <button onclick="document.body.dataset.action='discard'">Discard</button>
          <button onclick="document.body.dataset.action='overwrite'">Overwrite</button>
          <button id="copy" onclick="document.body.dataset.action='copy'">Save to new file</button>
          </div>
          <script>setTimeout(() => document.querySelector('div').hidden=false, 100);</script>`,
      }),
    );
    const page = await context.newPage();
    await page.setContent(
      '<iframe name="editor" src="http://office-ui-editor.test/conflict"></iframe>',
    );
    const frame = page.frame({ name: "editor" })!;
    await recoverOfficeConflict(frame, 3000);
    await expect(frame.locator("body")).toHaveAttribute("data-action", "copy");
    await frame.evaluate(() => {
      document.body.removeAttribute("data-action");
      document.querySelector("#copy")!.remove();
    });
    expect(
      await recoverOfficeConflict(frame, 500).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await frame.locator("body").getAttribute("data-action")).toBeNull();
    await expect(
      frame.getByRole("button", { name: "Overwrite" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Office onboarding tolerates an animated tour disappearing before Skip is actionable", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await context.route("http://office-ui-editor.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<style>@keyframes moving { from { transform:translateX(0) } to { transform:translateX(200px) } }
          #modal-dialog-onboarding-tour-overlay { position:fixed; inset:0; background:white; z-index:5 }
          #skip { animation:moving 100ms linear infinite alternate }
          </style><button id="edit" onclick="document.body.dataset.edited='true'">Edit</button>
          <div id="modal-dialog-onboarding-tour-overlay" hidden><button id="skip">Skip</button></div>`,
      }),
    );
    const page = await context.newPage();
    await page.setContent(
      '<iframe name="editor" src="http://office-ui-editor.test/animated-tour"></iframe>',
    );
    const frame = page.frame({ name: "editor" })!;
    await installOfficeOnboardingHandler(frame);
    await frame.evaluate(() => {
      const tour = document.querySelector(
        "#modal-dialog-onboarding-tour-overlay",
      ) as HTMLElement;
      tour.hidden = false;
      setTimeout(() => tour.remove(), 400);
    });
    await frame.locator("#edit").click({ timeout: 5000 });
    await expect(frame.locator("body")).toHaveAttribute("data-edited", "true");
    expect(
      await frame.locator("#modal-dialog-onboarding-tour-overlay").count(),
    ).toBe(0);
  } finally {
    await context.close();
  }
});
