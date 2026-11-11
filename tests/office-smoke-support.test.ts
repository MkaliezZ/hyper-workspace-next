import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  finalizeOfficeSmoke,
  officeFixtureEnvironment,
} from "../scripts/office-smoke-support.js";

const secret = "synthetic-private-credential-must-not-be-recorded";

test("Office smoke attempts every cleanup step and reports only fixed failure codes", async () => {
  const calls: string[] = [];
  const report = {
    status: "passed",
    runs: [{ state: "succeeded" }],
    cleanupFailures: [] as string[],
  };
  const fail = (name: string) => () => {
    calls.push(name);
    throw new Error(secret);
  };
  const result = await finalizeOfficeSmoke({
    report,
    clearCredential: fail("credential"),
    closeSource: fail("source"),
    closeDatabase: fail("database"),
    restoreEnvironment: fail("environment"),
    saveReport: fail("report"),
  });
  assert.deepEqual(calls, [
    "credential",
    "source",
    "database",
    "environment",
    "report",
  ]);
  assert.deepEqual(result.cleanupFailures, [
    "model_credential_clear",
    "source_close",
    "database_close",
    "environment_restore",
    "report_write",
  ]);
  assert.equal(result.status, "failed");
  assert.equal(report.status, "failed");
  assert.deepEqual(report.runs, [{ state: "succeeded" }]);
  assert.ok(!JSON.stringify({ report, result }).includes(secret));
});

test("Office smoke closes resources and restores environment even when the report cannot be written", async () => {
  let sourceOpen = true,
    databaseOpen = true;
  const environment = { key: secret };
  const report = { status: "passed" };
  const result = await finalizeOfficeSmoke({
    report,
    closeSource: () => {
      sourceOpen = false;
    },
    closeDatabase: () => {
      databaseOpen = false;
    },
    restoreEnvironment: () => {
      environment.key = "original";
    },
    saveReport: () => {
      assert.equal(sourceOpen, false);
      assert.equal(databaseOpen, false);
      assert.equal(environment.key, "original");
      throw new Error("Write failed: " + secret);
    },
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.cleanupFailures, ["report_write"]);
  assert.ok(!JSON.stringify(report).includes(secret));
});

test("Office smoke persists credential cleanup failure after still closing its source and database", async () => {
  const completed: string[] = [];
  const report = { status: "passed" };
  let saved = "";
  await finalizeOfficeSmoke({
    report,
    clearCredential: () => {
      throw new Error(secret);
    },
    closeSource: () => {
      completed.push("source");
    },
    closeDatabase: () => {
      completed.push("database");
    },
    restoreEnvironment: () => {
      completed.push("environment");
    },
    saveReport: () => {
      saved = JSON.stringify(report);
    },
  });
  assert.deepEqual(completed, ["source", "database", "environment"]);
  assert.deepEqual(JSON.parse(saved), {
    status: "failed",
    cleanupFailures: ["model_credential_clear"],
  });
  assert.ok(!saved.includes(secret));
});

test("Office fixture subprocesses inherit runtime paths but no supplier, vault or database credentials", () => {
  assert.deepEqual(
    officeFixtureEnvironment({
      PATH: "/synthetic/bin",
      SystemRoot: "C:\\Windows",
      LANG: "C.UTF-8",
      DEEPSEEK_API_KEY: secret,
      CREDENTIAL_MASTER_KEY: secret,
      DATABASE_URL: secret,
      HYPER_MODEL_API_KEY: secret,
      AWS_SECRET_ACCESS_KEY: secret,
      PYTHONPATH: secret,
    }),
    { PATH: "/synthetic/bin", SystemRoot: "C:\\Windows", LANG: "C.UTF-8" },
  );
  const child = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify(process.env))"],
    {
      encoding: "utf8",
      timeout: 5000,
      env: officeFixtureEnvironment({
        ...process.env,
        DEEPSEEK_API_KEY: secret,
        CREDENTIAL_MASTER_KEY: secret,
        DATABASE_URL: secret,
      }),
    },
  );
  assert.equal(child.status, 0);
  assert.equal(child.stderr, "");
  assert.ok(!child.stdout.includes(secret));
  assert.equal(JSON.parse(child.stdout).DEEPSEEK_API_KEY, undefined);
});
