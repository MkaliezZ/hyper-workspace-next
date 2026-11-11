import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SourceFile } from "@hyper/contracts";
import type {
  OfficeInspectionResult,
  OfficeOperation,
  OfficeProposalResult,
} from "@hyper/contracts/office";
import { login, origin, password, source } from "./helpers";
import { observeOffice } from "./office-helpers";

test("Real OfficeTools proposals save verified editable Nextcloud copies and preserve their original files", async ({
  browser,
}) => {
  test.setTimeout(360000);
  const actor = await login(browser, "employee-one");
  const initialization: { route: string; outcome: number | string }[] = [];
  const routeName = (url: string) => {
    const path = new URL(url).pathname;
    return [
      "/api/office/inspect",
      "/api/office/lookup",
      "/api/office/proposals",
      "/api/models",
    ].includes(path)
      ? path.slice(5)
      : undefined;
  };
  actor.page.on("response", (response) => {
    const route = routeName(response.url());
    if (route && initialization.length < 40)
      initialization.push({ route, outcome: response.status() });
  });
  actor.page.on("requestfailed", (request) => {
    const route = routeName(request.url());
    if (route && initialization.length < 40)
      initialization.push({
        route,
        outcome: /ABORTED/.test(request.failure()?.errorText ?? "")
          ? "aborted"
          : "network-failure",
      });
  });
  const headers = {
    Authorization:
      "Basic " + Buffer.from("employee-one:" + password).toString("base64"),
  };
  const python = resolve(".runtime/documents/bin/python");
  const formats = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  } as const;
  const office = await observeOffice(
    actor.context,
    "http://127.0.0.1:9980",
    new URL(source).origin,
  );
  try {
    await expect(
      actor.page.getByRole("navigation", { name: "工作区导航" }),
    ).toBeVisible();
    for (const format of ["docx", "xlsx", "pptx"] as const) {
      const name = `Hyper-copy-source-${randomUUID()}.${format}`;
      const marker = "verified-copy-" + randomUUID();
      const bytes = execFileSync(
        python,
        ["tests/fixtures/office-roundtrip.py", "create", format],
        { timeout: 15000 },
      );
      const dav =
        source +
        "/remote.php/dav/files/employee-one/" +
        encodeURIComponent(name);
      expect(
        (
          await fetch(dav, {
            method: "PUT",
            headers: {
              ...headers,
              "Content-Type": formats[format],
              "If-None-Match": "*",
            },
            body: bytes,
            signal: AbortSignal.timeout(10000),
            redirect: "error",
          })
        ).status,
      ).toBe(201);
      const listing = await actor.context.request.post(
        origin + "/api/files/list",
        { data: { path: [] } },
      );
      expect(listing.ok()).toBe(true);
      const file = ((await listing.json()) as SourceFile[]).find(
        (f) => f.name === name,
      )!;
      expect(file).toBeTruthy();
      const selection = {
        path: file.path,
        expectedId: file.id,
        expectedEtag: file.etag,
      };
      const inspectedResponse = await actor.context.request.post(
        origin + "/api/office/inspect",
        { data: selection, timeout: 80000 },
      );
      expect(inspectedResponse.ok()).toBe(true);
      const inspected =
        (await inspectedResponse.json()) as OfficeInspectionResult;
      let op: OfficeOperation;
      if ("paragraphs" in inspected.inspection) {
        const target = inspected.inspection.paragraphs.find(
          (p) => p.editable && p.text === "Editable text",
        )!;
        expect(target).toBeTruthy();
        op = {
          kind: "writer.replace",
          target: target.id,
          expectedText: target.text,
          text: marker,
        };
      } else if ("sheets" in inspected.inspection) {
        const sheet = inspected.inspection.sheets.find(
          (s) => s.name === "Report",
        )!;
        const cell = sheet.cells.find((c) => c.address === "B5" && c.editable)!;
        expect(cell.type).toBe("string");
        op = {
          kind: "calc.set",
          sheet: sheet.id,
          cell: "B5",
          expected: { type: "string", value: String(cell.value) },
          value: { type: "string", value: marker },
        };
      } else {
        const shape = inspected.inspection.slides
          .flatMap((s) => s.shapes)
          .find((s) => s.editable && s.text === "Editable text")!;
        expect(shape).toBeTruthy();
        op = {
          kind: "impress.replace",
          target: shape.id,
          expectedText: shape.text,
          text: marker,
        };
      }
      let proposal: OfficeProposalResult;
      if (format === "docx") {
        await actor.page.reload();
        await actor.page.getByLabel("知识库", { exact: true }).click();
        await actor.page
          .getByRole("tab", { name: "企业文件", exact: true })
          .click();
        await actor.page
          .locator("article")
          .filter({ hasText: name })
          .getByRole("button", { name: "Office 助手", exact: true })
          .click();
        const dialog = actor.page.getByRole("dialog", { name: "Office 助手" });
        try {
          await expect(dialog.getByLabel("修改位置")).toBeVisible({
            timeout: 80000,
          });
        } catch (error) {
          const alert = await dialog
            .getByRole("alert")
            .textContent()
            .catch(() => "");
          const category = /繁忙|正在处理|busy/i.test(alert ?? "")
            ? "busy"
            : /权限|成员|身份/.test(alert ?? "")
              ? "authorization"
              : /版本|变化/.test(alert ?? "")
                ? "source-version"
                : /配置|启用/.test(alert ?? "")
                  ? "configuration"
                  : /连接|不可用|超时/.test(alert ?? "")
                    ? "availability"
                    : alert
                      ? "other-alert"
                      : "no-alert";
          // Fixed route names, numeric statuses and categories only. Do not emit
          // document text, credentials, signed editor URLs or an HTML snapshot.
          console.info(
            "Office initialization diagnostics:",
            JSON.stringify({ requests: initialization, category }),
          );
          throw error;
        }
        await dialog
          .getByLabel("修改位置")
          .selectOption(
            (op as Extract<OfficeOperation, { kind: "writer.replace" }>).target,
          );
        await dialog.getByLabel("修改后内容").fill(marker);
        await dialog
          .getByRole("button", { name: "加入修改方案", exact: true })
          .click();
        const created = actor.page.waitForResponse(
          (r) =>
            r.url().endsWith("/api/office/proposals") &&
            r.request().method() === "POST",
          { timeout: 80000 },
        );
        await dialog
          .getByRole("button", { name: "校验并保存方案", exact: true })
          .click();
        const response = await created;
        expect(response.ok()).toBe(true);
        proposal = await response.json();
        await expect(
          dialog.getByRole("button", { name: "确认生成可编辑副本" }),
        ).toBeDisabled();
        await expect(
          dialog.getByRole("region", { name: "Office 修改前后对照" }),
        ).toContainText(marker);
        await dialog.getByRole("checkbox").check();
        const applied = actor.page.waitForResponse(
          (r) => r.url().endsWith(`/api/office/proposals/${proposal.id}/apply`),
          { timeout: 80000 },
        );
        await dialog
          .getByRole("button", { name: "确认生成可编辑副本" })
          .click();
        const receipt = await applied;
        expect(receipt.ok()).toBe(true);
        proposal = await receipt.json();
        await expect(dialog).toContainText("副本已保存并回读校验");
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      } else {
        const created = await actor.context.request.post(
          origin + "/api/office/proposals",
          {
            data: {
              source: selection,
              expectedSha256: inspected.sourceSha256,
              destination: [],
              operations: [op],
              idempotencyKey: randomUUID(),
            },
            timeout: 80000,
          },
        );
        expect(created.ok()).toBe(true);
        proposal = await created.json();
        expect(proposal.state).toBe("prepared");
        const plan = {
          confirmed: true,
          expectedRevision: proposal.revision,
          idempotencyKey: randomUUID(),
        };
        const applied = await actor.context.request.post(
          origin + `/api/office/proposals/${proposal.id}/apply`,
          { data: plan, timeout: 80000 },
        );
        expect(applied.ok()).toBe(true);
        proposal = await applied.json();
        const replay = await actor.context.request.post(
          origin + `/api/office/proposals/${proposal.id}/apply`,
          { data: plan, timeout: 80000 },
        );
        expect(replay.ok()).toBe(true);
        expect((await replay.json()).file.id).toBe(proposal.file?.id);
      }
      expect(proposal.state).toBe("succeeded");
      expect(proposal.file?.id).not.toBe(file.id);
      expect(proposal.outputSha256).toMatch(/^[a-f0-9]{64}$/);
      const original = await fetch(dav, {
        headers,
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      expect(original.status).toBe(200);
      expect(Buffer.from(await original.arrayBuffer()).equals(bytes)).toBe(
        true,
      );
      const saved = await fetch(
        source +
          "/remote.php/dav/files/employee-one/" +
          proposal.file!.path.map(encodeURIComponent).join("/"),
        { headers, signal: AbortSignal.timeout(10000), redirect: "error" },
      );
      expect(saved.ok).toBe(true);
      const savedBytes = Buffer.from(await saved.arrayBuffer());
      expect(createHash("sha256").update(savedBytes).digest("hex")).toBe(
        proposal.outputSha256,
      );
      const output = resolve(".runtime", `office-tools-source-copy.${format}`);
      writeFileSync(output, savedBytes);
      const checked = spawnSync(
        python,
        [
          "tests/fixtures/office-roundtrip.py",
          "verify",
          format,
          output,
          marker,
        ],
        { encoding: "utf8", timeout: 15000 },
      );
      expect(
        checked.status,
        "Real generated copy must preserve the fixture structures",
      ).toBe(0);
      const link = await actor.context.request.post(
        origin + "/api/files/office-link",
        {
          data: {
            path: proposal.file!.path,
            expectedId: proposal.file!.id,
            expectedEtag: proposal.file!.etag,
          },
        },
      );
      expect(link.ok()).toBe(true);
      const editor = await actor.context.newPage();
      try {
        await editor.goto((await link.json()).url);
        await office.waitForLoaded(editor);
      } finally {
        await editor.close();
      }
      console.info("Office source copy verified:", format);
    }
  } finally {
    await actor.context.close();
  }
});
