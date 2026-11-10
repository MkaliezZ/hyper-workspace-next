import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { login, password, source } from "./helpers";

const editorOrigin = "http://127.0.0.1:9980";
const formats = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

test("The real Nextcloud Office editor opens DOCX, XLSX and PPTX from the authorized workspace file entry", async ({
  browser,
}) => {
  test.setTimeout(240000);
  const employee = "employee-one";
  const authorization =
    "Basic " + Buffer.from(employee + ":" + password).toString("base64");
  const { context, page } = await login(browser, employee);
  try {
    await context.addInitScript((origin) => {
      window.addEventListener("message", (event) => {
        if (event.origin !== origin || typeof event.data !== "string") return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (
          message?.MessageId === "App_LoadingStatus" &&
          message.Values?.Status === "Document_Loaded"
        )
          document.documentElement.dataset.hyperOfficeLoaded = "yes";
      });
    }, editorOrigin);
    await expect(
      page.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    for (const [format, mime] of Object.entries(formats)) {
      const name = "Hyper-office-" + randomUUID() + "." + format;
      const bytes = execFileSync(resolve(".runtime/documents/bin/python"), [
        "tests/fixtures/document-source.py",
        format,
        "synthetic-office-" + format,
      ]);
      const response = await fetch(
        source + "/remote.php/dav/files/" + employee + "/" + name,
        {
          method: "PUT",
          redirect: "error",
          headers: { Authorization: authorization, "Content-Type": mime },
          body: bytes,
        },
      );
      expect(response.status).toBe(201);

      await page.reload();
      await page.getByLabel("知识库", { exact: true }).click();
      await page.getByRole("tab", { name: "企业文件", exact: true }).click();
      await page
        .locator("article")
        .filter({ hasText: name })
        .getByRole("button", { name: "Office 协作", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: "Office 协作" });
      const editorPromise = context.waitForEvent("page");
      await dialog
        .getByRole("link", { name: "在新标签页打开 Office 文件" })
        .click();
      const editor = await editorPromise;
      try {
        await expect(editor.locator("html")).toHaveAttribute(
          "data-hyper-office-loaded",
          "yes",
          { timeout: 60000 },
        );
      } finally {
        await editor.close();
      }
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    }
  } finally {
    await context.close();
  }
});
