import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  copyFile,
  rm,
  open,
  readFile,
  readdir,
  lstat,
} from "node:fs/promises";
import {
  createHash,
  createHmac,
  hkdfSync,
  createDecipheriv,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { resolve, join, basename, relative, sep, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const FORMAT = "hyper-workspace.database-backup.v1",
  ARCHIVE = "workspace.dump";
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    x && !Array.isArray(x) && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
export class BackupError extends Error {}
const fail = (message) => {
  throw new BackupError(message);
};
function privateDestination(path) {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    part = relative(root, resolve(path));
  const outside =
    part === ".." || part.startsWith(".." + sep) || isAbsolute(part);
  if (
    !outside &&
    ![".runtime", ".data"].some(
      (name) => part === name || part.startsWith(name + sep),
    )
  )
    fail(
      "备份和恢复报告需放在仓库外的私有目录，或已忽略的 .runtime / .data 内。",
    );
}
function keyBytes(key) {
  if (!/^[a-f0-9]{64}$/i.test(key ?? ""))
    fail("需要既有的 64 位十六进制凭据主密钥；不要生成新密钥替代。");
  return Buffer.from(key, "hex");
}
function sign(value, key) {
  const derived = Buffer.from(
    hkdfSync("sha256", key, "Hyper Workspace", value.format, 32),
  );
  try {
    return createHmac("sha256", derived).update(canonical(value)).digest("hex");
  } finally {
    derived.fill(0);
  }
}
async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}
async function privateFile(path, directory = false) {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    fail("备份路径必须是普通私有文件或目录，不能使用符号链接。");
  if (process.platform !== "win32" && stat.mode & 0o077)
    fail("备份目录或文件可被其他账号读取，请先在受控环境检查权限。");
  return stat;
}
async function writeReport(handle, value, key) {
  const data = Buffer.from(
    JSON.stringify({ ...value, proof: sign(value, key) }, null, 2) + "\n",
  );
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.length - offset,
      offset,
    );
    if (!bytesWritten) throw new BackupError("备份报告未完整写入。");
    offset += bytesWritten;
  }
  await handle.truncate(data.length);
  await handle.sync();
}
async function signedWrite(path, value, key) {
  const handle = await open(path, "wx", 0o600);
  try {
    await writeReport(handle, value, key);
  } finally {
    await handle.close();
  }
}

// Only PG client processes are launched. SQL output/diagnostics never enter user-facing errors.
async function command(commandName, args, options = {}) {
  let input, output;
  try {
    if (options.input) input = await open(options.input, "r");
    if (options.output) output = await open(options.output, "wx", 0o600);
    return await new Promise((resolveResult, reject) => {
      const child = spawn(commandName, args, {
        env: options.env,
        stdio: [input?.fd ?? "ignore", output?.fd ?? "pipe", "pipe"],
      });
      let stdout = "",
        diagnostics = 0,
        stopped = false,
        killTimer;
      const stop = () => {
        stopped = true;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
        killTimer.unref();
      };
      const timer = setTimeout(stop, options.timeoutMs ?? 30 * 60 * 1000);
      timer.unref();
      options.signal?.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted) stop();
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) stop();
      });
      child.stderr.on("data", (chunk) => {
        diagnostics += chunk.length;
        if (diagnostics > 16384) stop();
      });
      const finish = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", stop);
      };
      child.on("error", () => {
        finish();
        reject(
          new BackupError(
            "无法启动所需 PostgreSQL/Docker 工具，请核对安装和私有配置。",
          ),
        );
      });
      child.on("close", (code) => {
        finish();
        if (stopped || code !== 0 || diagnostics)
          reject(
            new BackupError(
              stopped
                ? "备份或恢复检查已停止；未把不完整结果当作成功。"
                : `PostgreSQL/Docker ${basename(commandName)} 步骤未无误完成（exit ${code}，诊断 ${diagnostics} 字节）；请在受控环境核对，诊断正文未输出。`,
            ),
          );
        else resolveResult(stdout);
      });
    });
  } finally {
    await input?.close();
    if (output) {
      try {
        await output.sync();
      } finally {
        await output.close();
      }
    }
  }
}

