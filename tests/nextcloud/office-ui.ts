import { expect, type Frame, type Page } from "@playwright/test";

/** Interact through the visible editor UI after the strict load observer passes. */
export async function installOfficeOnboardingHandler(frame: Frame) {
  const welcome = frame.locator(".iframe-welcome-wrap");
  const tour = frame.locator("#modal-dialog-onboarding-tour-overlay");
  // A welcome frame can appear after Document_Loaded, including while another
  // collaborator opens the file. Check before each actionability retry rather
  // than assuming that a one-time absence means onboarding has finished.
  const page = frame.page();
  await page.addLocatorHandler(
    page.locator("body"),
    async () => {
      if (await welcome.isVisible()) {
        const welcomeFrame = frame
          .childFrames()
          .find((child) => child.name() === "iframe-welcome-form");
        if (!welcomeFrame)
          throw new Error("The visible Office welcome frame is unavailable");
        await welcomeFrame.locator("body").press("Escape");
        await expect.poll(() => welcome.isVisible()).toBe(false);
      }
      if (await tour.isVisible()) {
        await tour.getByText("Skip", { exact: true }).click();
        await expect.poll(() => tour.isVisible()).toBe(false);
      }
    },
    { noWaitAfter: true },
  );
}

export async function replaceOfficeText(
  page: Page,
  frame: Frame,
  previous: string,
  replacement: string,
) {
  await page.keyboard.press("Control+h");
  await expect.poll(() => frame.locator("#searchterm").count()).toBe(1);
  // These controls consume keyboard events; DOM fill alone does not update the
  // remote engine's search/replace state.
  for (const [selector, value] of [
    ["#searchterm-input-dialog", previous],
    ["#replaceterm-input-dialog", replacement],
  ] as const) {
    const input = frame.locator(selector);
    await input.press("Control+a");
    await input.press("Backspace");
    await input.pressSequentially(value);
  }
  await frame.locator("#replaceall-button").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

async function reviewControl(
  frame: Frame,
  command: "unoTrackChanges" | "unoAcceptTrackedChanges",
) {
  await frame.locator("#Review-tab-label").click();
  const button = frame.locator(`.${command} > button.unobutton:visible`);
  const overflow = frame.locator(
    '#Review-container [id^="overflow-button-review-tracking"].menubutton:visible .arrowbackground',
  );
  await expect
    .poll(
      async () => (await button.isVisible()) || (await overflow.isVisible()),
    )
    .toBe(true);
  if (!(await button.isVisible())) await overflow.click();
  return button;
}

/** Recording is established by the saved authored revision, not toolbar state. */
export async function recordOfficeReplacement(
  page: Page,
  frame: Frame,
  previous: string,
  replacement: string,
) {
  await (await reviewControl(frame, "unoTrackChanges")).click();
  await page.keyboard.press("Escape");
  await frame
    .locator("#document-container")
    .click({ position: { x: 300, y: 300 } });
  await replaceOfficeText(page, frame, previous, replacement);
  await page.keyboard.press("Control+s");
}

export async function acceptOfficeRevisions(page: Page, frame: Frame) {
  await (await reviewControl(frame, "unoAcceptTrackedChanges")).click();
  const dialog = frame.getByRole("dialog").filter({
    has: frame.getByRole("button", { name: "Accept All", exact: true }),
  });
  await dialog.getByRole("button", { name: "Accept All", exact: true }).click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.keyboard.press("Control+s");
}

export async function recoverOfficeConflict(frame: Frame, timeout = 30000) {
  const dialog = frame.locator("#modal-dialog-document-conflict-popup");
  await expect
    .poll(() => dialog.isVisible(), {
      timeout,
      message: "The live editor must expose the storage conflict",
    })
    .toBe(true);
  await dialog
    .getByRole("button", { name: "Save to new file", exact: true })
    .click({ timeout });
}
