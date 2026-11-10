import { expect, type Frame, type Page } from "@playwright/test";

/** Interact through the visible editor UI after the strict load observer passes. */
export async function dismissOfficeOnboarding(frame: Frame) {
  const welcome = frame.locator(".iframe-welcome-wrap");
  await welcome.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await welcome.isVisible()) {
    const welcomeFrame = frame
      .childFrames()
      .find((child) => child.name() === "iframe-welcome-form");
    if (!welcomeFrame)
      throw new Error("The visible Office welcome frame is unavailable");
    await welcomeFrame.locator("body").press("Escape");
    await expect.poll(() => welcome.isVisible()).toBe(false);
  }
  const tour = frame.locator("#modal-dialog-onboarding-tour-overlay");
  await tour.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await tour.isVisible())
    await tour.getByText("Skip", { exact: true }).click();
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
