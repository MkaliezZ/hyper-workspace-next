import { OrganizationBudgetService } from "../../apps/api/src/core/organization-budgets.js";
import { ModelAccounting } from "../../apps/api/src/core/model-usage.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { Database, seedDemo, DEMO } from "../../apps/api/src/db/database.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
import {
  createWorkspaceBackup,
  verifyWorkspaceBackup,
  restoreWorkspaceBackup,
  localTransport,
  containerTransport,
} from "../../scripts/workspace-backup.mjs";

const base = process.env.TEST_DATABASE_URL;
if (!base || !new URL(base).pathname.endsWith("_test"))
  throw Error("Use isolated _test database.");
async function fixture(t: any) {
  const source = "hyper_backup_" + randomBytes(6).toString("hex") + "_test",
    cluster = new Pool({ connectionString: base, max: 1 }),
    dir = await mkdtemp(join(tmpdir(), "hyper-backup-check-")),
    key = randomBytes(32).toString("hex");
  await cluster.query(`CREATE DATABASE "${source}"`);
  const url = new URL(base!);
  url.pathname = "/" + source;
  const db = new Database(url.href),
    restores: string[] = [];
  t.after(async () => {
    try {
      await db.close();
      const own = new Set(restores);
      for (const name of ["restore.json", "wrong.json", "corrupt.json"]) {
        try {
          const report = JSON.parse(await readFile(join(dir, name), "utf8"));
          if (/^hyper_restore_[a-f0-9]{16}$/.test(report.database ?? ""))
            own.add(report.database);
        } catch (e: any) {
          if (e.code !== "ENOENT") throw e;
        }
      }
      for (const name of own) await cluster.query(`DROP DATABASE "${name}"`);
      await cluster.query(`DROP DATABASE "${source}"`);
    } finally {
      await cluster.end();
      await rm(dir, { recursive: true, force: true });
    }
  });
  await db.migrate();
  await seedDemo(db);
  const profile = randomUUID(),
    run = randomUUID(),
    identity = randomUUID(),
    credential = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_model_profiles(id,workspace_id,owner_id,name,provider,endpoint,model,purpose,credential_enc)VALUES($1,$2,$3,'Synthetic archive profile','openai-compatible','https://synthetic.invalid','synthetic','chat',$4)",
    [
      profile,
      DEMO.workspace,
      DEMO.user,
      new Vault(key).encrypt("synthetic-only-model-key"),
    ],
  );
  await db.pool.query(
    "INSERT INTO cw_external_identities(id,provider_key,remote_uid,user_id,workspace_id)VALUES($1,'synthetic-backup','synthetic-owner',$2,$3)",
    [identity, DEMO.user, DEMO.workspace],
  );
  await db.pool.query(
    "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc)VALUES($1,$2,'synthetic-owner',$3)",
    [credential, identity, new Vault(key).encrypt("synthetic-device-secret")],
  );
  await db.pool.query(
    "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,input_hash,demo,state)VALUES($1,$2,$3,$4,'fixture','follow_up','Synthetic interrupted check',$5,'synthetic-hash',true,'running')",
    [run, DEMO.workspace, DEMO.user, DEMO.conversation, randomUUID()],
  );
  await db.pool.query(
    "INSERT INTO cw_follow_up_schedules(id,workspace_id,project_id,conversation_id,actor_id,demo,engine,interval_minutes,max_checks,next_check_at,idempotency_key,input_hash)VALUES($1,$2,$3,$4,$5,true,'fixture',15,2,clock_timestamp(),$6,'synthetic-hash')",
    [
      randomUUID(),
      DEMO.workspace,
      DEMO.project,
      DEMO.conversation,
      DEMO.user,
      randomUUID(),
    ],
  );
  await db.pool.query(
    "INSERT INTO cw_sessions(token_hash,user_id,workspace_id,expires_at)VALUES('synthetic-session',$1,$2,now()+interval '1 day')",
    [DEMO.user, DEMO.workspace],
  );
  await db.pool.query(
    "INSERT INTO cw_login_flows(id,binding_hash,provider_key,workspace_id)VALUES($1,'synthetic-binding','synthetic-backup',$2)",
    [randomUUID(), DEMO.workspace],
  );
  const asset = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_assets(id,workspace_id,project_id,owner_id,title,content,type,source_version,embedding)VALUES($1,$2,$3,$4,'Synthetic archived document','synthetic stable document','text','7','[1,0.2]'::vector)",
    [asset, DEMO.workspace, DEMO.project, DEMO.user],
  );
  const commandId = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_room_commands(id,workspace_id,actor_id,identity_credential_id,provider_key,binding_ref,remote_uid,operation,plan,params_hash,idempotency_key,state)VALUES($1,$2,$3,$4,'synthetic-backup',$5,'synthetic-owner','notify',$6,'synthetic-hash',$7,'dispatching')",
    [
      commandId,
      DEMO.workspace,
      DEMO.user,
      credential,
      "a".repeat(64),
      { operation: "notify", level: 3 },
      randomUUID(),
    ],
  );
  await db.pool.query(
    "INSERT INTO cw_room_command_steps(command_id,sequence,operation,state)VALUES($1,0,'notify','dispatching')",
    [commandId],
  );
  await db.pool.query(
    "INSERT INTO cw_communication_sends(id,workspace_id,actor_id,identity_credential_id,provider_key,conversation_ref,idempotency_key,params_hash,reference_id,state)VALUES($1,$2,$3,$4,'synthetic-backup','syntheticroom',$5,'synthetic-hash',$6,'sending')",
    [
      randomUUID(),
      DEMO.workspace,
      DEMO.user,
      credential,
      randomUUID(),
      randomUUID(),
    ],
  );
  await db.pool.query(
    "INSERT INTO cw_attachment_sends(id,workspace_id,actor_id,identity_credential_id,provider_key,source_actor_id,conversation_ref,idempotency_key,params_hash,plan,file_name,reference_id,state)VALUES($1,$2,$3,$4,'synthetic-backup','synthetic-owner','syntheticroom',$5,'synthetic-hash','{}','synthetic.txt',$6,'sending')",
    [
      randomUUID(),
      DEMO.workspace,
      DEMO.user,
      credential,
      randomUUID(),
      randomUUID(),
    ],
  );
  await db.pool.query(
    "INSERT INTO cw_attachment_uploads(id,workspace_id,actor_id,identity_credential_id,provider_key,source_actor_id,conversation_ref,idempotency_key,params_hash,file_name,source_path,byte_size,sha256,state)VALUES($1,$2,$3,$4,'synthetic-backup','synthetic-owner','syntheticroom',$5,'synthetic-hash','synthetic.txt',$6,3,$7,'prepared')",
    [
      randomUUID(),
      DEMO.workspace,
      DEMO.user,
      credential,
      randomUUID(),
      JSON.stringify(["synthetic.txt"]),
      "a".repeat(64),
    ],
  );
  for (const state of ["prepared", "applying"]) {
    const id = randomUUID();
    await db.pool.query(
      "INSERT INTO cw_calendar_commands(id,workspace_id,actor_id,identity_credential_id,provider_key,source_actor_id,calendar_id,object_id,source_uid,operation,idempotency_key,params_hash,plan,title,expected_etag,state,attempted_at)VALUES($1,$2,$3,$4,'synthetic-backup','synthetic-owner','personal',$5,'synthetic-calendar-uid','delete',$6,'synthetic-hash',$7,'Synthetic calendar backup intent',$8,$9,now())",
      [
        id,
        DEMO.workspace,
        DEMO.user,
        credential,
        id + ".ics",
        randomUUID(),
        {
          operation: "delete",
          calendarId: "personal",
          objectId: id + ".ics",
          etag: '"v1"',
          scope: "series",
          idempotencyKey: randomUUID(),
        },
        '"v1"',
        state,
      ],
    );
  }
  const company = new OrganizationBudgetService(db),
    subject = {
      id: DEMO.user,
      workspaceId: DEMO.workspace,
      name: "Synthetic archive finance admin",
      role: "admin" as const,
      demo: true,
    };
  await company.save(
    subject,
    {
      operation: "budget_price",
      provider: "openai-compatible",
      endpoint: "https://synthetic.invalid",
      model: "synthetic",
      purpose: "chat",
      expectedRevision: 0,
      currency: "USD",
      inputPerMillion: "1",
      outputPerMillion: "1",
      cacheReadPerMillion: "1",
      cacheWritePerMillion: "1",
      source: "Synthetic archive company declaration",
      confirmed: true,
    },
    randomUUID(),
  );
  await company.save(
    subject,
    {
      operation: "budget_configure",
      scope: "workspace",
      projectId: null,
      expectedRevision: 0,
      currency: "USD",
      dailyLimit: "1",
      requestReservation: "0.01",
      confirmed: true,
    },
    randomUUID(),
  );
  const accounting = new ModelAccounting(db, subject, {
    id: profile,
    provider: "openai-compatible",
    endpoint: "https://synthetic.invalid",
    model: "synthetic",
    purpose: "chat",
  });
  const companyUnknown = await accounting.begin("verification"),
    companyDeclared = await accounting.begin("verification");
  await accounting.settle(
    companyDeclared,
    {
      status: "reported",
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    "completed",
    200,
  );
  await company.save(
    subject,
    {
      operation: "budget_reconcile",
      requestId: companyDeclared,
      expectedRevision: 0,
      currency: "USD",
      amount: "0.003",
      evidence:
        "Synthetic explicit admin amount for archive verification, not an invoice",
      confirmed: true,
    },
    randomUUID(),
  );
  const boss = new PgBoss({ connectionString: url.href, schema: "hyper_jobs" });
  boss.on("error", () => {});
  await boss.start();
  await boss.createQueue("never-replay-restored");
  await boss.send("never-replay-restored", { runId: run });
  await boss.stop();
  const transport = process.env.BACKUP_TEST_CONTAINER
    ? containerTransport({
        container: process.env.BACKUP_TEST_CONTAINER,
        database: source,
      })
    : localTransport(url.href, { binDir: process.env.TEST_PG_BIN_DIR });
  return {
    db,
    cluster,
    dir,
    key,
    profile,
    companyUnknown,
    companyDeclared,
    asset,
    run,
    transport,
    restores,
    url,
  };
}
test("A real PostgreSQL archive restores stable assets, vectors, encrypted credentials and receipts while quarantining automatic work", async (t) => {
  const f = await fixture(t),
    directory = join(f.dir, "backup");
  const created = await createWorkspaceBackup(f.transport, directory, f.key);
  assert.equal(created.credentialChecks, 2);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(directory, "workspace.dump"))).mode & 0o777,
    0o600,
  );
  const original = (
    await f.db.pool.query(
      "SELECT id,content,source_version,embedding::text FROM cw_assets WHERE id=$1",
      [f.asset],
    )
  ).rows[0];
  const report = await restoreWorkspaceBackup(
    f.transport,
    directory,
    f.key,
    join(f.dir, "restore.json"),
  );
  f.restores.push(report.database);
  assert.equal(report.status, "verified_isolated");
  assert.equal(report.servicesStarted, false);
  assert.equal(report.credentialChecks, 2);
  assert.equal(report.quarantine.recoveryRuns, 1);
  assert.equal(report.quarantine.activeCalendarCommands, 0);
  assert.equal(report.quarantine.queueAbsent, true);
  assert.equal(report.quarantine.reviewModelRequests, 1);
  assert.equal(report.quarantine.reviewCompanyCharges, 1);
  const url = new URL(f.url);
  url.pathname = "/" + report.database;
  const restored = new Pool({ connectionString: url.href, max: 1 });
  try {
    const preserved = (
      await restored.query(
        "SELECT request_id,status,estimated_picos::text,declared_picos::text,workspace_reserved::text,review_required FROM cw_budget_charges ORDER BY request_id",
      )
    ).rows;
    const unknown = preserved.find((x) => x.request_id === f.companyUnknown),
      declared = preserved.find((x) => x.request_id === f.companyDeclared);
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.workspace_reserved, "10000000000");
    assert.equal(unknown.review_required, true);
    const restoredDb = new Database(url.href);
    try {
      const accounting = new ModelAccounting(
        restoredDb,
        {
          id: DEMO.user,
          workspaceId: DEMO.workspace,
          name: "Synthetic restored admin",
          role: "admin",
          demo: true,
        },
        {
          id: f.profile,
          provider: "openai-compatible",
          endpoint: "https://synthetic.invalid",
          model: "synthetic",
          purpose: "chat",
        },
      );
      await assert.rejects(accounting.begin("verification"), /未知、待核对/);
      assert.equal(
        (await restored.query("SELECT count(*)::int n FROM cw_model_requests"))
          .rows[0].n,
        2,
      );
    } finally {
      await restoredDb.close();
    }

    assert.equal(declared.status, "declared");
    assert.equal(declared.estimated_picos, "2000000000");
    assert.equal(declared.declared_picos, "3000000000");
    assert.equal(declared.review_required, false);
    assert.equal(
      (
        await f.db.pool.query(
          "SELECT review_required FROM cw_budget_charges WHERE request_id=$1",
          [f.companyUnknown],
        )
      ).rows[0].review_required,
      false,
    );
    for (const table of [
      "cw_room_commands",
      "cw_communication_sends",
      "cw_attachment_sends",
      "cw_attachment_uploads",
      "cw_calendar_commands",
    ]) {
      assert.equal(
        (await restored.query(`SELECT state FROM ${table}`)).rows[0].state,
        "recovery_required",
      );
    }
    assert.equal(
      (await restored.query("SELECT state FROM cw_room_command_steps")).rows[0]
        .state,
      "unknown",
    );
    assert.deepEqual(
      (
        await restored.query(
          "SELECT id,content,source_version,embedding::text FROM cw_assets WHERE id=$1",
          [f.asset],
        )
      ).rows[0],
      original,
    );
    assert.equal(
      (await restored.query("SELECT state FROM cw_runs WHERE id=$1", [f.run]))
        .rows[0].state,
      "recovery_required",
    );
    assert.equal(
      (await restored.query("SELECT state,version FROM cw_follow_up_schedules"))
        .rows[0].state,
      "paused",
    );
    assert.equal(
      (await restored.query("SELECT version FROM cw_follow_up_schedules"))
        .rows[0].version,
      2,
    );
    assert.equal(
      (await restored.query("SELECT count(*)::int AS n FROM cw_sessions"))
        .rows[0].n,
      0,
    );
    assert.equal(
      (await restored.query("SELECT count(*)::int AS n FROM cw_login_flows"))
        .rows[0].n,
      0,
    );
    const profile = (
      await restored.query(
        "SELECT credential_enc FROM cw_model_profiles WHERE id=$1",
        [f.profile],
      )
    ).rows[0];
    assert.equal(
      new Vault(f.key).decrypt(profile.credential_enc),
      "synthetic-only-model-key",
    );
    assert.equal(
      (
        await restored.query(
          "SELECT data->>'backupId' AS id FROM cw_run_events WHERE run_id=$1",
          [f.run],
        )
      ).rows[0].id,
      created.backupId,
    );
  } finally {
    await restored.end();
  }
  assert.equal(
    (await f.db.pool.query("SELECT state FROM cw_runs WHERE id=$1", [f.run]))
      .rows[0].state,
    "running",
  );
  assert.equal(
    (await f.db.pool.query("SELECT state,version FROM cw_follow_up_schedules"))
      .rows[0].state,
    "active",
  );
  assert.equal(
    (await f.db.pool.query("SELECT count(*)::int AS n FROM cw_sessions"))
      .rows[0].n,
    1,
  );
});
test("Wrong keys and corrupted signed archives are rejected before any restore database or command is created", async (t) => {
  const f = await fixture(t),
    directory = join(f.dir, "backup");
  await createWorkspaceBackup(f.transport, directory, f.key);
  let calls = 0;
  const never = {
    ...f.transport,
    run: async () => {
      calls++;
      throw Error("must not connect");
    },
  };
  await assert.rejects(
    restoreWorkspaceBackup(
      never,
      directory,
      "00".repeat(32),
      join(f.dir, "wrong.json"),
    ),
    /签名或主密钥/,
  );
  assert.equal(calls, 0);
  const archive = join(directory, "workspace.dump"),
    bytes = await readFile(archive);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(archive, bytes, { mode: 0o600 });
  await assert.rejects(
    restoreWorkspaceBackup(
      never,
      directory,
      f.key,
      join(f.dir, "corrupt.json"),
    ),
    /归档损坏/,
  );
  assert.equal(calls, 0);
});
test("Source key mismatch, unrelated application tables, and existing output paths cannot produce a success manifest", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    createWorkspaceBackup(
      f.transport,
      join(f.dir, "wrong-key"),
      "00".repeat(32),
    ),
    /不能解密/,
  );
  await createWorkspaceBackup(f.transport, join(f.dir, "backup"), f.key);
  const original = await readFile(
    join(f.dir, "backup", "manifest.json"),
    "utf8",
  );
  await assert.rejects(
    createWorkspaceBackup(f.transport, join(f.dir, "backup"), f.key),
    /不会覆盖/,
  );
  assert.equal(
    await readFile(join(f.dir, "backup", "manifest.json"), "utf8"),
    original,
  );
  await f.db.pool.query("CREATE TABLE unrelated_business_data(id int)");
  await assert.rejects(
    createWorkspaceBackup(f.transport, join(f.dir, "foreign"), f.key),
    /专用/,
  );
  const manifest = await verifyWorkspaceBackup(join(f.dir, "backup"), f.key);
  assert.equal(manifest.queueIncluded, false);
});
