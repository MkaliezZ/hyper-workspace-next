import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Subject } from "@hyper/contracts";
import { Database } from "../../apps/api/src/db/database.js";
import { ApprovalService } from "../../apps/api/src/core/approvals.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Isolated _test database required");
const db = new Database(url);
const service = new ApprovalService(db);
const workspaceId = randomUUID();
const person = (name: string, role: Subject["role"] = "member"): Subject => ({
  id: randomUUID(),
  workspaceId,
  name,
  role,
  demo: false,
});
const admin = person("Flow admin", "admin"),
  applicant = person("Applicant"),
  first = person("First reviewer"),
  second = person("Second reviewer"),
  parallel = person("Parallel reviewer"),
  finance = person("Finance reviewer"),
  other = person("Unassigned member");

before(async () => {
  await db.migrate();
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Approval tests')",
    [workspaceId],
  );
  for (const employee of [
    admin,
    applicant,
    first,
    second,
    parallel,
    finance,
    other,
  ]) {
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      employee.id,
      employee.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
      [workspaceId, employee.id, employee.role],
    );
  }
});
after(() => db.close());
const definition = () => ({
  title: "Procurement",
  fields: [
    {
      key: "amount",
      label: "Amount in cents",
      required: true,
      kind: "integer",
    },
  ],
  stages: [
    {
      label: "Parallel checks",
      steps: [
        {
          key: "countersign",
          label: "Team",
          reviewers: [first.id, second.id],
          requiredApprovals: 2,
        },
        {
          key: "compliance",
          label: "Compliance",
          reviewers: [parallel.id],
          requiredApprovals: 1,
        },
      ],
    },
    {
      label: "Finance",
      steps: [
        {
          key: "finance",
          label: "Finance",
          when: [{ field: "amount", operator: "gte", value: 10000 }],
          reviewers: [finance.id],
          requiredApprovals: 1,
        },
      ],
    },
  ],
});
const publish = () =>
  service.publish(admin, {
    definition: definition(),
    idempotencyKey: randomUUID(),
  });
const open = (flow: Awaited<ReturnType<typeof publish>>) =>
  service.open(applicant, {
    flowId: flow.id,
    version: flow.version,
    idempotencyKey: randomUUID(),
  });
const submit = (request: Awaited<ReturnType<typeof open>>, amount = 10000) =>
  service.action(applicant, request.id, {
    operation: "submit",
    expectedRevision: request.revision,
    form: { amount },
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
const vote = (attempt: number, step: string, decision = "approve") => ({
  operation: "review",
  assignmentVersion: 1,
  attempt,
  step,
  decision,
  comment: decision === "approve" ? "" : "Synthetic review explanation",
  confirmed: true,
  idempotencyKey: randomUUID(),
});

test("Only administrators publish validated versions and current definitions do not alter in-flight approvals", async () => {
  const input = { definition: definition(), idempotencyKey: randomUUID() };
  await assert.rejects(service.publish(other, input), /仅工作区管理员/);
  const [a, b] = await Promise.all([
    service.publish(admin, input),
    service.publish(admin, input),
  ]);
  assert.deepEqual(a, b);
  const request = await open(a);
  await assert.rejects(
    service.action(applicant, request.id, {
      operation: "submit",
      expectedRevision: request.revision,
      form: { amount: "10000", bogus: true },
      confirmed: true,
      idempotencyKey: randomUUID(),
    }),
    /表单/,
  );
  const latest = definition();
  latest.title = "Procurement revised";
  const revised = await service.publish(admin, {
    previous: a,
    definition: latest,
    idempotencyKey: randomUUID(),
  });
  assert.equal(revised.version, 2);
  await assert.rejects(open(a), /当前审批流程版本/);
  const sent = await submit(request);
  assert.equal(sent.flowVersion, 1);
  assert.equal(
    (await service.detail(applicant, request.id)).definition.title,
    "Procurement",
  );
  assert.ok(
    (await service.flows(other)).some(
      (item) => item.id === a.id && item.version === 2,
    ),
  );
});

test("Concurrent countersignature and a parallel step advance exactly once, then the selected branch requires finance", async () => {
  const request = await submit(await open(await publish()));
  await assert.rejects(service.detail(other, request.id), /无权/);
  await assert.rejects(service.detail(finance, request.id), /无权/);
  await assert.rejects(
    service.action(applicant, request.id, vote(request.attempt, "countersign")),
    /分派/,
  );
  const a = vote(request.attempt, "countersign");
  const decisions = await Promise.all([
    service.action(first, request.id, a),
    service.action(first, request.id, a),
    service.action(second, request.id, vote(request.attempt, "countersign")),
    service.action(parallel, request.id, vote(request.attempt, "compliance")),
  ]);
  assert.deepEqual(decisions[0], decisions[1]);
  const active = await service.detail(finance, request.id);
  assert.equal(active.state, "active");
  assert.equal(active.stage, 1);
  assert.equal(active.audit.filter((row) => row.action === "review").length, 3);
  const final = await service.action(
    finance,
    request.id,
    vote(request.attempt, "finance"),
  );
  assert.equal(final.state, "approved");
  assert.equal(
    (await service.detail(applicant, request.id)).audit.filter(
      (row) => row.action === "review",
    ).length,
    4,
  );
});

test("Return preserves old votes in the audit, resubmission recomputes conditional steps and withdrawal checks revision", async () => {
  const request = await submit(await open(await publish()));
  await service.action(first, request.id, vote(request.attempt, "countersign"));
  const returned = await service.action(
    second,
    request.id,
    vote(request.attempt, "countersign", "return"),
  );
  assert.equal(returned.state, "returned");
  const resubmitted = await submit(returned, 9000);
  assert.equal(resubmitted.attempt, 2);
  const current = await service.detail(applicant, request.id);
  assert.equal(current.stages.length, 1);
  assert.equal(current.stages[0]?.steps[0]?.assignments[0]?.decision, null);
  assert.ok(
    current.audit.some(
      (row) => row.action === "review" && row.audit.attempt === 1,
    ),
  );
  await assert.rejects(
    service.action(first, request.id, vote(request.attempt, "countersign")),
    /已结束/,
  );
  assert.ok(
    (await service.detail(second, request.id)).audit.every(
      (row) => row.audit.attempt === 2,
    ),
  );
  const withdraw = {
    operation: "withdraw",
    expectedRevision: returned.revision,
    comment: "Synthetic withdrawal",
    confirmed: true,
    idempotencyKey: randomUUID(),
  };
  await assert.rejects(
    service.action(applicant, request.id, withdraw),
    /版本已变化/,
  );
  const result = await service.action(applicant, request.id, {
    ...withdraw,
    expectedRevision: current.revision,
  });
  assert.equal(result.state, "withdrawn");
});

test("A veto makes an all-signature step fail, and a revoked reviewer cannot read or change it", async () => {
  const request = await submit(await open(await publish()), 9000);
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [workspaceId, first.id],
  );
  try {
    await assert.rejects(service.detail(first, request.id), /revoked/);
    await assert.rejects(
      service.action(first, request.id, vote(request.attempt, "countersign")),
      /revoked/,
    );
    const rejected = await service.action(
      second,
      request.id,
      vote(request.attempt, "countersign", "reject"),
    );
    assert.equal(rejected.state, "rejected");
  } finally {
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
      [workspaceId, first.id],
    );
  }
});

