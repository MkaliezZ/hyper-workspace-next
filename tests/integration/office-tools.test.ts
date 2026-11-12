import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { Database } from "../../apps/api/src/db/database.js";
import { OfficeService } from "../../apps/api/src/core/office.js";
import {
  OfficeProvider,
  officeDigest,
} from "../../apps/api/src/core/office-provider.js";
import { createCalendarScope } from "../fixtures/calendar-scope.js";
import type { OfficeProposalCreate } from "@hyper/contracts/office";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Isolated _test database required");
const db = new Database(url),
  service = new OfficeService(db);
let f: Awaited<ReturnType<typeof createCalendarScope>>,
  puts = 0,
  mode = "ok",
  engineMode = "ok";
let afterTransform: (() => Promise<void>) | undefined,
  afterPut: (() => Promise<void>) | undefined;
const mime =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const engine = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString()),
    bytes = Buffer.from(input.contentBase64, "base64");
  const base = {
    protocol: "office-batch/v1",
    engine: "collabora-26.04.6.1/pyuno-26.04.6-1",
    format: input.format,
    sourceSha256: officeDigest(bytes),
  };
  res.setHeader("content-type", "application/json");
  if (engineMode === "fail") {
    res.writeHead(504);
    res.end(JSON.stringify({ error: { code: "timeout" } }));
    return;
  }
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
    bytes.toString() +
      "\n" +
      input.operations.map((o: any) => o.text).join("\n"),
  );
  if (afterTransform) {
    const run = afterTransform;
    afterTransform = undefined;
    await run();
  }
  res.end(
    JSON.stringify({
      ...base,
      contentBase64: output.toString("base64"),
      outputSha256: officeDigest(output),
      summary: {
        operations: input.operations.map((o: any) => ({
          kind: o.kind,
          target: o.kind === "writer.append" ? "paragraph:1" : o.target,
          before: o.kind === "writer.append" ? null : o.expectedText,
          after: o.text,
        })),
        recalculated: false,
        formulaErrors: [],
        reopenedVerified: true,
      },
    }),
  );
});
before(async () => {
  process.env.NEXTCLOUD_FILES_ENABLED = "true";
  await db.migrate();
  f = await createCalendarScope(db);
  const original = f.source.handle.bind(f.source);
  f.source.handle = async (req, res) => {
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
      f.source.people.get(uid)!.password,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (mode === "drop-before") {
      req.socket.destroy();
      return;
    }
    const path = new URL(req.url!, "http://fixture").pathname
      .split("/")
      .slice(5)
      .map(decodeURIComponent);
    if (
      mode === "collision" ||
      f.source.files.files.some(
        (file) => JSON.stringify(file.path) === JSON.stringify(path),
      )
    ) {
      res.writeHead(412);
      res.end();
      return;
    }
    const file = f.source.files.add(
      uid,
      path,
      mode === "corrupt" ? Buffer.alloc(bytes.length) : bytes,
      mime,
    );
    if (mode === "change-read")
      file.afterRead = () => {
        file.etag = '"changed"';
      };
    if (afterPut) {
      const run = afterPut;
      afterPut = undefined;
      await run();
    }
    if (mode === "drop-after") {
      req.socket.destroy();
      return;
    }
    res.writeHead(201);
    res.end();
  };
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  process.env.HYPER_OFFICE_BATCH_URL =
    "http://127.0.0.1:" + (engine.address() as { port: number }).port;
});
after(async () => {
  engine.closeAllConnections();
  await new Promise<void>((r) => engine.close(() => r()));
  await f?.close();
  await db.close();
});
function fixture() {
  mode = "ok";
  engineMode = "ok";
  afterPut = undefined;
  afterTransform = undefined;
  f.source.files.directoryPermissions.delete("alice");
  const file = f.source.files.add(
    "alice",
    [randomUUID() + ".docx"],
    "Private synthetic paragraph",
    mime,
  );
  const input: OfficeProposalCreate = {
    source: { path: file.path, expectedId: file.id, expectedEtag: file.etag },
    expectedSha256: officeDigest(file.content),
    destination: [],
    operations: [
      {
        kind: "writer.append",
        target: "document:end",
        text: "Reviewed new paragraph",
      },
    ],
    idempotencyKey: randomUUID(),
  };
  return { file, input };
}
const apply = (revision = 1) => ({
  confirmed: true as const,
  expectedRevision: revision,
  idempotencyKey: randomUUID(),
});
test("Office inspect binds identity and exact source; proposal is private, editable, idempotent and publishes only a new readback-verified copy", async () => {
  const { file, input } = fixture(),
    checked = await service.inspect(f.actor, input.source);
  assert.equal(checked.sourceSha256, input.expectedSha256);
  assert.ok(checked.binding);
  assert.deepEqual(await service.checkSource(f.actor, input.source), {
    binding: checked.binding,
    format: "docx",
  });
  const initial = puts,
    [a, b] = await Promise.all([
      service.create(f.actor, input),
      service.create(f.actor, input),
    ]);
  assert.equal(a.id, b.id);
  assert.equal(a.state, "prepared");
  assert.equal(puts, initial);
  assert.equal(a.preview?.reopenedVerified, true);
  await assert.rejects(
    () =>
      service.create(f.actor, {
        ...input,
        operations: [
          { kind: "writer.append", target: "document:end", text: "different" },
        ],
      }),
    /幂等/,
  );
  await assert.rejects(() => service.get(f.peer, a.id), /不存在/);
  assert.equal((await service.list(f.peer)).length, 0);
  const edit = {
    expectedRevision: 1,
    operations: [
      {
        kind: "writer.append" as const,
        target: "document:end" as const,
        text: "Human revision",
      },
    ],
    idempotencyKey: randomUUID(),
  };
  const revised = await service.edit(f.actor, a.id, edit);
  assert.equal(revised.revision, 2);
  assert.equal((await service.edit(f.actor, a.id, edit)).revision, 2);
  await assert.rejects(
    () =>
      service.edit(f.actor, a.id, { ...edit, idempotencyKey: randomUUID() }),
    /版本/,
  );
  await assert.rejects(() => service.apply(f.actor, a.id, apply(1)), /版本/);
  const key = apply(2);
  await Promise.all([
    service.apply(f.actor, a.id, key),
    service.apply(f.actor, a.id, key),
  ]);
  const result = await service.get(f.actor, a.id);
  assert.equal(result.state, "succeeded");
  assert.ok(result.file);
  assert.equal(puts, initial + 1);
  assert.match(result.file.name, new RegExp(a.id));
  assert.notEqual(result.file.id, file.id);
  assert.equal(file.content.toString(), "Private synthetic paragraph");
  const output = f.source.files.files.find((v) => v.id === result.file!.id)!;
  assert.equal(officeDigest(output.content), result.outputSha256);
  await service.apply(f.actor, a.id, key);
  assert.equal(puts, initial + 1);
});
test("Office engine failure is retryable but an earlier idempotency key never dispatches a second attempt", async () => {
  const { input } = fixture(),
    p = await service.create(f.actor, input),
    key = apply(),
    initial = puts;
  engineMode = "fail";
  const failed = await service.apply(f.actor, p.id, key);
  assert.equal(failed.state, "failed");
  assert.equal(failed.retryable, true);
  assert.equal(puts, initial);
  engineMode = "ok";
  assert.equal((await service.apply(f.actor, p.id, key)).state, "failed");
  assert.equal(puts, initial);
  assert.equal(
    (await service.apply(f.actor, p.id, apply())).state,
    "succeeded",
  );
  assert.equal(puts, initial + 1);
  assert.equal((await service.apply(f.actor, p.id, key)).state, "failed");
  assert.equal(puts, initial + 1);
});
test("Office uncertain PUT is never replayed and reconciliation reads current exact bytes", async () => {
  const { input } = fixture(),
    p = await service.create(f.actor, input),
    key = apply(),
    initial = puts;
  mode = "drop-before";
  assert.equal(
    (await service.apply(f.actor, p.id, key)).state,
    "recovery_required",
  );
  await service.apply(f.actor, p.id, key);
  assert.equal(puts, initial + 1);
  await assert.rejects(() => service.apply(f.actor, p.id, apply()), /状态/);
  assert.equal(
    (await service.reconcile(f.actor, p.id)).state,
    "recovery_required",
  );
  const row = (
    await db.pool.query("SELECT * FROM cw_office_proposals WHERE id=$1", [p.id])
  ).rows[0];
  const wrong = f.source.files.add(
    "alice",
    row.target_path,
    Buffer.alloc(row.output_size),
    mime,
  );
  assert.equal(
    (await service.reconcile(f.actor, p.id)).state,
    "recovery_required",
  );
  wrong.content = Buffer.from(
    "Private synthetic paragraph\nReviewed new paragraph",
  );
  wrong.etag = '"v2"';
  assert.equal((await service.reconcile(f.actor, p.id)).state, "succeeded");
  assert.equal(puts, initial + 1);
});
test("Office lost acknowledgement can reconcile a successful write; collision never adopts existing bytes", async () => {
  const a = fixture(),
    p = await service.create(f.actor, a.input);
  mode = "drop-after";
  assert.equal(
    (await service.apply(f.actor, p.id, apply())).state,
    "succeeded",
  );
  const b = fixture(),
    q = await service.create(f.actor, b.input);
  mode = "collision";
  const collision = await service.apply(f.actor, q.id, apply());
  assert.equal(collision.state, "failed");
  assert.equal(collision.retryable, false);
  assert.equal(collision.error, "target_conflict");
  assert.equal((await service.reconcile(f.actor, q.id)).state, "failed");
});
test("Office source revoke and drift clear all derived content, retain audit and never delete published copies", async () => {
  const { input, file } = fixture(),
    p = await service.create(f.actor, input),
    saved = await service.apply(f.actor, p.id, apply());
  file.blockedDownloads.add("alice");
  const revoked = await service.get(f.actor, p.id);
  assert.equal(revoked.sourceStatus, "invalidated");
  assert.equal(revoked.state, "succeeded");
  assert.equal(revoked.preview, null);
  assert.equal(revoked.operations, null);
  assert.equal(revoked.file, null);
  assert.ok(f.source.files.files.some((x) => x.id === saved.file!.id));
  const row = (
    await db.pool.query("SELECT * FROM cw_office_proposals WHERE id=$1", [p.id])
  ).rows[0];
  assert.equal(row.preview, null);
  assert.deepEqual(row.source_path, []);
  assert.equal(row.source_title, "");
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*) FROM cw_office_requests WHERE proposal_id=$1 AND response IS NOT NULL",
        [p.id],
      )
    ).rows[0].count,
    "0",
  );
  const b = fixture(),
    q = await service.create(f.actor, b.input),
    initial = puts;
  b.file.etag = '"new"';
  await assert.rejects(() => service.apply(f.actor, q.id, apply()), /失效/);
  assert.equal(puts, initial);
  assert.equal((await service.get(f.actor, q.id)).sourceStatus, "invalidated");
});
test("Office final pre-PUT checks reject source drift, read denial and current destination create permission", async () => {
  const a = fixture();
  f.source.files.directoryPermissions.set("alice", "R");
  await assert.rejects(() => service.create(f.actor, a.input));
  f.source.files.directoryPermissions.delete("alice");
  const p = await service.create(f.actor, a.input),
    initial = puts;
  afterTransform = async () => {
    f.source.files.directoryPermissions.set("alice", "R");
  };
  await assert.rejects(() => service.apply(f.actor, p.id, apply()));
  assert.equal(puts, initial);
  const b = fixture(),
    q = await service.create(f.actor, b.input);
  afterTransform = async () => {
    b.file.etag = '"changed-during-generation"';
  };
  await assert.rejects(() => service.apply(f.actor, q.id, apply()));
  assert.equal(puts, initial);
});
test("Office create/edit CAS and cancel racing a transform prevent late mutation and PUT", async () => {
  const { input } = fixture(),
    p = await service.create(f.actor, input),
    initial = puts;
  afterTransform = async () => {
    await service.cancel(f.actor, p.id, {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
  };
  await assert.rejects(
    () => service.apply(f.actor, p.id, apply()),
    /停止|变化/,
  );
  assert.equal((await service.get(f.actor, p.id)).state, "cancelled");
  assert.equal(puts, initial);
  const b = fixture(),
    q = await service.create(f.actor, b.input),
    change = {
      expectedRevision: 1,
      operations: b.input.operations,
      idempotencyKey: randomUUID(),
    };
  const results = await Promise.allSettled([
    service.edit(f.actor, q.id, change),
    service.edit(f.actor, q.id, { ...change, idempotencyKey: randomUUID() }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await service.get(f.actor, q.id)).revision, 2);
});
test("Office apply rejects old authorized operations when a concurrent edit reaches the requested revision before its lock", async () => {
  const { input } = fixture(),
    proposal = await service.create(f.actor, input),
    initialPuts = puts,
    request = apply(2);
  const revisedOperations: OfficeProposalCreate["operations"] = [
    {
      kind: "writer.append",
      target: "document:end",
      text: "The separately saved revision two operations",
    },
  ];
  // Preserve the first authorization's revision-one snapshot while a separate
  // edit commits revision two, then let apply lock the newer row. Both calls
  // still use the real service, synthetic DAV and isolated test database.
  const internal = service as any;
  const originalAuthorized = internal.authorized;
  let interleaved = false;
  internal.authorized = async (...args: unknown[]) => {
    const snapshot = await originalAuthorized.apply(service, args);
    if (!interleaved && args[1] === proposal.id && args[2] === true) {
      interleaved = true;
      assert.equal(snapshot.row.revision, 1);
      const edited = await service.edit(f.actor, proposal.id, {
        expectedRevision: 1,
        operations: revisedOperations,
        idempotencyKey: randomUUID(),
      });
      assert.equal(edited.revision, 2);
    }
    return snapshot;
  };
  try {
    await assert.rejects(
      () => service.apply(f.actor, proposal.id, request),
      /版本|变化/,
    );
  } finally {
    internal.authorized = originalAuthorized;
  }
  assert.equal(interleaved, true);
  assert.equal(puts, initialPuts);
  const current = await service.get(f.actor, proposal.id);
  assert.equal(current.revision, 2);
  assert.equal(current.state, "prepared");
  assert.deepEqual(current.operations, revisedOperations);
  assert.equal(current.outputSha256, null);
  assert.equal(
    (
      await db.pool.query(
        "SELECT count(*)::int AS n FROM cw_office_requests WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3",
        [f.actor.workspaceId, f.actor.id, request.idempotencyKey],
      )
    ).rows[0].n,
    0,
  );
});

test("Office cancellation after PUT retains success and stopping an execution leaves recoverable evidence", async () => {
  const { input } = fixture(),
    p = await service.create(f.actor, input);
  afterPut = async () => {
    await service.cancel(f.actor, p.id, {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
  };
  const result = await service.apply(f.actor, p.id, apply());
  assert.equal(result.state, "succeeded");
  assert.equal(result.cancelRequested, true);
  const b = fixture(),
    q = await service.create(f.actor, b.input);
  let stopped = false;
  afterPut = async () => {
    stopped = true;
  };
  await assert.rejects(() =>
    service.apply(f.actor, q.id, apply(), {
      guard: async () => {
        if (stopped) throw new ConflictException("stopped");
      },
    }),
  );
  assert.equal((await service.get(f.actor, q.id)).state, "recovery_required");
  assert.equal((await service.reconcile(f.actor, q.id)).state, "succeeded");
});
test("Office actor and source credential revocation clear sensitive data and gate every read and write", async () => {
  const { input } = fixture(),
    p = await service.create(f.actor, input),
    initial = puts;
  await db.pool.query(
    "UPDATE cw_identity_credentials SET disabled_at=now() WHERE id=$1",
    [f.actor.identityCredentialId],
  );
  await assert.rejects(() => service.get(f.actor, p.id));
  await assert.rejects(() => service.apply(f.actor, p.id, apply()));
  assert.equal(puts, initial);
  assert.equal(
    (
      await db.pool.query(
        "SELECT operations FROM cw_office_proposals WHERE id=$1",
        [p.id],
      )
    ).rows[0].operations,
    null,
  );
  await db.pool.query(
    "UPDATE cw_identity_credentials SET disabled_at=NULL WHERE id=$1",
    [f.actor.identityCredentialId],
  );
  const b = fixture(),
    q = await service.create(f.actor, b.input);
  await db.pool.query(
    "DELETE FROM cw_members WHERE workspace_id=$1 AND user_id=$2",
    [f.actor.workspaceId, f.actor.id],
  );
  await assert.rejects(() => service.get(f.actor, q.id));
  await assert.rejects(() => service.list(f.actor));
  await db.pool.query(
    "INSERT INTO cw_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
    [f.actor.workspaceId, f.actor.id],
  );
});
test("Office changed target readback stays unknown; outdated target read permission hides output", async () => {
  const a = fixture(),
    p = await service.create(f.actor, a.input);
  mode = "change-read";
  assert.equal(
    (await service.apply(f.actor, p.id, apply())).state,
    "recovery_required",
  );
  const b = fixture(),
    q = await service.create(f.actor, b.input),
    result = await service.apply(f.actor, q.id, apply());
  f.source.files.files
    .find((x) => x.id === result.file!.id)!
    .blockedDownloads.add("alice");
  const read = await service.get(f.actor, q.id);
  assert.equal(read.state, "succeeded");
  assert.equal(read.file, null);
});
test("Office SHA binding detects unchanged-ETag corruption before generation and post-generation identity drift", async () => {
  const a = fixture();
  await assert.rejects(
    () =>
      service.create(f.actor, { ...a.input, expectedSha256: "0".repeat(64) }),
    /内容/,
  );
  const p = await service.create(f.actor, a.input),
    initial = puts;
  a.file.content = Buffer.from("Changed while improperly retaining ETag");
  await assert.rejects(() => service.apply(f.actor, p.id, apply()));
  assert.equal(puts, initial);
});
test("Office stale generation can safely retry while stale applying can only reconcile", async () => {
  const a = fixture(),
    p = await service.create(f.actor, a.input);
  await db.pool.query(
    "UPDATE cw_office_proposals SET state='processing',updated_at=now()-interval '3 minutes' WHERE id=$1",
    [p.id],
  );
  const expired = await service.get(f.actor, p.id);
  assert.equal(expired.state, "failed");
  assert.equal(expired.retryable, true);
  const b = fixture(),
    q = await service.create(f.actor, b.input);
  await db.pool.query(
    "UPDATE cw_office_proposals SET state='applying',output_sha256=$2,output_size=1,updated_at=now()-interval '3 minutes' WHERE id=$1",
    [q.id, "0".repeat(64)],
  );
  assert.equal((await service.get(f.actor, q.id)).state, "recovery_required");
  await assert.rejects(() => service.apply(f.actor, q.id, apply()), /状态/);
});

test("Office invalidation clears sibling proposals on the same binding and all private proposals after credential revoke", async () => {
  const a = fixture(),
    first = await service.create(f.actor, a.input),
    sibling = await service.create(f.actor, {
      ...a.input,
      idempotencyKey: randomUUID(),
    });
  const b = fixture(),
    other = await service.create(f.actor, b.input);
  a.file.readers.delete("alice");
  assert.equal(
    (await service.get(f.actor, first.id)).sourceStatus,
    "invalidated",
  );
  assert.equal(
    (
      await db.pool.query(
        "SELECT operations FROM cw_office_proposals WHERE id=$1",
        [sibling.id],
      )
    ).rows[0].operations,
    null,
  );
  assert.ok(
    (
      await db.pool.query(
        "SELECT operations FROM cw_office_proposals WHERE id=$1",
        [other.id],
      )
    ).rows[0].operations,
  );
  await db.pool.query(
    "UPDATE cw_identity_credentials SET disabled_at=now() WHERE id=$1",
    [f.actor.identityCredentialId],
  );
  try {
    await assert.rejects(() => service.list(f.actor));
    assert.equal(
      (
        await db.pool.query(
          "SELECT count(*) FROM cw_office_proposals WHERE workspace_id=$1 AND actor_id=$2 AND operations IS NOT NULL",
          [f.actor.workspaceId, f.actor.id],
        )
      ).rows[0].count,
      "0",
    );
  } finally {
    await db.pool.query(
      "UPDATE cw_identity_credentials SET disabled_at=NULL WHERE id=$1",
      [f.actor.identityCredentialId],
    );
  }
});

test("Office edit rejects a source ETag changing during the final byte read", async () => {
  const { input, file } = fixture(),
    proposal = await service.create(f.actor, input);
  afterTransform = async () => {
    file.afterRead = () => {
      file.etag = '"changed-on-final-read"';
    };
  };
  await assert.rejects(
    () =>
      service.edit(f.actor, proposal.id, {
        expectedRevision: 1,
        operations: input.operations,
        idempotencyKey: randomUUID(),
      }),
    /失效/,
  );
  assert.equal(
    (await service.get(f.actor, proposal.id)).sourceStatus,
    "invalidated",
  );
});
