import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { issueSession } from "../../apps/api/src/core/security.js";
import type { Subject } from "@hyper/contracts";
import { CalendarCommandInput } from "@hyper/contracts/calendar";
import { Database } from "../../apps/api/src/db/database.js";
import { CalendarService } from "../../apps/api/src/core/calendar.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
import { requireNextcloud } from "../../apps/api/src/providers/nextcloud.js";
import { CalDavFixture } from "../fixtures/caldav.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Isolated _test database required");
const db = new Database(url),
  service = new CalendarService(db),
  fixture = new CalDavFixture(),
  workspaceId = randomUUID();
const subjects = new Map<string, Subject>();
const server = createServer((req, res) => {
  fixture.handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
  process.env.NEXTCLOUD_CALENDAR_ENABLED = "true";
  process.env.NEXTCLOUD_URL =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  delete process.env.NEXTCLOUD_INTERNAL_URL;
  process.env.NEXTCLOUD_WORKSPACE_ID = workspaceId;
  process.env.NEXTCLOUD_MEMBER_GROUP = "members";
  process.env.NEXTCLOUD_BOOTSTRAP_ADMIN_IDS = "[]";
  await db.migrate();
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Calendar protocol fixture')",
    [workspaceId],
  );
  for (const uid of ["alice", "bob", "revoked"]) {
    const id = randomUUID(),
      identityId = randomUUID(),
      credentialId = randomUUID(),
      password = "synthetic-" + randomUUID();
    fixture.add(uid, password);
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      id,
      uid,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
      [workspaceId, id],
    );
    await db.pool.query(
      "INSERT INTO cw_external_identities(id,provider_key,remote_uid,user_id,workspace_id)VALUES($1,$2,$3,$4,$5)",
      [identityId, requireNextcloud().providerKey, uid, id, workspaceId],
    );
    await db.pool.query(
      "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc)VALUES($1,$2,$3,$4)",
      [credentialId, identityId, uid, new Vault().encrypt(password)],
    );
    subjects.set(uid, {
      id,
      name: uid,
      workspaceId,
      role: "member",
      demo: false,
      identityCredentialId: credentialId,
    });
  }
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});
const actor = (uid = "alice") => subjects.get(uid)!;
function create() {
  fixture.mode = "ok";
  return CalendarCommandInput.parse({
    operation: "create",
    calendarId: "personal",
    idempotencyKey: randomUUID(),
    draft: {
      title: "合成日历验收",
      description: "保持版本与回执",
      location: "会议室 A",
      interval: {
        kind: "timed",
        start: "2026-11-04T01:00:00Z",
        end: "2026-11-04T02:00:00Z",
      },
    },
  });
}

