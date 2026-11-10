import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { OfficeService } from "../../apps/api/src/core/office.js";
import { OfficeRunService } from "../../apps/api/src/core/office-runs.js";
import { officeDigest } from "../../apps/api/src/core/office-provider.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { createCalendarScope } from "../fixtures/calendar-scope.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated _test database required");
const db = new Database(url);
before(() => db.migrate());
after(() => db.close());

/** Real product/SQL/DAV lifecycle with synthetic document engine. No native executor/model is invoked. */
async function setup() {
  const source = await createCalendarScope(db),
    engines = engineRegistry();
  const adapter = engines.get("dsh")!,
    capabilities = adapter.describeCapabilities();
  engines.set("dsh", {
    ...adapter,
    id: "dsh",
    describeCapabilities: () => ({ ...capabilities, configured: true }),
    execute: async () => {
      throw new Error("Receipt integration must not invoke a model");
    },
  });
  const savedEnv = new Map(
    ["NEXTCLOUD_FILES_ENABLED", "HYPER_OFFICE_BATCH_URL"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  const mime =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const file = source.source.files.add(
    "alice",
    ["Private receipt source " + randomUUID() + ".docx"],
    "Synthetic private paragraph " + randomUUID(),
    mime,
  );
  const selection = {
    path: file.path,
    expectedId: file.id,
    expectedEtag: file.etag,
  };
  let puts = 0,
    hideReadback = false,
    failEngine = false;
  const uploaded: (typeof file)[] = [];
  const original = source.source.handle.bind(source.source);
  source.source.handle = async (req, res) => {
    if (req.method !== "PUT") return original(req, res);
    puts++;
    assert.equal(req.headers["if-none-match"], "*");
    const auth = Buffer.from(
      req.headers.authorization!.slice(6),
      "base64",
    ).toString();
    assert.equal(auth, "alice:" + source.source.people.get("alice")!.password);
    const path = new URL(req.url!, "http://fixture").pathname
      .split("/")
      .slice(5)
      .map(decodeURIComponent);
    assert.ok(
      !source.source.files.files.some(
        (item) => JSON.stringify(item.path) === JSON.stringify(path),
      ),
    );
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const output = source.source.files.add(
      "alice",
      path,
      Buffer.concat(chunks),
      mime,
    );
    if (hideReadback) output.blockedDownloads.add("alice");
    uploaded.push(output);
    res.writeHead(201);
    res.end();
  };
  const engine = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw),
      bytes = Buffer.from(input.contentBase64, "base64");
    assert.deepEqual(bytes, file.content);
    res.setHeader("Content-Type", "application/json");
    if (failEngine) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: { code: "busy" } }));
      return;
    }
    const base = {
      protocol: "office-batch/v1",
      engine: "collabora-26.04.6.1/pyuno-26.04.6-1",
      format: "docx",
      sourceSha256: officeDigest(bytes),
    };
    if (req.url === "/inspect") {
      res.end(
        JSON.stringify({
          ...base,
          inspection: {
            paragraphs: [
              { id: "paragraph:0", text: bytes.toString(), editable: true },
            ],
            appendTarget: "document:end",
          },
        }),
      );
      return;
    }
    const output = Buffer.from(
      bytes.toString() + "\n" + input.operations[0].text,
    );
    res.end(
      JSON.stringify({
        ...base,
        contentBase64: output.toString("base64"),
        outputSha256: officeDigest(output),
        summary: {
          operations: [
            {
              kind: "writer.append",
              target: "paragraph:1",
              before: null,
              after: input.operations[0].text,
            },
          ],
          recalculated: false,
          formulaErrors: [],
          reopenedVerified: true,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  process.env.NEXTCLOUD_FILES_ENABLED = "true";
  process.env.HYPER_OFFICE_BATCH_URL =
    "http://127.0.0.1:" + (engine.address() as { port: number }).port;
  const work = new WorkspaceService(db, engines),
    office = new OfficeService(db),
    runs = new OfficeRunService(db);
  const model = await work.saveModel(source.actor, {
    name: "Synthetic receipt-only model",
    provider: "openai-compatible",
    endpoint: "http://127.0.0.1:9/v1",
    model: "not-called",
    purpose: "chat",
    scope: "personal",
    apiKey: "synthetic-never-sent",
  });
  const input = {
    source: selection,
    expectedSha256: officeDigest(file.content),
    destination: [],
    operations: [
      {
        kind: "writer.append" as const,
        target: "document:end" as const,
        text: "Reviewed private addition",
      },
    ],
    idempotencyKey: randomUUID(),
  };
  const proposal = await office.create(source.actor, input);
  const options = { engine: "dsh" as const, modelProfileId: model.id };
  const start = (revision = 1) =>
    work.startOfficeRun(source.actor, {
      ...options,
      plan: {
        operation: "apply",
        proposalId: proposal.id,
        expectedRevision: revision,
        confirmed: true,
      },
      idempotencyKey: randomUUID(),
    });
  async function apply(runId: string, revision = 1) {
    return office.apply(
      source.actor,
      proposal.id,
      { confirmed: true, expectedRevision: revision, idempotencyKey: runId },
      { runId },
    );
  }
  async function cache(runId: string, state: string) {
    const receipt = await runs.recordedReceipt(source.actor, runId);
    assert.ok(receipt);
    await db.pool.query("UPDATE cw_runs SET state=$2,result=$3 WHERE id=$1", [
      runId,
      state,
      JSON.stringify({ receipts: [receipt] }),
    ]);
    return receipt;
  }
  return {
    ...source,
    file,
    selection,
    input,
    proposal,
    work,
    office,
    runs,
    options,
    start,
    apply,
    cache,
    puts: () => puts,
    hideReadback(value: boolean) {
      hideReadback = value;
    },
    failEngine(value: boolean) {
      failEngine = value;
    },
    allowReadback() {
      for (const output of uploaded) output.blockedDownloads.delete("alice");
    },
    async close() {
      engine.closeAllConnections();
      await new Promise<void>((resolve) => engine.close(() => resolve()));
      await source.close();
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test("Office history advances cached unknown receipts after same-attempt readback, with no second PUT", async () => {
  const f = await setup();
  try {
    const run = await f.start();
    f.hideReadback(true);
    const unknown = await f.apply(run.id);
    assert.equal(unknown.state, "recovery_required");
    assert.equal(f.puts(), 1);
    const cached = await f.cache(run.id, "recovery_required");
    assert.equal(cached.savedCopy, false);
    assert.equal(
      (await f.work.getRun(f.actor, run.id)).result.receipts[0].savedCopy,
      false,
    );
    f.allowReadback();
    const reconciled = await f.office.reconcile(f.actor, f.proposal.id);
    assert.equal(reconciled.state, "succeeded");
    assert.equal(reconciled.applyRunId, run.id);
    assert.equal(reconciled.revision, 1);
    const ledger = (
      await db.pool.query(
        "SELECT response,revision FROM cw_office_requests WHERE run_id=$1",
        [run.id],
      )
    ).rows[0];
    assert.equal(ledger.response.state, "recovery_required");
    assert.equal(ledger.revision, 1);
    // Both stored request and run-result caches still say unknown. The host must prefer the verified same-attempt fact.
    const refreshed = await f.work.getRun(f.actor, run.id);
    assert.equal(refreshed.result.receipts[0].savedCopy, true);
    assert.equal(refreshed.result.receipts[0].state, "succeeded");
    assert.equal(refreshed.result.receipts[0].proposalState, "succeeded");
    await db.pool.query("UPDATE cw_runs SET result=NULL WHERE id=$1", [run.id]);
    assert.equal(
      (await f.work.getRun(f.actor, run.id)).result.receipts[0].savedCopy,
      true,
    );
    assert.equal(
      (await f.office.reconcile(f.actor, f.proposal.id)).state,
      "succeeded",
    );
    assert.equal(f.puts(), 1);
    await assert.rejects(() => f.work.getRun(f.peer, run.id), /不存在|无权/);
  } finally {
    await f.close();
  }
});

for (const changedRevision of [false, true])
  test(`Office history does not attribute another run's success to an old failed attempt (${changedRevision ? "new" : "same"} revision)`, async () => {
    const f = await setup();
    try {
      const old = await f.start();
      // Admit the same-revision retry before starting either fixture attempt; no executor is launched.
      let next = changedRevision ? undefined : await f.start();
      f.failEngine(true);
      const failed = await f.apply(old.id);
      assert.equal(failed.state, "failed");
      assert.equal(failed.retryable, true);
      const oldReceipt = await f.cache(old.id, "failed");
      assert.equal(oldReceipt.savedCopy, false);
      assert.equal(f.puts(), 0);
      f.failEngine(false);
      let revision = 1;
      if (changedRevision) {
        const edit = await f.office.edit(f.actor, f.proposal.id, {
          expectedRevision: 1,
          operations: f.input.operations,
          idempotencyKey: randomUUID(),
        });
        revision = edit.revision;
        assert.equal(revision, 2);
        next = await f.start(revision);
      }
      const success = await f.apply(next!.id, revision);
      assert.equal(success.state, "succeeded");
      assert.equal(success.applyRunId, next!.id);
      assert.equal(f.puts(), 1);
      await f.cache(next!.id, "succeeded");
      const history = await f.work.getRun(f.actor, old.id);
      assert.equal(history.result.receipts[0].state, "failed");
      assert.equal(history.result.receipts[0].savedCopy, false);
      assert.equal(history.result.receipts[0].revision, 1);
      assert.equal(
        (await f.work.getRun(f.actor, next!.id)).result.receipts[0].savedCopy,
        true,
      );
      await db.pool.query("UPDATE cw_runs SET result=NULL WHERE id=$1", [
        old.id,
      ]);
      assert.deepEqual((await f.work.getRun(f.actor, old.id)).result.receipts, [
        oldReceipt,
      ]);
      assert.equal(f.puts(), 1);
    } finally {
      await f.close();
    }
  });

test("Office proposal listing revocation clears linked draft-run instruction, plan paths, result and context references", async () => {
  const f = await setup();
  try {
    const privateInstruction =
      "Private employee Office request " + randomUUID();
    const draft = await f.work.startOfficeRun(f.actor, {
      ...f.options,
      plan: {
        operation: "draft",
        source: f.selection,
        expectedSha256: f.input.expectedSha256,
        destination: [],
        instruction: privateInstruction,
      },
      idempotencyKey: randomUUID(),
    });
    await db.pool.query(
      "UPDATE cw_runs SET result=$2,context_refs=$3 WHERE id=$1",
      [
        draft.id,
        JSON.stringify({ private: privateInstruction }),
        JSON.stringify([f.file.path.join("/")]),
      ],
    );
    f.file.blockedDownloads.add("alice");
    const proposals = await f.office.list(f.actor);
    assert.equal(proposals[0]!.sourceStatus, "invalidated");
    const stored = (
      await db.pool.query(
        "SELECT instruction,office_plan,result,context_refs FROM cw_runs WHERE id=$1",
        [draft.id],
      )
    ).rows[0];
    assert.equal(stored.instruction, "");
    assert.equal(stored.result, null);
    assert.deepEqual(stored.context_refs, []);
    assert.equal(stored.office_plan.redacted, true);
    assert.equal(typeof stored.office_plan.binding, "string");
    assert.ok(!JSON.stringify(stored).includes(privateInstruction));
    assert.ok(!JSON.stringify(stored).includes(f.file.path[0]!));
    await assert.rejects(() => f.work.getRun(f.actor, draft.id), /失效|清理/);
    assert.equal(f.puts(), 0);
  } finally {
    await f.close();
  }
});
