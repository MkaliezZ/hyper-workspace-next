import { expect, test } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { login, password, source } from "./helpers";
import { observeOffice } from "./office-helpers";
import { dismissOfficeOnboarding, replaceOfficeText } from "./office-ui";

const editorOrigin = "http://127.0.0.1:9980";
const formats = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

test("The real Office editor saves DOCX, XLSX and PPTX edits and the workspace detects their new source versions", async ({
  browser,
}) => {
  test.setTimeout(360000);
  const employee = "employee-one";
  const authorization =
    "Basic " + Buffer.from(employee + ":" + password).toString("base64");
  const { context, page } = await login(browser, employee);
  try {
    const office = await observeOffice(
      context,
      editorOrigin,
      new URL(source).origin,
    );
    await expect(
      page.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    for (const [format, mime] of Object.entries(formats)) {
      const marker = "saved-" + randomUUID();
      const name = "Hyper-office-" + randomUUID() + "." + format;
      const bytes = execFileSync(resolve(".runtime/documents/bin/python"), [
        "tests/fixtures/office-roundtrip.py",
        "create",
        format,
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
        await office.waitForLoaded(editor);
        console.info("Office Document_Loaded:", format);
        const main = office.loadedFrame(editor);
        if (!main)
          throw new Error("The loaded editor frame became unavailable");

        await dismissOfficeOnboarding(main);
        await main
          .locator("#document-container")
          .click({ position: { x: 300, y: 300 } });
        if (format === "xlsx") await main.locator("#spreadsheet-tab1").click();
        await replaceOfficeText(editor, main, "Editable text", marker);
        await editor.keyboard.press("Control+s");

        const resultPath = resolve(
          ".runtime",
          "office-browser-saved." + format,
        );
        let verification = "";
        await expect
          .poll(
            async () => {
              const saved = await fetch(
                source + "/remote.php/dav/files/" + employee + "/" + name,
                {
                  redirect: "error",
                  signal: AbortSignal.timeout(10000),
                  headers: { Authorization: authorization },
                },
              );
              if (saved.status !== 200) return false;
              writeFileSync(resultPath, Buffer.from(await saved.arrayBuffer()));
              const checked = spawnSync(
                resolve(".runtime/documents/bin/python"),
                [
                  "tests/fixtures/office-roundtrip.py",
                  "verify",
                  format,
                  resultPath,
                  marker,
                ],
                { encoding: "utf8", timeout: 15000 },
              );
              verification = checked.stdout;
              return checked.status === 0;
            },
            {
              timeout: 45000,
              intervals: [1000, 2000],
              message:
                "The downloaded Office file must contain the saved UI edit and preserved structures",
            },
          )
          .toBe(true);
        console.info("Office saved roundtrip:", format, verification.trim());
      } catch (error) {
        console.error(
          "Office loading diagnostics:",
          JSON.stringify(await office.diagnostics(editor)),
        );
        throw error;
      } finally {
        await editor.close();
      }
      await dialog
        .getByRole("button", { name: "核对来源版本", exact: true })
        .click();
      await expect(dialog.getByRole("status")).toHaveText(
        "来源已有新版本。请刷新文件夹后重新打开。",
      );
      await expect(
        dialog.getByRole("link", { name: "在新标签页打开 Office 文件" }),
      ).toHaveCount(0);
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    }
  } finally {
    await context.close();
  }
});
