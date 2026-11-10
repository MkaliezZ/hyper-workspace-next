import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../apps/api/src/db/database.js";
import { OfficeService } from "../../apps/api/src/core/office.js";
import { OfficeRunService } from "../../apps/api/src/core/office-runs.js";
import { officeDigest } from "../../apps/api/src/core/office-provider.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { createCalendarScope } from "../fixtures/calendar-scope.js";
import { modelFixture } from "./business-contract.js";

test(
  "DSH and Hermes draft bounded Office proposals and apply only host-confirmed revisions with source receipts",
  { timeout: 420000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url && new URL(url).pathname.endsWith("_test"));
    const db = new Database(url),
      temp = await mkdtemp(join(tmpdir(), "hyper-office-native-"));
    const env = new Map(
      ["RUNTIME_DIR", "NEXTCLOUD_FILES_ENABLED", "HYPER_OFFICE_BATCH_URL"].map(
        (k) => [k, process.env[k]],
      ),
    );
    let source: Awaited<ReturnType<typeof createCalendarScope>> | undefined;
    const key = "synthetic-office-model-" + randomUUID(),
      content = "Synthetic private office paragraph " + randomUUID(),
      newText = "Reviewed Office model paragraph";
    const bytes = Buffer.from(content),
      mime =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    let puts = 0,
      mode: "draft" | "apply" = "draft",
      injected = false,
      transforms = 0;
    let beforeTransformResponse: (() => Promise<void>) | undefined,
      afterPut: (() => Promise<void>) | undefined;
    const provider = createServer(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, undefined);
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      assert.deepEqual(Buffer.from(input.contentBase64, "base64"), bytes);
      const base = {
        protocol: "office-batch/v1",
        engine: "collabora-26.04.6.1/pyuno-26.04.6-1",
        format: "docx",
        sourceSha256: officeDigest(bytes),
      };
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/inspect") {
        res.end(
          JSON.stringify({
            ...base,
            inspection: {
              paragraphs: [
                { id: "paragraph:0", text: content, editable: true },
              ],
              appendTarget: "document:end",
            },
          }),
        );
        return;
      }
      transforms++;
      assert.equal(input.sourceSha256, officeDigest(bytes));
      assert.deepEqual(input.operations, [
        { kind: "writer.append", target: "document:end", text: newText },
      ]);
      const output = Buffer.from(content + "\n" + newText);
      if (beforeTransformResponse) {
        const run = beforeTransformResponse;
        beforeTransformResponse = undefined;
        await run();
      }
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
                after: newText,
              },
            ],
            recalculated: false,
            formulaErrors: [],
            reopenedVerified: true,
          },
        }),
      );
    });
    const model = modelFixture(
      [key],
      (body) => {
        const prompt = JSON.stringify(body.messages);
        assert.match(prompt, /Host-bound Office/);
        assert.ok(!prompt.includes(source!.actor.id));
        assert.ok(!prompt.includes("synthetic-calendar-password"));
        assert.ok(!prompt.includes(key));
        if (mode === "draft") assert.ok(prompt.includes(content));
        else assert.ok(!prompt.includes(content));
      },
      () => ({
        text: "MODEL_SAYS_ALREADY_SAVED_DO_NOT_TRUST",
        actions: [
          mode === "draft"
            ? {
                tool: "office.propose",
                args: {
                  operations: [
                    {
                      kind: "writer.append",
                      target: "document:end",
                      text: newText,
                    },
                  ],
                  ...(injected
                    ? {
                        source: { path: ["other.docx"] },
                        destination: ["other"],
                      }
                    : {}),
                },
              }
            : {
                tool: "office.apply",
                args: injected
                  ? {
                      proposalId: randomUUID(),
                      expectedRevision: 99,
                      operations: [],
                    }
                  : {},
              },
        ],
      }),
    );
    try {
      await db.migrate();
      source = await createCalendarScope(db);
      const original = source.source.handle.bind(source.source);
      source.source.handle = async (req, res) => {
        if (req.method !== "PUT") return original(req, res);
        puts++;
        assert.equal(req.headers["if-none-match"], "*");
        const auth = Buffer.from(
            req.headers.authorization!.slice(6),
            "base64",
          ).toString(),
          uid = auth.split(":")[0]!;
        assert.equal(uid, "alice");
        assert.equal(
          auth.slice(uid.length + 1),
          source!.source.people.get(uid)!.password,
        );
        const path = new URL(req.url!, "http://fixture").pathname
          .split("/")
          .slice(5)
          .map(decodeURIComponent);
        assert.ok(
          !source!.source.files.files.some(
            (f) => JSON.stringify(f.path) === JSON.stringify(path),
          ),
        );
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        source!.source.files.add(uid, path, Buffer.concat(chunks), mime);
        if (afterPut) {
          const run = afterPut;
          afterPut = undefined;
          await run();
        }
        res.writeHead(201);
        res.end();
      };
      for (const server of [provider, model.server])
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
      const endpoint = (server: typeof provider) =>
        "http://127.0.0.1:" + (server.address() as { port: number }).port;
      Object.assign(process.env, {
        RUNTIME_DIR: temp,
        NEXTCLOUD_FILES_ENABLED: "true",
        HYPER_OFFICE_BATCH_URL: endpoint(provider),
      });
      const { actor, peer } = source,
        work = new WorkspaceService(db, engineRegistry()),
        processor = new RunProcessor(work),
        office = new OfficeService(db),
        runs = new OfficeRunService(db);
      const profile = await work.saveModel(actor, {
        name: "Native Office protocol fixture",
        endpoint: endpoint(model.server) + "/v1",
        model: "native-test-model",
        purpose: "chat",
        scope: "personal",
        provider: "openai-compatible",
        apiKey: key,
      });
      for (const engine of ["dsh", "hermes"] as const) {
        assert.equal(
          work.engines.get(engine)?.describeCapabilities().configured,
          true,
        );
        const file = source.source.files.add(
          "alice",
          [engine, "Private native Office.docx"],
          bytes,
          mime,
        );
        const selection = {
            path: file.path,
            expectedId: file.id,
            expectedEtag: file.etag,
          },
          draftPlan = {
            operation: "draft" as const,
            source: selection,
            expectedSha256: officeDigest(bytes),
            destination: [],
            instruction: "Append the reviewed paragraph to the document.",
          };
        const options = { engine, modelProfileId: profile.id };
        mode = "draft";
        const request = {
            ...options,
            plan: draftPlan,
            idempotencyKey: randomUUID(),
          },
          start = await work.startOfficeRun(actor, request),
          before = puts;
        assert.equal((await work.startOfficeRun(actor, request)).id, start.id);
        await processor.process(start.id);
        await processor.process(start.id);
        const completed = await work.getRun(actor, start.id);
        assert.equal(completed.state, "succeeded", completed.error);
        assert.equal(completed.result.evidence, "runtime");
        assert.equal(puts, before);
        const proposalId = completed.result.receipts[0].proposalId as string,
          proposal = await office.get(actor, proposalId);
        assert.equal(proposal.state, "prepared");
        assert.equal(proposal.revision, 1);
        assert.equal(proposal.sourceRunId, start.id);
        assert.equal(proposal.preview?.reopenedVerified, true);
        assert.ok(!JSON.stringify(completed.result).includes(content));
        assert.ok(
          !JSON.stringify(completed.result).includes(
            "MODEL_SAYS_ALREADY_SAVED",
          ),
        );
        await assert.rejects(() => work.getRun(peer, start.id));
        await assert.rejects(() => office.get(peer, proposalId));
        const applyPlan = {
          operation: "apply" as const,
          proposalId,
          expectedRevision: 1,
          confirmed: true as const,
        };
        await assert.rejects(() =>
          work.startOfficeRun(peer, {
            ...options,
            plan: applyPlan,
            idempotencyKey: randomUUID(),
          }),
        );
        await assert.rejects(() =>
          work.startOfficeRun(actor, {
            ...options,
            plan: { ...applyPlan, expectedRevision: 2 },
            idempotencyKey: randomUUID(),
          }),
        );
        mode = "apply";
        const applyRun = await work.startOfficeRun(actor, {
          ...options,
          plan: applyPlan,
          idempotencyKey: randomUUID(),
        });
        await processor.process(applyRun.id);
        await processor.process(applyRun.id);
        const applied = await work.getRun(actor, applyRun.id);
        assert.equal(applied.state, "succeeded", applied.error);
        assert.equal(puts, before + 1);
        assert.equal(applied.result.receipts[0].savedCopy, true);
        const receipt = await office.get(actor, proposalId);
        assert.ok(receipt.file);
        assert.equal(receipt.state, "succeeded");
        assert.equal(receipt.applyRunId, applyRun.id);
        assert.deepEqual(file.content, bytes);
        assert.equal(
          officeDigest(
            source.source.files.files.find((x) => x.id === receipt.file!.id)!
              .content,
          ),
          receipt.outputSha256,
        );
        await db.pool.query(
          "UPDATE cw_runs SET state='recovery_required',result=NULL WHERE id=$1",
          [applyRun.id],
        );
        assert.deepEqual(
          (await work.getRun(actor, applyRun.id)).result.receipts,
          applied.result.receipts,
        );
        mode = "draft";
        injected = true;
        const bad = await work.startOfficeRun(actor, {
          ...request,
          idempotencyKey: randomUUID(),
        });
        await processor.process(bad.id);
        injected = false;
        assert.equal((await work.getRun(actor, bad.id)).state, "failed");
        assert.equal(puts, before + 1);
        const manual = await office.create(actor, {
          source: selection,
          expectedSha256: officeDigest(bytes),
          destination: [],
          operations: [
            { kind: "writer.append", target: "document:end", text: newText },
          ],
          idempotencyKey: randomUUID(),
        });
        mode = "apply";
        injected = true;
        const substituted = await work.startOfficeRun(actor, {
          ...options,
          plan: { ...applyPlan, proposalId: manual.id },
          idempotencyKey: randomUUID(),
        });
        await processor.process(substituted.id);
        injected = false;
        assert.equal(
          (await work.getRun(actor, substituted.id)).state,
          "failed",
        );
        assert.equal((await office.get(actor, manual.id)).state, "prepared");
        assert.equal(puts, before + 1);
        const stopped = await work.startOfficeRun(actor, {
          ...options,
          plan: { ...applyPlan, proposalId: manual.id },
          idempotencyKey: randomUUID(),
        });
        beforeTransformResponse = async () => {
          await work.cancel(actor, stopped.id);
        };
        await processor.process(stopped.id);
        assert.equal((await work.getRun(actor, stopped.id)).state, "cancelled");
        assert.equal(puts, before + 1);
        assert.notEqual(
          (await office.get(actor, manual.id)).state,
          "succeeded",
        );
        const later = await office.create(actor, {
          source: selection,
          expectedSha256: officeDigest(bytes),
          destination: [],
          operations: [
            { kind: "writer.append", target: "document:end", text: newText },
          ],
          idempotencyKey: randomUUID(),
        });
        const alreadyWritten = await work.startOfficeRun(actor, {
          ...options,
          plan: { ...applyPlan, proposalId: later.id },
          idempotencyKey: randomUUID(),
        });
        afterPut = async () => {
          await work.cancel(actor, alreadyWritten.id);
        };
        await processor.process(alreadyWritten.id);
        assert.equal(puts, before + 2);
        assert.equal(
          (await office.get(actor, later.id)).state,
          "recovery_required",
        );
        assert.equal(
          (await office.reconcile(actor, later.id)).state,
          "succeeded",
        );
        const recovered = await runs.recordedReceipt(actor, alreadyWritten.id);
        assert.equal(recovered?.savedCopy, true);
        assert.equal(recovered?.proposalId, later.id);
        const state = (
          await db.pool.query(
            "SELECT runtime_cleaned_at FROM cw_runs WHERE id=$1",
            [start.id],
          )
        ).rows[0];
        assert.ok(state.runtime_cleaned_at);
        file.blockedDownloads.add("alice");
        await assert.rejects(() => work.getRun(actor, start.id));
        assert.equal(
          (await office.get(actor, proposalId)).sourceStatus,
          "invalidated",
        );
      }
      assert.equal(puts, 4);
      assert.equal(model.calls(), 12);
      assert.equal(transforms, 12);
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM cw_messages WHERE workspace_id=$1",
            [source.actor.workspaceId],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      for (const server of [provider, model.server]) {
        if (!server.listening) continue;
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
      await source?.close();
      for (const [name, value] of env) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await db.close();
      await rm(temp, { recursive: true, force: true });
    }
  },
);