function pgArgs(name, args, user) {
  if (!["pg_dump", "pg_restore", "psql", "createdb"].includes(name))
    fail("只允许备份和新建隔离库所需的 PostgreSQL 客户端。");
  return args[0] === "--version"
    ? args
    : [...(user ? ["--username=" + user] : []), "--no-password", ...args];
}
export function localTransport(url, { binDir = "", signal, timeoutMs } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("请通过私有环境变量提供 PostgreSQL 管理连接。");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.username ||
    parsed.pathname.length < 2
  )
    fail("PostgreSQL 管理连接无效。");
  if (
    !/^[a-zA-Z_][a-zA-Z0-9_$-]{0,62}$/.test(
      decodeURIComponent(parsed.pathname.slice(1)),
    )
  )
    fail("请选择单个明确的产品数据库名称。");
  const env = {
    PATH: process.env.PATH,
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGHOST: parsed.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: parsed.port || "5432",
    PGCONNECT_TIMEOUT: "10",
    PGCLIENTENCODING: "UTF8",
  };
  const allowed = {
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
  };
  for (const name of Object.values(allowed)) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [name, value] of parsed.searchParams) {
    if (!allowed[name])
      fail("连接选项尚未支持；请使用明确的 PostgreSQL/TLS 配置。");
    env[allowed[name]] = value;
  }
  const run = (name, args, options = {}) =>
    command(binDir ? join(resolve(binDir), name) : name, pgArgs(name, args), {
      ...options,
      env,
      signal,
      timeoutMs,
    });
  return {
    database: decodeURIComponent(parsed.pathname.slice(1)),
    run,
    kind: "local-pg17",
  };
}

export function composeTransport({
  project,
  envFile,
  files = ["compose.yaml"],
  database = "hyper",
  signal,
  timeoutMs,
} = {}) {
  if (
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project ?? "") ||
    !envFile ||
    !files.length
  )
    fail("Compose 模式需要明确项目名称、私有配置和 Compose 文件。");
  const base = [
    "compose",
    "--project-name",
    project,
    "--env-file",
    resolve(envFile),
    ...files.flatMap((file) => ["-f", resolve(file)]),
    "exec",
    "-T",
    "db",
  ];
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) fail("数据库名称无效。");
  const env = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CERT_PATH",
      "DOCKER_API_VERSION",
      "XDG_RUNTIME_DIR",
      "TMPDIR",
    ]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  return {
    database,
    kind: "compose-pg17",
    run: async (name, args, options = {}) => {
      await privateFile(resolve(envFile));
      return command(
        "docker",
        [...base, name, ...pgArgs(name, args, "hyper")],
        {
          ...options,
          signal,
          timeoutMs,
          env,
        },
      );
    },
  };
}
export function containerTransport({
  container,
  database,
  user = "hyper",
  signal,
  timeoutMs,
}) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container ?? "") ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(database ?? "") ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(user)
  )
    fail("隔离测试容器目标无效。");
  return {
    database,
    kind: "container-pg17",
    run: (name, args, options = {}) =>
      command(
        "docker",
        ["exec", "-i", container, name, ...pgArgs(name, args, user)],
        {
          ...options,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
          signal,
          timeoutMs,
        },
      ),
  };
}
async function query(transport, db, sql) {
  const output = await transport.run("psql", [
    "-XqAt",
    "--set=ON_ERROR_STOP=1",
    "--dbname",
    db,
    "--command",
    sql,
  ]);
  try {
    return JSON.parse(output);
  } catch {
    fail("数据库检查未返回预期结构，未继续恢复。");
  }
}
const metadataSql = `SELECT json_build_object(
 'serverVersion',current_setting('server_version_num'),
 'extensions',(SELECT json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension),
 'migrations',(SELECT json_agg(name ORDER BY name) FROM cw_migrations),
 'foreignObjects',EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema','hyper_jobs') AND n.nspname NOT LIKE 'pg_toast%'
   AND NOT (n.nspname='public' AND starts_with(c.relname,'cw_'))
   AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')),
 'invalidConstraints',EXISTS(SELECT 1 FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated),
 'invalidIndexes',EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace AND NOT i.indisvalid)
)`;
async function metadata(transport, db) {
  const value = await query(transport, db, metadataSql);
  const expected = (
    await readdir(new URL("../db/migrations/", import.meta.url))
  )
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (canonical(value.migrations) !== canonical(expected))
    fail("数据库迁移集与本代码版本不一致；请使用匹配的恢复代码版本。");
  if (
    !/^17\d{4}$/.test(value.serverVersion) ||
    value.foreignObjects ||
    value.invalidConstraints ||
    value.invalidIndexes ||
    !value.migrations?.includes("041_organization_budgets.sql") ||
    !value.extensions?.some((e) => e.name === "vector")
  )
    fail(
      "仅支持完整迁移的专用 Hyper Workspace PostgreSQL 17/pgvector 库；请先核对结构和版本。",
    );
  return value;
}
async function validateCredentials(transport, database, key) {
  let cursor = "",
    count = 0;
  for (;;) {
    const rows = await query(
      transport,
      database,
      `SELECT COALESCE(json_agg(t ORDER BY ref),'[]'::json) FROM (
      SELECT * FROM (SELECT 'model:'||id::text AS ref,credential_enc AS ciphertext FROM cw_model_profiles WHERE credential_enc IS NOT NULL AND credential_enc<>''
        UNION ALL SELECT 'identity:'||id::text,credential_enc FROM cw_identity_credentials WHERE disabled_at IS NULL AND credential_enc<>'') x
      WHERE ref>${quote(cursor)} ORDER BY ref LIMIT 100) t`,
    );
    if (!rows.length) return count;
    for (const row of rows) {
      if (
        !/^(model|identity):[a-f0-9-]{36}$/.test(row.ref) ||
        typeof row.ciphertext !== "string"
      )
        fail("凭据检查结构异常。");
      try {
        const encoded = Buffer.from(row.ciphertext, "base64");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          encoded.subarray(0, 12),
        );
        decipher.setAuthTag(encoded.subarray(12, 28));
        const plaintext = Buffer.concat([
          decipher.update(encoded.subarray(28)),
          decipher.final(),
        ]);
        plaintext.fill(0);
        encoded.fill(0);
      } catch {
        fail("既有主密钥不能解密活动凭据；没有输出凭据内容，也未启用恢复库。");
      }
      count++;
      cursor = row.ref;
    }
  }
}