test("Approval reminders are private and throttled, and handoffs invalidate older assignments", async () => {
  const request = await submit(await open(await publish()), 9000);
  const reminder = {
    operation: "remind",
    idempotencyKey: randomUUID(),
    attempt: request.attempt,
    step: "countersign",
    assignmentVersion: 1,
    recipientId: first.id,
    confirmed: true,
  };
  await assert.rejects(
    service.action(second, request.id, reminder),
    /仅申请人/,
  );
  const saved = await service.action(applicant, request.id, reminder);
  assert.equal(saved.revision, request.revision);
  assert.deepEqual(
    await service.action(applicant, request.id, reminder),
    saved,
  );
  await assert.rejects(
    service.action(applicant, request.id, {
      ...reminder,
      idempotencyKey: randomUUID(),
    }),
    /最近已催办/,
  );
  assert.deepEqual(
    (await service.reminders(first)).map((row) => row.requestId),
    [request.id],
  );
  assert.deepEqual(await service.reminders(second), []);

  const handoff = {
    ...reminder,
    operation: "transfer",
    idempotencyKey: randomUUID(),
    recipientId: other.id,
    comment: "Synthetic handoff",
  };
  await assert.rejects(
    service.action(first, request.id, {
      ...handoff,
      recipientId: second.id,
    }),
    /已有审批人/,
  );
  const transferred = await service.action(first, request.id, handoff);
  assert.deepEqual(
    await service.action(first, request.id, handoff),
    transferred,
  );
  await assert.rejects(service.detail(first, request.id), /无权/);
  assert.deepEqual(await service.reminders(first), []);
  await assert.rejects(
    service.action(other, request.id, vote(request.attempt, "countersign")),
    /分派已变化/,
  );
  await service.action(other, request.id, {
    ...vote(request.attempt, "countersign"),
    assignmentVersion: 2,
  });
  assert.equal(
    (await service.detail(applicant, request.id)).audit.filter(
      (row) => row.action === "transfer",
    ).length,
    1,
  );
});

test("A conditional route with no human review cannot turn into an approved application", async () => {
  const onlyConditional = definition();
  onlyConditional.stages = [onlyConditional.stages[1]!];
  const flow = await service.publish(admin, {
    definition: onlyConditional,
    idempotencyKey: randomUUID(),
  });
  const draft = await open(flow);
  await assert.rejects(submit(draft, 9000), /没有匹配/);
  const saved = await service.detail(applicant, draft.id);
  assert.equal(saved.state, "draft");
  assert.equal(saved.attempt, 0);
  assert.deepEqual(
    saved.audit.map((item) => item.action),
    ["open"],
  );
});
