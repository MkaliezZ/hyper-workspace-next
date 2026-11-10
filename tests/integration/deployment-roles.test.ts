import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { Database, seedDemo, DEMO } from "../../apps/api/src/db/database.js";
import { configureRuntimeDatabase } from "../../scripts/deploy-database.mjs";

const base = process.env.TEST_DATABASE_URL;
if (!base || !new URL(base).pathname.endsWith("_test"))
  throw new Error("Use an isolated TEST_DATABASE_URL ending in _test.");

async function fixture(t: any, legacy = false) {
  const suffix = randomBytes(6).toString("hex"),
    name = "hyper_roles_" + suffix + "_test",
    role = "hyper_runtime_" + suffix,
    password = randomBytes(32).toString("hex"),
    cluster = new Pool({ connectionString: base, max: 1 });
  const url = new URL(base!);
  url.pathname = "/" + name;
  let db: Database | undefined,
    runtime: Database | undefined,
    boss: PgBoss | undefined;
  t.after(async () => {
    try {
      try {
        if (boss) await boss.stop({ graceful: true, timeout: 3000 });
      } finally {
        await Promise.all([runtime?.close(), db?.close()]);
      }
      // A normal DROP waits for closed sockets to leave the server. FORCE races Pool.end()
      // and can emit an asynchronous 57P01 into a later test; a genuine leak must fail cleanup.
      await cluster.query(`DROP DATABASE IF EXISTS "${name}"`);
      await cluster.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally {
      await cluster.end();
    }
  });
  await cluster.query(`CREATE DATABASE "${name}"`);
  db = new Database(url.toString());
  if (!legacy) await configureRuntimeDatabase(url.toString(), password, role);
  await db.migrate();
  await seedDemo(db);
  let job: string | null = null;
  if (legacy) {
    boss = new PgBoss({
      connectionString: url.toString(),
      schema: "hyper_jobs",
    });
    boss.on("error", () => {});
    await boss.start();
    await boss.createQueue("preserved-work", { retryLimit: 0 });
    job = await boss.send("preserved-work", { marker: "existing-queue-data" });
    await boss.stop();
    boss = undefined;
  }
  await configureRuntimeDatabase(url.toString(), password, role);
  const runtimeUrl = new URL(url);
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  runtime = new Database(runtimeUrl.toString());
  return {
    db,
    runtime,
    role,
    job,
    configure: () => configureRuntimeDatabase(url.toString(), password, role),
    queue: async () => {
      boss = new PgBoss({
        connectionString: runtimeUrl.toString(),
        schema: "hyper_jobs",
        createSchema: false,
      });
      boss.on("error", () => {});
      await boss.start();
      return boss;
    },
  };
}

const denied = async (db: Database, sql: string) => {
  await assert.rejects(db.pool.query(sql), (e: any) => e.code === "42501");
};

test("Restricted deployment role supports product, vector and queue work but cannot administer or alter business storage", async (t) => {
  const f = await fixture(t);
  const {
    rows: [identity],
  } = await f.runtime.pool
    .query(`SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    FROM pg_roles WHERE rolname=current_user`);
  assert.deepEqual(identity, {
    name: f.role,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
  });
  await seedDemo(f.runtime); // Includes a real bigserial message sequence path in this database.
  await f.runtime.pool.query(
    "INSERT INTO cw_messages(id,workspace_id,conversation_id,author,role,content) VALUES(gen_random_uuid(),$1,$2,'fixture','user','restricted-role-message')",
    [DEMO.workspace, DEMO.conversation],
  );
  assert.equal(
    (
      await f.runtime.pool.query(
        "SELECT '[1,2]'::vector <-> '[1,2]'::vector AS distance",
      )
    ).rows[0].distance,
    0,
  );
  await f.runtime.pool.query("SELECT asset_id FROM cw_source_bound_assets");
  const {
    rows: [viewPermissions],
  } = await f.runtime.pool.query(
    "SELECT has_table_privilege(current_user, 'cw_source_bound_assets', 'INSERT,UPDATE,DELETE') AS writable",
  );
  assert.equal(viewPermissions.writable, false);
  const queue = await f.queue();
  await queue.createQueue("restricted-work", { retryLimit: 0 });
  const id = await queue.send("restricted-work", { value: "synthetic" });
  const jobs = await queue.fetch("restricted-work");
  assert.equal(jobs[0]?.id, id);
  await queue.complete("restricted-work", id!);
  const {
    rows: [acl],
  } = await f.runtime.pool
    .query(`SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname='hyper_jobs' AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execution`);
  assert.equal(acl.public_execution, false);
  for (const sql of [
    "CREATE TABLE public.forbidden(value text)",
    "CREATE SCHEMA forbidden",
    "CREATE TEMP TABLE forbidden(value text)",
    "ALTER TABLE cw_workspaces ADD COLUMN forbidden text",
    "DROP TABLE cw_workspaces CASCADE",
    "TRUNCATE cw_migrations",
    "UPDATE cw_migrations SET name=name",
    "SELECT * FROM pg_authid",
    "SELECT pg_read_file('postgresql.conf')",
    `ALTER ROLE "${f.role}" SUPERUSER`,
    "ALTER SYSTEM SET log_statement='all'",
    "SELECT hyper_jobs.job_table_run('DROP TABLE public.cw_users CASCADE', 'ignored')",
  ])
    await denied(f.runtime, sql);
  assert.ok(
    (await f.runtime.pool.query("SELECT name FROM cw_migrations")).rowCount! >
      0,
  );
});

test("Existing administrator-owned queue and product data survive restricted-role adoption and repeated initialization", async (t) => {
  const f = await fixture(t, true);
  const queue = await f.queue();
  const jobs = await queue.fetch<{ marker: string }>("preserved-work");
  assert.equal(jobs[0]?.id, f.job);
  assert.equal(jobs[0]?.data.marker, "existing-queue-data");
  await queue.complete("preserved-work", f.job!);
  const {
    rows: [owner],
  } = await f.db.pool.query(
    `SELECT pg_get_userbyid(relowner) AS name FROM pg_class WHERE oid='public.cw_workspaces'::regclass`,
  );
  assert.notEqual(owner.name, f.role);
  await f.db.pool.query("CREATE TABLE public.cw_deploy_probe(value text)");
  await denied(
    f.runtime,
    "INSERT INTO public.cw_deploy_probe VALUES('before-regrant')",
  );
  await f.configure();
  await f.configure();
  await f.runtime.pool.query(
    "INSERT INTO public.cw_deploy_probe VALUES('after-regrant')",
  );
  assert.equal(
    (await f.runtime.pool.query("SELECT value FROM public.cw_deploy_probe"))
      .rows[0].value,
    "after-regrant",
  );
  assert.equal(
    (
      await f.runtime.pool.query("SELECT name FROM cw_workspaces WHERE id=$1", [
        DEMO.workspace,
      ])
    ).rows[0].name,
    "演示工作区",
  );
  await denied(f.runtime, "UPDATE cw_migrations SET name=name");
  const { rows: functions } = await f.db.pool.query(
    `SELECT proowner=(SELECT oid FROM pg_roles WHERE rolname=$1) AS owned
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hyper_jobs'`,
    [f.role],
  );
  assert.ok(functions.length > 0 && functions.every((f) => f.owned));
});

test("Previously privileged runtime roles fail initialization without silently accepting or resetting their authority", async (t) => {
  const f = await fixture(t);
  await f.db.pool.query(`ALTER ROLE "${f.role}" CREATEROLE`);
  await assert.rejects(f.configure(), /Existing runtime role/);
  assert.equal(
    (
      await f.db.pool.query(
        "SELECT rolcreaterole FROM pg_roles WHERE rolname=$1",
        [f.role],
      )
    ).rows[0].rolcreaterole,
    true,
  );
  await f.db.pool.query(`ALTER ROLE "${f.role}" NOCREATEROLE`);
  await f.db.pool.query(`GRANT pg_monitor TO "${f.role}"`);
  try {
    await assert.rejects(f.configure(), /Existing runtime role/);
  } finally {
    await f.db.pool.query(`REVOKE pg_monitor FROM "${f.role}"`);
  }
  await f.db.pool.query(
    `GRANT ALTER SYSTEM ON PARAMETER log_statement TO "${f.role}"`,
  );
  try {
    await assert.rejects(f.configure(), /Existing runtime role/);
  } finally {
    await f.db.pool.query(
      `REVOKE ALTER SYSTEM ON PARAMETER log_statement FROM "${f.role}"`,
    );
  }
  await f.db.pool.query("CREATE TABLE unrelated_company_data(value text)");
  try {
    await assert.rejects(
      f.configure(),
      /Restricted database initialization failed/,
    );
    assert.equal(
      (await f.db.pool.query("SELECT count(*) FROM unrelated_company_data"))
        .rows[0].count,
      "0",
    );
  } finally {
    await f.db.pool.query("DROP TABLE unrelated_company_data");
  }
  await f.configure();
});