test("Calendar preparation is private and idempotent; concurrent apply performs one conditional source write and readback", async () => {
  const input = create(),
    before = fixture.writes;
  const [a, b] = await Promise.all([
    service.prepare(actor(), input),
    service.prepare(actor(), input),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.state, "prepared");
  assert.equal(fixture.writes, before);
  await assert.rejects(
    service.prepare(actor(), {
      ...input,
      draft: { ...input.draft, title: "另一个目标" },
    }),
    /同一日历操作键/,
  );
  await assert.rejects(service.get(actor("bob"), a.id), /不存在/);
  await Promise.all([
    service.apply(actor(), a.id),
    service.apply(actor(), a.id),
  ]);
  const receipt = await service.get(actor(), a.id);
  assert.equal(fixture.writes, before + 1);
  assert.equal(receipt.state, "succeeded");
  assert.equal(receipt.observedResult, "matched");
  assert.ok(receipt.sourceEtag);
  assert.equal((await service.apply(actor(), a.id)).state, "succeeded");
  assert.equal(fixture.writes, before + 1);
  assert.equal((await service.history(actor("bob"))).length, 0);
});

test("Calendar update preserves unedited properties and rejects stale ETags; delete confirms absence", async () => {
  const input = create();
  const created = await service.apply(
    actor(),
    (await service.prepare(actor(), input)).id,
  );
  const edit = await service.prepare(actor(), {
    operation: "update",
    calendarId: "personal",
    objectId: created.objectId,
    etag: created.sourceEtag,
    scope: "series",
    patch: { title: "新标题" },
    idempotencyKey: randomUUID(),
  });
  const updated = await service.apply(actor(), edit.id);
  assert.equal(updated.state, "succeeded");
  const object = fixture.objects.get("alice/personal/" + created.objectId)!;
  assert.match(object.ical, /DESCRIPTION:保持版本与回执/);
  assert.match(object.ical, /LOCATION:会议室 A/);
  await assert.rejects(
    service.prepare(actor(), {
      operation: "delete",
      calendarId: "personal",
      objectId: created.objectId,
      etag: created.sourceEtag,
      scope: "series",
      idempotencyKey: randomUUID(),
    }),
    /日程已更新/,
  );
  const deleted = await service.apply(
    actor(),
    (
      await service.prepare(actor(), {
        operation: "delete",
        calendarId: "personal",
        objectId: created.objectId,
        etag: updated.sourceEtag,
        scope: "series",
        idempotencyKey: randomUUID(),
      })
    ).id,
  );
  assert.equal(deleted.state, "succeeded");
  assert.equal(deleted.observedResult, "absent");
  assert.equal(
    fixture.objects.has("alice/personal/" + created.objectId),
    false,
  );
});

test("Calendar response loss reconciles a completed source write, while an unobserved write is never replayed", async () => {
  const sent = await service.prepare(actor(), create());
  fixture.mode = "drop-after";
  const before = fixture.writes;
  const observed = await service.apply(actor(), sent.id);
  assert.equal(observed.state, "succeeded");
  assert.equal(fixture.writes, before + 1);
  fixture.mode = "ok";
  const missing = await service.prepare(actor(), create());
  fixture.mode = "drop-before";
  assert.equal(
    (await service.apply(actor(), missing.id)).state,
    "recovery_required",
  );
  fixture.mode = "ok";
  assert.equal(
    (await service.reconcile(actor(), missing.id)).state,
    "recovery_required",
  );
  assert.equal(
    (await service.apply(actor(), missing.id)).state,
    "recovery_required",
  );
  assert.equal(fixture.writes, before + 2);
});

test("Calendar post-write mismatch stays recovery_required, and conditional conflicts do not overwrite source changes", async () => {
  const command = await service.prepare(actor(), create());
  fixture.mode = "tamper";
  assert.equal(
    (await service.apply(actor(), command.id)).state,
    "recovery_required",
  );
  fixture.mode = "ok";
  const input = create();
  const saved = await service.apply(
    actor(),
    (await service.prepare(actor(), input)).id,
  );
  const edit = await service.prepare(actor(), {
    operation: "update",
    calendarId: "personal",
    objectId: saved.objectId,
    etag: saved.sourceEtag,
    scope: "series",
    patch: { title: "尝试覆盖" },
    idempotencyKey: randomUUID(),
  });
  const object = fixture.objects.get("alice/personal/" + saved.objectId)!;
  object.version++;
  object.ical = object.ical.replace("合成日历验收", "同事修改");
  const result = await service.apply(actor(), edit.id);
  assert.equal(result.state, "failed");
  assert.equal(result.error, "calendar_version_conflict");
  assert.match(object.ical, /同事修改/);
});

test("Calendar cancellation before sending prevents effects; stopping an in-flight action preserves the observed effect", async () => {
  const command = await service.prepare(actor(), create()),
    before = fixture.writes;
  assert.equal((await service.cancel(actor(), command.id)).state, "cancelled");
  assert.equal((await service.apply(actor(), command.id)).state, "cancelled");
  assert.equal(fixture.writes, before);
  const active = await service.prepare(actor(), create());
  fixture.afterWrite = async () => {
    await service.cancel(actor(), active.id);
  };
  const saved = await service.apply(actor(), active.id);
  assert.equal(saved.state, "succeeded");
  assert.equal(saved.stopRequested, true);
  assert.equal(fixture.writes, before + 1);
});

test("Calendar source read-only/revocation and member changes are enforced before writes and after reads", async () => {
  const subject = actor("revoked"),
    command = await service.prepare(subject, create()),
    before = fixture.writes;
  fixture.people.get("revoked")!.write = false;
  await assert.rejects(service.apply(subject, command.id), /操作权限/);
  assert.equal(fixture.writes, before);
  fixture.people.get("revoked")!.write = true;
  const saved = await service.apply(subject, command.id);
  assert.equal(saved.state, "succeeded");
  fixture.afterRead = async () => {
    fixture.people.get("revoked")!.read = false;
  };
  // Force readback, then remove permission while response content is still in flight.
  const edit = await service
    .prepare(subject, {
      operation: "update",
      calendarId: "personal",
      objectId: saved.objectId,
      etag: saved.sourceEtag,
      scope: "series",
      patch: { title: "撤权过程中" },
      idempotencyKey: randomUUID(),
    })
    .catch((error) => error);
  assert.ok(edit instanceof Error);
  fixture.people.get("revoked")!.read = true;
  fixture.people.get("revoked")!.member = false;
  await assert.rejects(service.history(subject), /撤销/);
  assert.equal(fixture.writes, before + 1);
});

test("Calendar HTTP endpoints authenticate actor scope, reject invented identities and require concrete write confirmation", async () => {
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const origin = "http://127.0.0.1:" + port;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/main.ts"],
    {
      cwd: new URL("../../apps/api/",import.meta.url),
      env: {
        ...process.env,
        DATABASE_URL: url,
        APP_ORIGIN: origin,
        API_PORT: String(port),
        API_HOST: "127.0.0.1",
        SERVE_WEB: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = (await fetch(origin + "/api/health")).ok;
      } catch {}
      if (ready) break;
      await delay(100);
    }
    assert.equal(ready, true, "Calendar HTTP API did not start");
    const token = await issueSession(
      db,
      actor().id,
      workspaceId,
      false,
      actor().identityCredentialId,
    );
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Origin: origin,
    };
    assert.equal((await fetch(origin + "/api/calendar/calendars")).status, 401);
    assert.equal(
      (await fetch(origin + "/api/calendar/calendars", { headers })).status,
      200,
    );
    const input = create(),
      before = fixture.writes;
    assert.equal(
      (
        await fetch(origin + "/api/calendar/commands", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...input, actorId: actor("bob").id }),
        })
      ).status,
      400,
    );
    const prepared = await fetch(origin + "/api/calendar/commands", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(prepared.status, 201);
    const receipt = await prepared.json();
    assert.equal(
      (
        await fetch(
          origin + "/api/calendar/commands/" + receipt.id + "/apply",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ confirmed: false }),
          },
        )
      ).status,
      400,
    );
    assert.equal(fixture.writes, before);
    const applied = await fetch(
      origin + "/api/calendar/commands/" + receipt.id + "/apply",
      { method: "POST", headers, body: JSON.stringify({ confirmed: true }) },
    );
    assert.equal(applied.status, 201);
    assert.equal((await applied.json()).state, "succeeded");
    assert.equal(fixture.writes, before + 1);
    const bob = await issueSession(
      db,
      actor("bob").id,
      workspaceId,
      false,
      actor("bob").identityCredentialId,
    );
    assert.equal(
      (
        await fetch(origin + "/api/calendar/commands/" + receipt.id, {
          headers: { Authorization: "Bearer " + bob },
        })
      ).status,
      404,
    );
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
  }
});
