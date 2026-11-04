import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { createCalendarScope } from "../fixtures/calendar-scope.js";
import { modelFixture } from "./business-contract.js";

test(
  "Native DSH and Hermes execute the same private calendar service with observed source receipts and cleaned runtime",
  { timeout: 240000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url && new URL(url).pathname.endsWith("_test"));
    const db = new Database(url),
      originalDir = process.env.RUNTIME_DIR;
    const dir = await mkdtemp(join(tmpdir(), "hyper-calendar-native-")),
      key = "synthetic-calendar-model-" + randomUUID();
    let source: Awaited<ReturnType<typeof createCalendarScope>> | undefined;
    let inject = false;
    const model = modelFixture(
      [key],
      (body) => {
        const context = JSON.stringify(body.messages);
        assert.match(context, /Host-bound private calendar operation/);
        assert.ok(!context.includes("synthetic-calendar-password"));
        assert.ok(!context.includes(key));
      },
      () => ({
        text: "Model text is not a source receipt",
        actions: [
          {
            tool: "calendar.manage",
            args: inject ? { calendarId: "another-employee" } : {},
          },
        ],
      }),
    );
    process.env.RUNTIME_DIR = dir;
    await new Promise<void>((r) => model.server.listen(0, "127.0.0.1", r));
    try {
      await db.migrate();
      source = await createCalendarScope(db);
      const f = source,
        work = new WorkspaceService(db, engineRegistry()),
        processor = new RunProcessor(work);
      const profile = await work.saveModel(f.actor, {
        name: "Synthetic native calendar",
        provider: "openai-compatible",
        endpoint:
          "http://127.0.0.1:" +
          (model.server.address() as { port: number }).port +
          "/v1",
        model: "native-test-model",
        purpose: "chat",
        scope: "personal",
        apiKey: key,
      });
      for (const engine of ["dsh", "hermes"] as const) {
        assert.equal(
          work.engines.get(engine)!.describeCapabilities().configured,
          true,
        );
        const command = await f.service.prepare(f.actor, f.create());
        const input = {
          plan: {
            operation: "apply" as const,
            commandId: command.id,
            confirmed: true as const,
          },
          engine,
          modelProfileId: profile.id,
          idempotencyKey: randomUUID(),
        };
        const started = await work.startCalendarRun(f.actor, input);
        assert.equal(
          (await work.startCalendarRun(f.actor, input)).id,
          started.id,
        );
        await processor.process(started.id);
        const actual = await work.getRun(f.actor, started.id);
        assert.equal(actual.state, "succeeded", actual.error);
        assert.equal(actual.result.evidence, "runtime");
        assert.equal(actual.result.receipts[0].observedResult, "matched");
        assert.equal(actual.result.receipts[0].commandId, command.id);
        assert.ok(!actual.result.text.includes("Model text"));
        const row = (
          await db.pool.query(
            "SELECT conversation_id,runtime_cleaned_at FROM cw_runs WHERE id=$1",
            [started.id],
          )
        ).rows[0];
        assert.equal(row.conversation_id, null);
        assert.ok(row.runtime_cleaned_at);
        await assert.rejects(work.getRun(f.peer, started.id), /不存在|无权/);
        const read = await work.startCalendarRun(f.actor, {
          ...input,
          idempotencyKey: randomUUID(),
          plan: {
            operation: "read",
            query: {
              calendarId: "personal",
              start: "2026-11-04T00:00:00Z",
              end: "2026-11-05T00:00:00Z",
            },
          },
        });
        await processor.process(read.id);
        const observed = await work.getRun(f.actor, read.id);
        assert.equal(observed.state, "succeeded", observed.error);
        assert.equal(observed.result.receipts[0].operation, "read");
        assert.equal(
          observed.result.receipts[0].count,
          engine === "dsh" ? 1 : 2,
        );
        const rejectedCommand = await f.service.prepare(f.actor, f.create());
        const rejected = await work.startCalendarRun(f.actor, {
          ...input,
          idempotencyKey: randomUUID(),
          plan: {
            operation: "apply",
            commandId: rejectedCommand.id,
            confirmed: true,
          },
        });
        inject = true;
        const before = f.source.writes;
        await processor.process(rejected.id);
        inject = false;
        assert.equal((await work.getRun(f.actor, rejected.id)).state, "failed");
        assert.equal(
          f.source.writes,
          before,
          "Model arguments never choose another calendar",
        );
        assert.equal(
          (await f.service.get(f.actor, rejectedCommand.id)).state,
          "prepared",
        );
      }
      assert.equal(f.source.writes, 2);
      assert.equal(model.calls(), 6);
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM cw_messages WHERE workspace_id=$1",
            [f.actor.workspaceId],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      model.server.closeAllConnections();
      await new Promise<void>((r) => model.server.close(() => r()));
      await source?.close();
      await db.close();
      if (originalDir === undefined) delete process.env.RUNTIME_DIR;
      else process.env.RUNTIME_DIR = originalDir;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