export async function createWorkspaceBackup(transport, directory, masterKey) {
  privateDestination(directory);
  const key = keyBytes(masterKey),
    dir = resolve(directory);
  try {
    const dumpVersion = (await transport.run("pg_dump", ["--version"])).trim();
    if (!/\b17\./.test(dumpVersion))
      fail("需要与固定数据库匹配的 PostgreSQL 17 客户端。");
    const before = await metadata(transport, transport.database);
    const credentialChecks = await validateCredentials(
      transport,
      transport.database,
      key,
    );
    await mkdir(dir, { mode: 0o700 });
    await transport.run(
      "pg_dump",
      [
        "--format=custom",
        "--exclude-schema=hyper_jobs",
        "--dbname",
        transport.database,
      ],
      { output: join(dir, ARCHIVE) },
    );
    const after = await metadata(transport, transport.database);
    if (canonical(before) !== canonical(after))
      fail(
        "备份期间结构或扩展变化；此目录未生成有效备份清单，请重新安排备份。",
      );
    await transport.run("pg_restore", ["--list"], {
      input: join(dir, ARCHIVE),
    });
    const hash = await hashFile(join(dir, ARCHIVE));
    const manifest = {
      format: FORMAT,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      archive: ARCHIVE,
      ...hash,
      metadata: before,
      dumpVersion,
      toolSha256: (await hashFile(fileURLToPath(import.meta.url))).sha256,
      credentialChecks,
      queueIncluded: false,
      sourceTransport: transport.kind,
    };
    await signedWrite(join(dir, "manifest.json"), manifest, key);
    return {
      status: "created",
      backupId: manifest.id,
      bytes: hash.bytes,
      credentialChecks,
      queueIncluded: false,
    };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail("备份未完成，请核对私有目录和 PostgreSQL 权限；已有文件不会覆盖。");
  } finally {
    key.fill(0);
  }
}

export async function verifyWorkspaceBackup(directory, masterKey) {
  const key = keyBytes(masterKey),
    dir = resolve(directory);
  try {
    await privateFile(dir, true);
    const info = await privateFile(join(dir, "manifest.json"));
    if (info.size > 1024 * 1024) fail("备份清单超过允许大小。");
    const { proof, ...manifest } = JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    );
    if (
      manifest.format !== FORMAT ||
      manifest.archive !== ARCHIVE ||
      manifest.queueIncluded !== false ||
      !/^[a-f0-9]{64}$/.test(proof ?? "") ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? "") ||
      !/^[a-f0-9-]{36}$/.test(manifest.id ?? "")
    )
      fail("备份格式或清单无效。");
    if (
      !timingSafeEqual(
        Buffer.from(proof, "hex"),
        Buffer.from(sign(manifest, key), "hex"),
      )
    )
      fail("备份签名或主密钥不匹配；未连接恢复数据库。");
    await privateFile(join(dir, ARCHIVE));
    const hash = await hashFile(join(dir, ARCHIVE));
    if (hash.bytes !== manifest.bytes || hash.sha256 !== manifest.sha256)
      fail("备份归档损坏或内容不匹配；未连接恢复数据库。");
    return manifest;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail("无法核验私有备份清单或归档。");
  } finally {
    key.fill(0);
  }
}

