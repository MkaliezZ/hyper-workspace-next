import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CalendarRunInput } from "@hyper/contracts/calendar";
import { Database } from "../../apps/api/src/db/database.js";
import { WorkspaceService } from "../../apps/api/src/core/workspace.js";
import { CalendarRunService } from "../../apps/api/src/core/calendar-runs.js";
import { ExecutionPolicyService } from "../../apps/api/src/core/execution-policy.js";
import { engineRegistry } from "../../apps/api/src/engines/adapters.js";
import { createCalendarScope } from "../fixtures/calendar-scope.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Isolated _test DB required");
const db = new Database(url);
before(() => db.migrate());
after(() => db.close());
async function setup() {
  const f = await createCalendarScope(db),
    engines = engineRegistry();
  // Admission/service tests do not launch an SDK or call a model. Native proof is separate.
  const adapter = engines.get("dsh")!;
  const caps = adapter.describeCapabilities();
  engines.set("dsh", {
    ...adapter,
    id: "dsh",
    describeCapabilities: () => ({ ...caps, configured: true }),
    execute: async () => {
      throw Error("Admission test must not invoke a model");
    },
  });
  const work = new WorkspaceService(db, engines),
    service = new CalendarRunService(db);
  const profile = await work.saveModel(f.actor, {
    name: "Calendar admission fixture",
    provider: "openai-compatible",
    endpoint: "http://127.0.0.1:9/v1",
    model: "synthetic-not-called",
    purpose: "chat",
    scope: "personal",
    apiKey: "synthetic-never-sent",
  });
  const command = await f.service.prepare(f.actor, f.create());
  const input = CalendarRunInput.parse({
    plan: { operation: "apply", commandId: command.id, confirmed: true },
    engine: "dsh",
    modelProfileId: profile.id,
    idempotencyKey: randomUUID(),
  });
  async function running(id: string) {
    const lease = randomUUID();
    let row = (
      await db.pool.query(
        "UPDATE cw_runs SET state='running',lease_owner=$2,lease_expires_at=now()+interval '2 minutes' WHERE id=$1 RETURNING *",
        [id, lease],
      )
    ).rows[0];
    await new ExecutionPolicyService(db).admit(f.actor, row);
    row = (await db.pool.query("SELECT * FROM cw_runs WHERE id=$1", [id]))
      .rows[0];
    return { row, execution: { lease, contextBytes: 1, actionCount: 1 } };
  }
  return { ...f, work, service, input, command, running };
}
test("Private calendar admission is idempotent, forbids target injection and prevents parallel manual/AI dispatch", async () => {
  const f = await setup();
  try {
    const [a, b] = await Promise.all([
      f.work.startCalendarRun(f.actor, f.input),
      f.work.startCalendarRun(f.actor, f.input),
    ]);
    assert.equal(a.id, b.id);
    assert.equal((await f.service.history(f.actor))[0]!.id, a.id);
    assert.deepEqual(await f.service.history(f.peer), []);
    await assert.rejects(
      f.work.startCalendarRun(f.actor, {
        ...f.input,
        idempotencyKey: randomUUID(),
      }),
      /已有AI/,
    );
    await assert.rejects(
      f.service.prepare(f.peer, f.input.plan),
      /不存在|无权/,
    );
    await assert.rejects(f.work.getRun(f.peer, a.id), /不存在|无权/);
    await assert.rejects(
      f.work.startCalendarRun(f.actor, {
        ...f.input,
        actorId: f.peer.id,
      } as any),
    );
    await assert.rejects(
      f.service.calendars.apply(f.actor, f.command.id),
      /先停止/,
    );
    const row = (
      await db.pool.query("SELECT * FROM cw_runs WHERE id=$1", [a.id])
    ).rows[0];
    assert.equal(row.conversation_id, null);
    assert.equal(row.demo, false);
    assert.ok(
      !(await f.service.context(f.actor, row)).context.includes(
        "synthetic-calendar-password",
      ),
    );
    await f.work.cancel(f.actor, a.id);
    assert.equal((await f.work.getRun(f.actor, a.id)).state, "cancelled");
    assert.equal(
      (await f.service.calendars.get(f.actor, f.command.id)).state,
      "cancelled",
    );
    assert.equal((await f.work.startCalendarRun(f.actor, f.input)).id, a.id);
    assert.equal(f.source.writes, 0);
  } finally {
    await f.close();
  }
});
test("Expired leases and current execution policy block calendar writes; source identity changes revoke run reads", async () => {
  const f = await setup();
  try {
    const a = await f.work.startCalendarRun(f.actor, f.input),
      { row, execution } = await f.running(a.id);
    await db.pool.query(
      "UPDATE cw_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [a.id],
    );
    await assert.rejects(f.service.execute(f.actor, row, execution), /租约/);
    await db.pool.query(
      "UPDATE cw_runs SET lease_expires_at=now()+interval '2 minutes' WHERE id=$1",
      [a.id],
    );
    await db.pool.query(
      "INSERT INTO cw_execution_policies(workspace_id,scope,scope_id,revision,rules,updated_by)VALUES($1,'personal',$2,1,$3,$2)",
      [f.actor.workspaceId, f.actor.id, { workflows: ["chat"] }],
    );
    await assert.rejects(
      f.service.execute(f.actor, row, execution),
      /规则|允许|禁止/,
    );
    assert.equal(f.source.writes, 0);
    process.env.NEXTCLOUD_MEMBER_GROUP = "different-group";
    await assert.rejects(f.work.getRun(f.actor, a.id));
  } finally {
    await f.close();
  }
});
test("Stopping the linked command also cancels its run; effects already dispatched remain observed facts", async () => {
  const f = await setup();
  try {
    const a = await f.work.startCalendarRun(f.actor, f.input),
      { row, execution } = await f.running(a.id);
    f.source.afterWrite = async () => {
      await f.service.calendars.cancel(f.actor, f.command.id);
    };
    const result = await f.service.execute(f.actor, row, execution);
    assert.equal(result.state, "succeeded");
    assert.equal(result.stopRequested, true);
    assert.equal(result.observedResult, "matched");
    assert.equal((await f.work.getRun(f.actor, a.id)).state, "cancelled");
    assert.equal(f.source.writes, 1);
  } finally {
    await f.close();
  }
});
test("AI calendar response loss is reconciled without a second source write or another active run", async () => {
  const f = await setup();
  try {
    const a = await f.work.startCalendarRun(f.actor, f.input),
      { row, execution } = await f.running(a.id);
    f.source.mode = "drop-before";
    const result = await f.service.execute(f.actor, row, execution);
    assert.equal(result.state, "recovery_required");
    assert.equal(f.source.writes, 1);
    f.source.mode = "ok";
    assert.equal(
      (await f.service.execute(f.actor, row, execution)).state,
      "recovery_required",
    );
    assert.equal(f.source.writes, 1);
    await f.work.cancel(f.actor, a.id);
    await assert.rejects(
      f.work.startCalendarRun(f.actor, {
        ...f.input,
        idempotencyKey: randomUUID(),
      }),
      /先核对/,
    );
    assert.equal(f.source.writes, 1);
  } finally {
    await f.close();
  }
});
test("Read runs are actor-private, respect current source permissions and carry only the selected window", async () => {
  const f = await setup();
  try {
    const input = CalendarRunInput.parse({
      ...f.input,
      plan: {
        operation: "read",
        query: {
          calendarId: "personal",
          start: "2026-11-04T00:00:00Z",
          end: "2026-11-05T00:00:00Z",
        },
      },
    });
    const a = await f.work.startCalendarRun(f.actor, input),
      { row, execution } = await f.running(a.id);
    const result = await f.service.execute(f.actor, row, execution);
    assert.equal(result.operation, "read");
    assert.equal((await f.service.history(f.actor))[0]!.operation, "read");
    assert.equal(result.count, 0);
    assert.deepEqual(result.window, {
      start: "2026-11-04T00:00:00Z",
      end: "2026-11-05T00:00:00Z",
    });
    f.source.people.get("alice")!.read = false;
    await assert.rejects(f.service.history(f.actor));
    await assert.rejects(f.service.execute(f.actor, row, execution));
    assert.equal(f.source.writes, 0);
  } finally {
    await f.close();
  }
});
