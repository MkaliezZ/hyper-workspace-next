import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRunInput } from "@hyper/contracts/approvals";
import { Database } from "../../apps/api/src/db/database.js";
import { ApprovalRunService } from "../../apps/api/src/core/approval-runs.js";
import { ApprovalService } from "../../apps/api/src/core/approvals.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { RunProcessor } from "../../apps/api/src/core/processor.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { createCalendarScope } from "../fixtures/calendar-scope.js";
import { modelFixture } from "./business-contract.js";

test(
  "DSH and Hermes share approval receipts while approval votes stay with employees",
  { timeout: 300000 },
  async () => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url && new URL(url).pathname.endsWith("_test"));
    const db = new Database(url);
    const originalDir = process.env.RUNTIME_DIR;
    const dir = await mkdtemp(join(tmpdir(), "hyper-approval-native-"));
    const key = "synthetic-approval-model-" + randomUUID();
    const privateReason = "Synthetic private approval field " + randomUUID();
    let source: Awaited<ReturnType<typeof createCalendarScope>> | undefined;
    let substitute = false;
    const model = modelFixture(
      [key],
      (body) => {
        const context = JSON.stringify(body.messages);
        assert.match(context, /Host-bound private approval operation/);
        assert.ok(!context.includes(privateReason));
        assert.ok(!context.includes(key));
        assert.ok(!context.includes("synthetic-calendar-password"));
        assert.ok(!context.includes(source!.actor.id));
        assert.ok(!context.includes(source!.peer.id));
      },
      () => ({
        text: "MODEL_ONLY_CLAIM",
        actions: [
          {
            tool: "approval.manage",
            args: substitute
              ? { operation: "review", decision: "approve" }
              : {},
          },
        ],
      }),
    );
    process.env.RUNTIME_DIR = dir;
    await new Promise<void>((resolve) =>
      model.server.listen(0, "127.0.0.1", resolve),
    );
    try {
      await db.migrate();
      source = await createCalendarScope(db);
      const { actor, peer } = source;
      const approvals = new ApprovalService(db);
      const work = new WorkspaceService(db, engineRegistry());
      const processor = new RunProcessor(work);
      const profile = await work.saveModel(peer, {
        name: "Synthetic approval model",
        provider: "openai-compatible",
        endpoint:
          "http://127.0.0.1:" +
          (model.server.address() as { port: number }).port +
          "/v1",
        model: "native-test-model",
        purpose: "chat",
        scope: "workspace",
        apiKey: key,
      });
      const flow = await approvals.publish(peer, {
        idempotencyKey: randomUUID(),
        definition: {
          title: "Synthetic private approval flow",
          fields: [
            { key: "reason", label: "Reason", kind: "text", required: true },
          ],
          stages: [
            {
              label: "Approval",
              steps: [
                {
                  key: "sign",
                  label: "Sign",
                  reviewers: [peer.id],
                  requiredApprovals: 1,
                },
              ],
            },
          ],
        },
      });
      const recipient = {
        ...actor,
        id: randomUUID(),
        name: "Synthetic delegate",
        identityCredentialId: undefined,
      };
      await db.pool.query("INSERT INTO cw_users(id,name) VALUES($1,$2)", [
        recipient.id,
        recipient.name,
      ]);
      await db.pool.query(
        "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
        [recipient.workspaceId, recipient.id],
      );
      for (const engine of ["dsh", "hermes"] as const) {
        assert.equal(
          work.engines.get(engine)?.describeCapabilities().configured,
          true,
        );
        const draft = await approvals.open(actor, {
          flowId: flow.id,
          version: flow.version,
          idempotencyKey: randomUUID(),
        });
        const options = { engine, modelProfileId: profile.id };
        const submission = ApprovalRunInput.parse({
          ...options,
          idempotencyKey: randomUUID(),
          plan: {
            operation: "apply",
            requestId: draft.id,
            action: {
              operation: "submit",
              expectedRevision: draft.revision,
              form: { reason: privateReason },
              confirmed: true,
              idempotencyKey: randomUUID(),
            },
          },
        });
        const started = await work.startApprovalRun(actor, submission);
        assert.equal(
          (await work.startApprovalRun(actor, submission)).id,
          started.id,
        );
        await processor.process(started.id);
        await processor.process(started.id);
        const applied = await work.getRun(actor, started.id);
        assert.equal(applied.state, "succeeded", applied.error);
        assert.equal(applied.result.evidence, "runtime");
        assert.equal(applied.result.receipts.length, 1);
        assert.equal(applied.result.receipts[0].approval.state, "active");
        assert.ok(!JSON.stringify(applied.result).includes(privateReason));
        assert.ok(!JSON.stringify(applied.result).includes("MODEL_ONLY_CLAIM"));
        const saved = (
          await db.pool.query(
            "SELECT conversation_id,runtime_cleaned_at FROM cw_runs WHERE id=$1",
            [started.id],
          )
        ).rows[0];
        assert.equal(saved.conversation_id, null);
        assert.ok(saved.runtime_cleaned_at);
        const operations = await db.pool.query(
          "SELECT action FROM cw_approval_operations WHERE source_run_id=$1",
          [started.id],
        );
        assert.deepEqual(operations.rows, [{ action: "submit" }]);
        await assert.rejects(work.getRun(peer, started.id), /不存在|无权/);
        // Simulate a worker losing its final state after the business transaction committed.
        await db.pool.query(
          "UPDATE cw_runs SET state='recovery_required',result=NULL WHERE id=$1",
          [started.id],
        );
        const interrupted = await work.getRun(actor, started.id);
        assert.equal(interrupted.state, "recovery_required");
        assert.deepEqual(interrupted.result.receipts, applied.result.receipts);
        const history = new ApprovalRunService(db);
        assert.ok(
          (await history.history(actor)).some((item) => item.id === started.id),
        );
        assert.ok(
          !(await history.history(peer)).some((item) => item.id === started.id),
        );
        const readPlan = { operation: "read" as const, requestId: draft.id };
        const invalid = await work.startApprovalRun(actor, {
          ...options,
          idempotencyKey: randomUUID(),
          plan: readPlan,
        });
        substitute = true;
        await processor.process(invalid.id);
        substitute = false;
        const rejected = await work.getRun(actor, invalid.id);
        assert.equal(rejected.state, "failed", rejected.error);
        const current = await approvals.detail(actor, draft.id);
        assert.equal(current.state, "active");
        assert.equal(current.revision, draft.revision + 1);
        const signed = await approvals.action(peer, draft.id, {
          operation: "review",
          attempt: current.attempt,
          step: "sign",
          assignmentVersion: 1,
          decision: "approve",
          confirmed: true,
          idempotencyKey: randomUUID(),
        });
        assert.equal(signed.state, "approved");
        const read = await work.startApprovalRun(actor, {
          ...options,
          idempotencyKey: randomUUID(),
          plan: readPlan,
        });
        await processor.process(read.id);
        const observed = await work.getRun(actor, read.id);
        assert.equal(observed.state, "succeeded", observed.error);
        assert.deepEqual(observed.result.receipts[0].approval, signed);
        assert.ok(!JSON.stringify(observed.result).includes(privateReason));

        const another = await approvals.open(actor, {
          flowId: flow.id,
          version: flow.version,
          idempotencyKey: randomUUID(),
        });
        const active = (await approvals.action(actor, another.id, {
          operation: "submit",
          expectedRevision: another.revision,
          form: { reason: privateReason },
          confirmed: true,
          idempotencyKey: randomUUID(),
        })) as { attempt: number; revision: number };
        const assignment = {
          attempt: active.attempt,
          step: "sign",
          assignmentVersion: 1,
          confirmed: true,
        };
        async function assist(
          owner: typeof actor,
          action: Record<string, unknown>,
        ) {
          const input = ApprovalRunInput.parse({
            ...options,
            idempotencyKey: randomUUID(),
            plan: {
              operation: "apply",
              requestId: another.id,
              action: { ...action, idempotencyKey: randomUUID() },
            },
          });
          const queued = await work.startApprovalRun(owner, input);
          await processor.process(queued.id);
          const completed = await work.getRun(owner, queued.id);
          assert.equal(completed.state, "succeeded", completed.error);
          assert.equal(
            completed.result.receipts[0].operation,
            action.operation,
          );
          return {
            id: queued.id,
            approval: completed.result.receipts[0].approval,
          };
        }
        const reminded = await assist(actor, {
          ...assignment,
          operation: "remind",
          recipientId: peer.id,
        });
        assert.equal(reminded.approval.revision, active.revision);
        assert.ok(
          (await approvals.reminders(peer)).some(
            (reminder) => reminder.requestId === another.id,
          ),
        );
        const transferred = await assist(peer, {
          ...assignment,
          operation: "transfer",
          recipientId: recipient.id,
          comment: "Synthetic reassignment",
        });
        assert.equal(transferred.approval.revision, active.revision + 1);
        assert.ok(
          (await history.history(peer)).some(
            (item) => item.id === transferred.id,
          ),
        );
        await assert.rejects(approvals.detail(peer, another.id), /不存在|无权/);
        const delegated = await approvals.detail(recipient, another.id);
        assert.equal(delegated.stages[0].steps[0].assignments[0].version, 2);
        const withdrawn = await assist(actor, {
          operation: "withdraw",
          expectedRevision: delegated.revision,
          comment: "Synthetic withdrawal",
          confirmed: true,
        });
        assert.equal(withdrawn.approval.state, "withdrawn");
      }
      assert.equal(model.calls(), 12);
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
      model.server.closeAllConnections();
      await new Promise<void>((resolve) => model.server.close(() => resolve()));
      await source?.close();
      await db.close();
      if (originalDir === undefined) delete process.env.RUNTIME_DIR;
      else process.env.RUNTIME_DIR = originalDir;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