function quarantineSql(restoreId, backupId) {
  const reason = "数据库备份恢复；原执行和外部动作需人工核对，未自动重放。";
  return `BEGIN;
    WITH changed AS (UPDATE cw_runs SET state='recovery_required',error=${quote(reason)},lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp(),next_sequence=next_sequence+1
      WHERE state IN ('queued','running') RETURNING id,next_sequence-1 AS sequence)
    INSERT INTO cw_run_events(event_id,run_id,sequence,kind,data) SELECT gen_random_uuid(),id,sequence,'run.recovery_required',json_build_object('reason','backup_restore','restoreId',${quote(restoreId)},'backupId',${quote(backupId)}) FROM changed;
    UPDATE cw_follow_up_schedules SET state='paused',next_check_at=NULL,version=version+1,last_error=${quote(reason)},lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE state='active';
    UPDATE cw_room_command_steps SET state='unknown',settled_at=clock_timestamp() WHERE state='dispatching';
    UPDATE cw_room_commands SET state='recovery_required',outcome='dispatch_unknown',updated_at=clock_timestamp() WHERE state='dispatching';
    UPDATE cw_communication_sends SET state='recovery_required',error=${quote(reason)},updated_at=clock_timestamp() WHERE state='sending';
    UPDATE cw_attachment_sends SET state='recovery_required',error=${quote(reason)},updated_at=clock_timestamp() WHERE state='sending';
    UPDATE cw_attachment_uploads SET state='recovery_required',error=${quote(reason)},updated_at=clock_timestamp() WHERE state IN ('prepared','uploading');
    UPDATE cw_calendar_commands SET state='recovery_required',error='calendar_backup_restore',updated_at=clock_timestamp() WHERE state IN ('prepared','applying');
    UPDATE cw_model_requests SET charge_review_required=true WHERE settled_at IS NULL AND declared_cost_picos IS NULL;
    UPDATE cw_budget_charges q SET review_required=true FROM cw_model_requests m WHERE m.id=q.request_id AND m.settled_at IS NULL AND q.declared_picos IS NULL;
    DELETE FROM cw_login_flows; DELETE FROM cw_sessions;
    COMMIT;
    SELECT json_build_object('activeRuns',(SELECT count(*) FROM cw_runs WHERE state IN ('queued','running')),
      'activeSchedules',(SELECT count(*) FROM cw_follow_up_schedules WHERE state='active'),
      'activeCalendarCommands',(SELECT count(*) FROM cw_calendar_commands WHERE state IN ('prepared','applying')),
      'recoveryRuns',(SELECT count(*) FROM cw_run_events WHERE data->>'restoreId'=${quote(restoreId)}),
      'reviewModelRequests',(SELECT count(*) FROM cw_model_requests WHERE settled_at IS NULL AND declared_cost_picos IS NULL AND charge_review_required),
      'reviewCompanyCharges',(SELECT count(*) FROM cw_budget_charges q JOIN cw_model_requests m ON m.id=q.request_id WHERE m.settled_at IS NULL AND q.declared_picos IS NULL AND q.review_required),
      'unreviewedModelRequests',(SELECT count(*) FROM cw_model_requests WHERE settled_at IS NULL AND declared_cost_picos IS NULL AND NOT charge_review_required),
      'unreviewedCompanyCharges',(SELECT count(*) FROM cw_budget_charges q JOIN cw_model_requests m ON m.id=q.request_id WHERE m.settled_at IS NULL AND q.declared_picos IS NULL AND NOT q.review_required),
      'sessions',(SELECT count(*) FROM cw_sessions), 'loginFlows',(SELECT count(*) FROM cw_login_flows),
      'queueAbsent',to_regnamespace('hyper_jobs') IS NULL)`;
}
export async function restoreWorkspaceBackup(
  transport,
  directory,
  masterKey,
  reportPath,
) {
  privateDestination(reportPath);
  const manifest = await verifyWorkspaceBackup(directory, masterKey);
  const key = keyBytes(masterKey),
    restoreId = randomUUID(),
    database = "hyper_restore_" + randomUUID().replaceAll("-", "").slice(0, 16);
  let reportHandle,
    staging,
    created = false;
  try {
    // Reserve a new report path before any database mutation. The source archive is immutable.
    reportHandle = await open(resolve(reportPath), "wx", 0o600);
    staging = await mkdtemp(join(tmpdir(), "hyper-verified-restore-"));
    const stagedArchive = join(staging, ARCHIVE);
    await copyFile(join(resolve(directory), ARCHIVE), stagedArchive);
    const copied = await hashFile(stagedArchive);
    if (copied.sha256 !== manifest.sha256 || copied.bytes !== manifest.bytes)
      fail("归档在核验期间变化；未连接恢复数据库。");
    const version = await transport.run("pg_restore", ["--version"]);
    if (!/\b17\./.test(version)) fail("隔离恢复需要 PostgreSQL 17 客户端。");
    await transport.run("createdb", [
      "--maintenance-db=postgres",
      "--template=template0",
      database,
    ]);
    created = true;
    await transport.run(
      "pg_restore",
      [
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        database,
      ],
      { input: stagedArchive },
    );
    const restored = await metadata(transport, database);
    if (
      canonical(restored.extensions) !==
        canonical(manifest.metadata.extensions) ||
      canonical(restored.migrations) !== canonical(manifest.metadata.migrations)
    )
      fail("恢复后的扩展或迁移记录与备份不一致；隔离库未启用。");
    const credentialChecks = await validateCredentials(
      transport,
      database,
      key,
    );
    const quarantine = await query(
      transport,
      database,
      quarantineSql(restoreId, manifest.id),
    );
    if (
      quarantine.activeRuns ||
      quarantine.activeSchedules ||
      quarantine.activeCalendarCommands ||
      quarantine.sessions ||
      quarantine.loginFlows ||
      quarantine.unreviewedModelRequests ||
      quarantine.unreviewedCompanyCharges ||
      !quarantine.queueAbsent
    )
      fail("恢复隔离检查未通过；不要启动此库的服务。");
    const report = {
      format: "hyper-workspace.restore-check.v1",
      status: "verified_isolated",
      restoreId,
      backupId: manifest.id,
      backupSha256: manifest.sha256,
      database,
      createdAt: new Date().toISOString(),
      credentialChecks,
      quarantine,
      servicesStarted: false,
      externalBusinessSystemsCalled: false,
      productionPromoted: false,
    };
    await writeReport(reportHandle, report, key);
    return report;
  } catch (error) {
    if (reportHandle) {
      const report = {
        format: "hyper-workspace.restore-check.v1",
        status: "failed_isolated",
        restoreId,
        backupId: manifest.id,
        database: created ? database : null,
        servicesStarted: false,
        productionPromoted: false,
      };
      await writeReport(reportHandle, report, key);
    }
    if (error instanceof BackupError) throw error;
    fail("隔离恢复未完成；没有覆盖原库或启动服务，请保留受限报告核对。");
  } finally {
    await reportHandle?.close();
    if (staging) await rm(staging, { recursive: true, force: true });
    key.fill(0);
  }
}

