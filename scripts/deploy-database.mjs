import { Pool } from "pg";

export const RUNTIME_ROLE = "hyper_runtime";
const queueSchema = "hyper_jobs";
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';

/** Administrative initialization only. Never import this into an API or Worker entrypoint. */
export async function configureRuntimeDatabase(
  adminUrl,
  password,
  role = RUNTIME_ROLE,
) {
  if (
    typeof adminUrl !== "string" ||
    !adminUrl ||
    !/^[a-f0-9]{64}$/i.test(password ?? "") ||
    !/^hyper_runtime(?:_[a-f0-9]{12})?$/.test(role)
  )
    throw new Error("Invalid restricted database role configuration.");
  let parsed;
  try {
    parsed = new URL(adminUrl);
  } catch {
    throw new Error("Invalid administrative database URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.username ||
    parsed.pathname.length < 2
  )
    throw new Error("Invalid administrative database URL.");
  const pool = new Pool({
    connectionString: adminUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'",
    );
    await client.query("SELECT pg_advisory_xact_lock(246813583)");
    const {
      rows: [admin],
    } =
      await client.query(`SELECT r.oid, r.rolsuper, current_database() AS database,
      (SELECT oid FROM pg_database WHERE datname=current_database()) AS database_oid
      FROM pg_roles r WHERE rolname=current_user`);
    if (!admin?.rolsuper)
      throw new Error("Administrative database initialization is required.");
    const {
      rows: [scope],
    } = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND NOT starts_with(c.relname,'cw_') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')) AS foreign_tables`);
    if (scope.foreign_tables)
      throw new Error("Use a dedicated product database.");
    const {
      rows: [existing],
    } = await client.query("SELECT * FROM pg_roles WHERE rolname=$1", [role]);
    if (existing) {
      const unsafe =
        existing.rolsuper ||
        existing.rolcreatedb ||
        existing.rolcreaterole ||
        existing.rolreplication ||
        existing.rolbypassrls;
      const {
        rows: [dependencies],
      } = await client.query(
        `SELECT
        EXISTS(SELECT 1 FROM pg_auth_members WHERE member=$1 OR roleid=$1) AS membership,
        EXISTS(SELECT 1 FROM pg_database WHERE datdba=$1) AS database_owner,
        EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND dbid NOT IN (0,$2)) AS other_database,
        EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND dbid=0 AND NOT (classid='pg_database'::regclass AND objid=$2 AND deptype='a')) AS shared_privileges,
        EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND dbid=$2 AND deptype='o' AND classid NOT IN ('pg_class'::regclass,'pg_proc'::regclass,'pg_type'::regclass,'pg_namespace'::regclass,'pg_default_acl'::regclass)) AS other_objects,
        EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=$1 AND nspname<>$3) AS other_schema,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=$1 AND n.nspname<>$3
          AND NOT (n.nspname='pg_toast' AND EXISTS(SELECT 1 FROM pg_class parent JOIN pg_namespace pn ON pn.oid=parent.relnamespace
            LEFT JOIN pg_index i ON i.indexrelid=c.oid WHERE pn.nspname=$3 AND parent.relowner=$1 AND parent.reltoastrelid=COALESCE(i.indrelid,c.oid)))) AS other_relation,
        EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=$1 AND n.nspname<>$3) AS other_routine,
        EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typowner=$1 AND n.nspname<>$3) AS other_type`,
        [existing.oid, admin.database_oid, queueSchema],
      );
      if (unsafe || Object.values(dependencies).some(Boolean))
        throw new Error(
          "Existing runtime role has unexpected privileges or ownership (" +
            (unsafe
              ? "role attributes"
              : Object.keys(dependencies)
                  .filter((key) => dependencies[key])
                  .join(", ")) +
            "); inspect it before initialization.",
        );
    }
    // Input is a fixed-length hexadecimal secret. Do not expose SQL errors containing this statement.
    const {
      rows: [logging],
    } = await client.query(
      "SELECT current_setting('log_statement') AS statement,current_setting('log_min_error_statement') AS error,current_setting('log_parameter_max_length_on_error') AS parameters",
    );
    // Suppress only the password statement, then restore this connection's original logging policy.
    await client.query(
      "SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; SET LOCAL log_parameter_max_length_on_error=0",
    );
    await client.query(
      `${existing ? "ALTER" : "CREATE"} ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${password}'`,
    );
    await client.query(
      "SELECT set_config('log_statement',$1,true),set_config('log_min_error_statement',$2,true),set_config('log_parameter_max_length_on_error',$3,true)",
      [logging.statement, logging.error, logging.parameters],
    );
    await client.query(`ALTER ROLE ${quote(role)} RESET ALL`);
    await client.query(
      `ALTER ROLE ${quote(role)} SET search_path TO pg_catalog, public`,
    );
    const {
      rows: [schema],
    } = await client.query(
      "SELECT nspowner FROM pg_namespace WHERE nspname=$1",
      [queueSchema],
    );
    const {
      rows: [runtime],
    } = await client.query("SELECT oid FROM pg_roles WHERE rolname=$1", [role]);
    if (schema && ![admin.oid, runtime.oid].includes(schema.nspowner))
      throw new Error("Queue schema has an unexpected owner.");
    if (!schema)
      await client.query(
        `CREATE SCHEMA ${quote(queueSchema)} AUTHORIZATION ${quote(role)}`,
      );
    else {
      // Upgrade an existing Compose volume without reassigning any business objects or dropping jobs.
      const { rows: relations } = await client.query(
        `SELECT c.relname,c.relkind,c.relowner FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','S','v','m','f')
        ORDER BY CASE WHEN c.relkind='S' THEN 1 ELSE 0 END,c.relname`,
        [queueSchema],
      );
      const { rows: routines } = await client.query(
        `SELECT p.proname,p.proowner,p.prokind,pg_get_function_identity_arguments(p.oid) AS arguments
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1`,
        [queueSchema],
      );
      const { rows: enums } = await client.query(
        `SELECT t.typname,t.typowner FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname=$1 AND t.typtype='e'`,
        [queueSchema],
      );
      if (
        [
          ...relations.map((r) => r.relowner),
          ...routines.map((r) => r.proowner),
          ...enums.map((t) => t.typowner),
        ].some((owner) => ![admin.oid, runtime.oid].includes(owner))
      )
        throw new Error("Queue objects have an unexpected owner.");
      await client.query(
        `ALTER SCHEMA ${quote(queueSchema)} OWNER TO ${quote(role)}`,
      );
      for (const r of relations) {
        const kind =
          {
            S: "SEQUENCE",
            v: "VIEW",
            m: "MATERIALIZED VIEW",
            f: "FOREIGN TABLE",
          }[r.relkind] ?? "TABLE";
        await client.query(
          `ALTER ${kind} ${quote(queueSchema)}.${quote(r.relname)} OWNER TO ${quote(role)}`,
        );
      }
      for (const t of enums)
        await client.query(
          `ALTER TYPE ${quote(queueSchema)}.${quote(t.typname)} OWNER TO ${quote(role)}`,
        );
      for (const p of routines) {
        if (!["f", "p"].includes(p.prokind))
          throw new Error("Unexpected queue routine kind.");
        await client.query(
          `ALTER ${p.prokind === "p" ? "PROCEDURE" : "FUNCTION"} ${quote(queueSchema)}.${quote(p.proname)}(${p.arguments}) OWNER TO ${quote(role)}`,
        );
      }
    }
    await client.query(
      `REVOKE ALL ON DATABASE ${quote(admin.database)} FROM PUBLIC, ${quote(role)}`,
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${quote(admin.database)} TO ${quote(role)}`,
    );
    await client.query(
      `REVOKE ALL ON SCHEMA public FROM PUBLIC, ${quote(role)}`,
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)}`);
    await client.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, ${quote(role)}`,
    );
    await client.query(
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, ${quote(role)}`,
    );
    const { rows: relations } =
      await client.query(`SELECT relname,relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND (
        (c.relkind IN ('r','p') AND starts_with(c.relname,'cw_'))
        OR (c.relkind='v' AND c.relname='cw_source_bound_assets')
      )`);
    for (const t of relations) {
      const permissions =
        t.relkind === "v" || t.relname === "cw_migrations"
          ? "SELECT"
          : "SELECT, INSERT, UPDATE, DELETE";
      await client.query(
        `GRANT ${permissions} ON TABLE public.${quote(t.relname)} TO ${quote(role)}`,
      );
    }
    const { rows: sequences } =
      await client.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='S' AND starts_with(c.relname,'cw_')`);
    for (const s of sequences)
      await client.query(
        `GRANT USAGE ON SEQUENCE public.${quote(s.relname)} TO ${quote(role)}`,
      );
    await client.query(
      `REVOKE ALL ON SCHEMA ${quote(queueSchema)} FROM PUBLIC`,
    );
    await client.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA ${quote(queueSchema)} FROM PUBLIC`,
    );
    await client.query(
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${quote(queueSchema)} FROM PUBLIC`,
    );
    await client.query(
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${quote(queueSchema)} FROM PUBLIC`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(role)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => {});
    // Do not include a driver error, connection URL, SQL or password in initialization logs.
    if (
      error instanceof Error &&
      error.message.startsWith("Existing runtime role")
    )
      throw error;
    throw new Error(
      "Restricted database initialization failed; inspect role ownership and administrative access without logging credentials.",
    );
  } finally {
    client?.release();
    await pool.end();
  }
}
