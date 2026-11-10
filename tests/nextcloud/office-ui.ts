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