async function main() {
  const [operation, ...args] = process.argv.slice(2),
    options = { files: [] };
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i],
      value = args[i + 1];
    if (
      !value ||
      ![
        "--directory",
        "--report",
        "--url-env",
        "--bin-dir",
        "--compose-project",
        "--env-file",
        "--file",
      ].includes(name)
    )
      fail(
        "参数无效；使用 create / verify / restore-check、--directory 以及明确的私有连接配置。",
      );
    if (name === "--file") options.files.push(value);
    else {
      if (options[name]) fail("配置参数不能重复。");
      options[name] = value;
    }
  }
  if (
    !options["--directory"] ||
    !["create", "verify", "restore-check"].includes(operation)
  )
    fail("使用 create / verify / restore-check --directory 私有备份目录。");
  const key = process.env.CREDENTIAL_MASTER_KEY;
  if (operation === "verify") {
    const m = await verifyWorkspaceBackup(options["--directory"], key);
    console.log(
      JSON.stringify({
        status: "verified_archive",
        backupId: m.id,
        bytes: m.bytes,
      }),
    );
    return;
  }
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  if (!!options["--url-env"] === !!options["--compose-project"])
    fail("请选择一种明确连接：--url-env 或 --compose-project。");
  const transport = options["--url-env"]
    ? localTransport(process.env[options["--url-env"]], {
        binDir: options["--bin-dir"],
        signal: stop.signal,
      })
    : composeTransport({
        project: options["--compose-project"],
        envFile: options["--env-file"],
        files: options.files.length ? options.files : undefined,
        signal: stop.signal,
      });
  if (operation === "restore-check" && !options["--report"])
    fail("恢复检查必须指定新的私有 --report 文件。");
  const result =
    operation === "create"
      ? await createWorkspaceBackup(transport, options["--directory"], key)
      : await restoreWorkspaceBackup(
          transport,
          options["--directory"],
          key,
          options["--report"],
        );
  console.log(JSON.stringify(result));
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(
      error instanceof BackupError
        ? error.message
        : "备份工具未完成；诊断和凭据正文未输出。",
    );
    process.exitCode = 1;
  });
}
