import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../apps/api/src/db/database.js";
import { OcrRunService } from "../../apps/api/src/core/ocr-runs.js";
import { OcrService } from "../../apps/api/src/core/ocr.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { createCalendarScope } from "../fixtures/calendar-scope.js";
import { modelFixture } from "./business-contract.js";

test(
  "Both native executors save an employee-selected OCR draft and cannot inject a target or publish the text",
  { timeout: 260000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url && new URL(url).pathname.endsWith("_test"));
    const db = new Database(url);
    const temp = await mkdtemp(join(tmpdir(), "hyper-ocr-native-"));
    const keys = [
      "RUNTIME_DIR",
      "HYPER_OCR_URL",
      "HYPER_OCR_ENGINE",
      "NEXTCLOUD_FILES_ENABLED",
    ];
    const env = new Map(keys.map((key) => [key, process.env[key]]));
    const content = "Synthetic OCR private result " + randomUUID();
    const filename = "Sensitive selected synthetic PDF.pdf";
    const bytes = Buffer.from(
      "Synthetic private binary OCR material " + randomUUID(),
    );
    const key = "synthetic-ocr-model-" + randomUUID();
    let source: Awaited<ReturnType<typeof createCalendarScope>> | undefined;
    let injected = false;
    let recognized = 0;
    let beforeResponse: (() => Promise<void>) | undefined;
    const provider = createServer(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.headers["x-ocr-page"], "2");
      assert.equal(req.headers["content-type"], "application/pdf");
      assert.equal(req.headers.authorization, undefined);
      const received: Buffer[] = [];
      for await (const chunk of req) received.push(chunk);
      assert.deepEqual(Buffer.concat(received), bytes);
      recognized++;
      await beforeResponse?.();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          width: 500,
          height: 900,
          blocks: [
            {
              kind: "text",
              bounds: [15, 30, 400, 150],
              confidence: 0.92,
              text: content,
            },
          ],
        }),
      );
    });
    const model = modelFixture(
      [key],
      (body) => {
        const prompt = JSON.stringify(body.messages);
        assert.match(prompt, /Host-bound private OCR operation/);
        assert.ok(!prompt.includes(filename));
        assert.ok(!prompt.includes(content));
        assert.ok(!prompt.includes(bytes.toString()));
        assert.ok(!prompt.includes(source!.actor.id));
      },
      () => ({
        text: "SYNTHETIC_MODEL_CLAIM",
        actions: [{ tool: "ocr.recognize", args: injected ? { page: 1 } : {} }],
      }),
    );

    try {
      await db.migrate();
      source = await createCalendarScope(db);
      await new Promise<void>((resolve) =>
        provider.listen(0, "127.0.0.1", resolve),
      );
      await new Promise<void>((resolve) =>
        model.server.listen(0, "127.0.0.1", resolve),
      );
      const endpoint = (server: typeof provider) =>
        "http://127.0.0.1:" + (server.address() as { port: number }).port;
      Object.assign(process.env, {
        RUNTIME_DIR: temp,
        NEXTCLOUD_FILES_ENABLED: "true",
        HYPER_OCR_ENGINE: "synthetic-ocr/v1",
        HYPER_OCR_URL: endpoint(provider) + "/recognize",
      });
      const { actor, peer } = source;
      const work = new WorkspaceService(db, engineRegistry());
      const processor = new RunProcessor(work);
      const ocr = new OcrService(db);
      const profile = await work.saveModel(actor, {
        name: "Native OCR protocol fixture",
        endpoint: endpoint(model.server) + "/v1",
        model: "native-test-model",
        purpose: "chat",
        scope: "personal",
        provider: "openai-compatible",
        apiKey: key,
      });
      for (const engine of ["dsh", "hermes"] as const) {
        const file = source.source.files.add(
          "alice",
          [engine, filename],
          bytes,
          "application/pdf",
        );
        const selection = {
          path: file.path,
          expectedId: file.id,
          expectedEtag: file.etag,
          page: 2,
        };
        const request = {
          plan: {
            source: selection,
            expectedRevision: 0,
            confirmed: true as const,
          },
          engine,
          modelProfileId: profile.id,
          idempotencyKey: randomUUID(),
        };
        const start = await work.startOcrRun(actor, request);
        assert.equal((await work.startOcrRun(actor, request)).id, start.id);
        await processor.process(start.id);
        await processor.process(start.id);
        const completed = await work.getRun(actor, start.id);
        assert.equal(completed.state, "succeeded", completed.error);
        assert.equal(completed.result.evidence, "runtime");
        const { history } = await new OcrRunService(db).review(
          actor,
          selection,
        );
        assert.deepEqual(
          history.map((item) => item.id),
          [start.id],
        );
        const draft = await ocr.lookup(actor, selection);
        assert.ok(draft);
        assert.equal(draft.state, "draft");
        assert.equal(draft.content.blocks[0]?.text, content);
        assert.deepEqual(completed.result.receipts, [
          {
            tool: "ocr.recognize",
            state: "succeeded",
            documentId: draft.id,
            revision: 1,
            page: 2,
          },
        ]);
        assert.ok(!JSON.stringify(completed.result).includes(content));
        assert.ok(
          !JSON.stringify(completed.result).includes("SYNTHETIC_MODEL_CLAIM"),
        );
        await assert.rejects(work.getRun(peer, start.id), /不存在|无权/);
        assert.deepEqual(await work.search(actor, content), []);
        const persisted = (
          await db.pool.query(
            "SELECT conversation_id,runtime_cleaned_at FROM cw_runs WHERE id=$1",
            [start.id],
          )
        ).rows[0];
        assert.equal(persisted.conversation_id, null);
        assert.ok(persisted.runtime_cleaned_at);
        await db.pool.query(
          "UPDATE cw_runs SET state='recovery_required',result=NULL WHERE id=$1",
          [start.id],
        );
        assert.deepEqual(
          (await work.getRun(actor, start.id)).result.receipts,
          completed.result.receipts,
        );

        const malicious = await work.startOcrRun(actor, {
          ...request,
          plan: { ...request.plan, expectedRevision: 1 },
          idempotencyKey: randomUUID(),
        });
        injected = true;
        await processor.process(malicious.id);
        injected = false;
        assert.equal((await work.getRun(actor, malicious.id)).state, "failed");
        assert.equal((await ocr.lookup(actor, selection))?.revision, 1);

        const cancelled = await work.startOcrRun(actor, {
          ...request,
          plan: { ...request.plan, expectedRevision: 1 },
          idempotencyKey: randomUUID(),
        });
        beforeResponse = async () => {
          await work.cancel(actor, cancelled.id);
        };
        await processor.process(cancelled.id);
        beforeResponse = undefined;
        assert.equal(
          (await work.getRun(actor, cancelled.id)).state,
          "cancelled",
        );
        assert.equal((await ocr.lookup(actor, selection))?.revision, 1);
        file.blockedDownloads.add("alice");
        await assert.rejects(work.getRun(actor, start.id), /旧识别内容已清理/);
      }
      assert.equal(recognized, 4);
      assert.equal(model.calls(), 6);
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM cw_messages WHERE workspace_id=$1",
            [actor.workspaceId],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      for (const server of [model.server, provider]) {
        if (!server.listening) continue;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
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
