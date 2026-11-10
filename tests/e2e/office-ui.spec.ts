import { expect, test } from "@playwright/test";
import { installOfficeOnboardingHandler } from "../nextcloud/office-ui";

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
            ? `<body tabindex="0">Welcome<script>window.addEventListener('keydown', event => { if (event.key === 'Escape') parent.postMessage('dismiss-welcome', '${editor}'); });</script></body>`
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
