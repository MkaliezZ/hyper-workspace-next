import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { OfficeRunPlan } from "@hyper/contracts/office-runs";
import { Database } from "../apps/api/src/db/database.js";
import { Vault } from "../apps/api/src/core/credentials.js";
import { OfficeService } from "../apps/api/src/core/office.js";
import { officeDigest } from "../apps/api/src/core/office-provider.js";
import { WorkspaceService } from "../apps/api/src/core/workspace.js";
import { RunProcessor } from "../apps/api/src/core/processor.js";
import { engineRegistry } from "../apps/api/src/engines/adapters.js";
import { createCalendarScope } from "../tests/fixtures/calendar-scope.js";

async function main() {
  if (process.argv.length === 2) {
    console.info(
      JSON.stringify({
        mode: "preflight",
        execute: "Add --execute to run the actual supplier checks",
        supplier: "DeepSeek / deepseek-flash",
        keyEnvironment: "DEEPSEEK_API_KEY (never a command-line argument)",
        database: "An isolated *_test PostgreSQL database",
        office:
          "The locked real office-batch service at HYPER_OFFICE_BATCH_URL",
        source: "Synthetic loopback DAV, not company data or real Nextcloud",
        businessRuns: 12,
        actualHttpRequests:
          "Recorded by the product; no automatic smoke retries",
        executionMayBeBillable: true,
        requestsSent: 0,
      }),
    );
    return;
  }
  assert.deepEqual(process.argv.slice(2), ["--execute"]);
  assert.ok(
    process.env.DEEPSEEK_API_KEY,
    "Supply the supplier key via the environment",
  );
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl && new URL(databaseUrl).pathname.endsWith("_test"));
  assert.ok(
    process.env.HYPER_OFFICE_BATCH_URL,
    "A real private Office service is required",
  );
  const allowedCases = [
    "dsh:docx",
    "dsh:xlsx",
    "dsh:pptx",
    "hermes:docx",
    "hermes:xlsx",
    "hermes:pptx",
  ];
  const cases = process.env.REAL_OFFICE_CASES?.split(",") ?? allowedCases;
  assert.ok(
    cases.length > 0 &&
      new Set(cases).size === cases.length &&
      cases.every((value) => allowedCases.includes(value)),
    "Select unique known Office verification cases",
  );
  const python = resolve(
    process.env.DOCUMENTS_PYTHON ?? ".runtime/documents/bin/python",
  );
  const directory = resolve(
    ".runtime/private-model-checks",
    "office-" +
      new Date().toISOString().replaceAll(":", "-") +
      "-" +
      randomUUID().slice(0, 8),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new Database(databaseUrl);
  let scope: Awaited<ReturnType<typeof createCalendarScope>> | undefined;
  let profileId: string | undefined;
  const originalEnvironment = new Map(
    ["RUNTIME_DIR", "NEXTCLOUD_FILES_ENABLED", "CREDENTIAL_MASTER_KEY"].map(
      (key) => [key, process.env[key]],
    ),
  );
  const report: any = {
    date: new Date().toISOString(),
    supplier: "DeepSeek",
    model: "deepseek-flash",
    source:
      "Synthetic loopback DAV; no company originals and not real Nextcloud",
    office: "Real locked Collabora core via office-batch",
    cases,
    runs: [],
    copies: [],
    status: "running",
  };
  let puts = 0;
  const save = () =>
    writeFile(
      resolve(directory, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  try {
    await db.migrate();
    scope = await createCalendarScope(db);
    const { actor, peer, source } = scope;
    // The generic source fixture uses a public test key. Replace it in memory
    // before saving an actual supplier credential, and re-encrypt only this
    // isolated fixture's synthetic source credentials under the fresh key.
    process.env.CREDENTIAL_MASTER_KEY = randomBytes(32).toString("hex");
    const vault = new Vault();
    for (const subject of [actor, peer]) {
      await db.pool.query(
        "UPDATE cw_identity_credentials SET credential_enc=$1 WHERE id=$2",
        [
          vault.encrypt(source.people.get(subject.name)!.password),
          subject.identityCredentialId,
        ],
      );
    }
    await db.pool.query(
      "UPDATE cw_workspaces SET name='Synthetic real-model Office verification' WHERE id=$1",
      [actor.workspaceId],
    );
    Object.assign(process.env, {
      RUNTIME_DIR: resolve(directory, "runs"),
      NEXTCLOUD_FILES_ENABLED: "true",
    });
    const original = source.handle.bind(source);
    source.handle = async (request, response) => {
      if (request.method !== "PUT") return original(request, response);
      assert.equal(request.headers["if-none-match"], "*");
      const auth = Buffer.from(
        request.headers.authorization!.slice(6),
        "base64",
      ).toString();
      assert.equal(auth, "alice:" + source.people.get("alice")!.password);
      const path = new URL(request.url!, "http://fixture").pathname
        .split("/")
        .slice(5)
        .map(decodeURIComponent);
      assert.ok(
        !source.files.files.some(
          (file) => JSON.stringify(file.path) === JSON.stringify(path),
        ),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const format = path.at(-1)!.split(".").at(-1)! as keyof typeof mimes;
      source.files.add("alice", path, Buffer.concat(chunks), mimes[format]);
      puts++;
      response.writeHead(201);
      response.end();
    };
    const work = new WorkspaceService(db, engineRegistry()),
      processor = new RunProcessor(work),
      office = new OfficeService(db);
    const profile = await work.saveModel(actor, {
      name: "Private Office supplier verification",
      endpoint: "https://api.deepseek.com",
      model: "deepseek-flash",
      purpose: "chat",
      scope: "personal",
      provider: "openai-compatible",
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
    profileId = profile.id;
    async function run(engine: "dsh" | "hermes", plan: OfficeRunPlan) {
      assert.ok(report.runs.length < cases.length * 2);
      const input = {
        engine,
        plan,
        modelProfileId: profile.id,
        idempotencyKey: randomUUID(),
      };
      const started = await work.startOfficeRun(actor, input);
      assert.equal((await work.startOfficeRun(actor, input)).id, started.id);
      await processor.process(started.id);
      await processor.process(started.id);
      const actual = await work.getRun(actor, started.id);
      const requests = (
        await db.pool.query(
          "SELECT transport,http_status,usage_status,input_tokens::text,output_tokens::text,cost_status FROM cw_model_requests WHERE run_id=$1 ORDER BY started_at",
          [started.id],
        )
      ).rows;
      report.runs.push({
        id: started.id,
        engine,
        operation: plan.operation,
        state: actual.state,
        error: actual.error,
        result: actual.result,
        requests,
      });
      await save();
      assert.equal(
        actual.state,
        "succeeded",
        "The product run did not complete; inspect the private report",
      );
      assert.equal(actual.result.evidence, "runtime");
      assert.ok(
        requests.length > 0 &&
          requests.every((request) => request.http_status === 200),
      );
      await assert.rejects(() => work.getRun(peer, started.id));
      console.info("Supplier Office run verified:", engine, plan.operation);
      return actual;
    }
    for (const engine of ["dsh", "hermes"] as const) {
      assert.equal(
        work.engines.get(engine)?.describeCapabilities().configured,
        true,
      );
      for (const format of ["docx", "xlsx", "pptx"] as const) {
        if (!cases.includes(engine + ":" + format)) continue;
        const bytes = execFileSync(
          python,
          ["tests/fixtures/office-roundtrip.py", "create", format],
          { timeout: 15000 },
        );
        const file = source.files.add(
          "alice",
          [engine + "-synthetic-source." + format],
          bytes,
          mimes[format],
        );
        const selection = {
          path: file.path,
          expectedId: file.id,
          expectedEtag: file.etag,
        };
        const baseline = (await office.inspect(actor, selection)).inspection;
        const marker = "Verified " + engine + " Office revision";
        const instruction =
          format === "xlsx"
            ? `In sheet Report set B5 to the exact string "${marker}". Also set the inspected empty cell B4 to the formula =SUM(Inputs!D2:D3). Preserve every other cell, formula, validation and chart.`
            : `Replace the single editable ${format === "docx" ? "paragraph" : "text shape"} whose complete text is "Editable text" with the exact text "${marker}". Preserve everything else.`;
        const before = puts;
        const drafted = await run(engine, {
          operation: "draft",
          source: selection,
          expectedSha256: officeDigest(bytes),
          destination: [],
          instruction,
        });
        assert.equal(puts, before, "Drafting must not publish a file");
        const proposalId = drafted.result.receipts[0].proposalId as string;
        const proposal = await office.get(actor, proposalId);
        assert.equal(proposal.state, "prepared");
        assert.equal(proposal.preview?.reopenedVerified, true);
        assert.ok(proposal.operations);
        assert.ok(JSON.stringify(proposal.operations).includes(marker));
        // This harness explicitly checks the proposal before confirming this
        // synthetic copy. The model never grants confirmation to itself.
        assert.equal(proposal.operations.length, format === "xlsx" ? 2 : 1);
        for (const operation of proposal.operations) {
          if (format === "xlsx") {
            assert.ok(operation.kind === "calc.set" && "sheets" in baseline);
            assert.equal(
              operation.sheet,
              baseline.sheets.find((sheet) => sheet.name === "Report")?.id,
            );
            assert.ok(["B5", "B4"].includes(operation.cell));
            assert.deepEqual(
              operation.expected,
              operation.cell === "B5"
                ? { type: "string", value: "Editable text" }
                : { type: "empty", value: null },
            );
            assert.deepEqual(
              operation.value,
              operation.cell === "B5"
                ? { type: "string", value: marker }
                : { type: "formula", value: "=SUM(Inputs!D2:D3)" },
            );
          } else {
            assert.ok(
              operation.kind === "writer.replace" ||
                operation.kind === "impress.replace",
            );
            assert.equal(
              operation.kind,
              format === "docx" ? "writer.replace" : "impress.replace",
            );
            assert.equal(operation.expectedText, "Editable text");
            assert.equal(operation.text, marker);
            const candidates =
              "paragraphs" in baseline
                ? baseline.paragraphs
                : "slides" in baseline
                  ? baseline.slides.flatMap((slide) => slide.shapes)
                  : [];
            assert.ok(
              candidates.some(
                (item) =>
                  item.editable &&
                  item.id === operation.target &&
                  item.text === "Editable text",
              ),
            );
          }
        }
        if (format === "xlsx")
          assert.equal(
            new Set(
              proposal.operations.map((operation) =>
                operation.kind === "calc.set" ? operation.cell : "",
              ),
            ).size,
            2,
          );
        await assert.rejects(() => office.get(peer, proposalId));
        const applied = await run(engine, {
          operation: "apply",
          proposalId,
          expectedRevision: proposal.revision,
          confirmed: true,
        });
        assert.equal(applied.result.receipts[0].savedCopy, true);
        assert.equal(puts, before + 1);
        const receipt = await office.get(actor, proposalId);
        assert.equal(receipt.state, "succeeded");
        assert.deepEqual(file.content, bytes);
        const saved = source.files.files.find(
          (item) => item.id === receipt.file?.id,
        )!;
        assert.ok(saved && saved.id !== file.id);
        assert.equal(officeDigest(saved.content), receipt.outputSha256);
        const output = resolve(directory, engine + "-copy." + format);
        await writeFile(output, saved.content, { mode: 0o600 });
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
        assert.equal(
          checked.status,
          0,
          "The saved file must pass independent structure checks",
        );
        if (format === "xlsx") {
          const inspected = await office.inspect(actor, {
            path: saved.path,
            expectedId: saved.id,
            expectedEtag: saved.etag,
          });
          assert.ok("sheets" in inspected.inspection);
          assert.equal(
            inspected.inspection.sheets
              .find((sheet) => sheet.name === "Report")
              ?.cells.find((cell) => cell.address === "B4")?.display,
            "40",
          );
        }
        report.copies.push({
          engine,
          format,
          proposalId,
          outputSha256: receipt.outputSha256,
          sourceUnchanged: true,
          preservation: JSON.parse(checked.stdout),
        });
        await save();
      }
    }
    assert.equal(puts, cases.length);
    assert.equal(report.runs.length, cases.length * 2);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure =
      error instanceof Error ? error.message : "Verification failed";
    throw error;
  } finally {
    if (profileId)
      await db.pool.query(
        "UPDATE cw_model_profiles SET credential_enc=NULL,key_hint=NULL WHERE id=$1",
        [profileId],
      );
    await save();
    await scope?.close();
    await db.close();
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    console.info(
      "Private verification report:",
      resolve(directory, "report.json"),
    );
  }
}
const mimes = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
main().catch(() => {
  console.error(
    "Office supplier verification failed; see the private report. No retry was dispatched.",
  );
  process.exitCode = 1;
});
