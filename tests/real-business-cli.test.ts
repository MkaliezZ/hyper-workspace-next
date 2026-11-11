import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = new URL("../scripts/real-business-smoke.ts", import.meta.url);
const sentinel = "synthetic-secret-must-not-be-echoed";
function invoke(args: string[], target = script) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(target), ...args],
    {
      encoding: "utf8",
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: "invalid-private-database-" + sentinel,
        REAL_MODEL_PROFILE_ID: sentinel,
      },
    },
  );
}

test("Real supplier business CLI defaults to a no-call preflight even with invalid private configuration", () => {
  const result = invoke([]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const preflight = JSON.parse(result.stdout);
  assert.equal(preflight.mode, "preflight");
  assert.equal(preflight.requestsSent, 0);
  assert.equal(preflight.executionMayBeBillable, true);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(sentinel));
});

const methods = new URL("../scripts/real-methods-smoke.ts", import.meta.url);
const office = new URL("../scripts/real-office-smoke.ts", import.meta.url);
test("Office supplier CLI defaults to a no-call preflight and describes the isolated real-core checks", () => {
  const result = invoke([], office);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const preflight = JSON.parse(result.stdout);
  assert.equal(preflight.requestsSent, 0);
  assert.equal(preflight.businessRuns, 12);
  assert.equal(preflight.executionMayBeBillable, true);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(sentinel));
});
test("Office supplier CLI rejects missing isolation and unknown arguments without leaking private values", () => {
  for (const args of [["--execute"], ["--execute", sentinel]]) {
    const result = invoke(args, office);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Office supplier verification failed/);
    assert.ok(!result.stderr.includes(sentinel));
  }
});
const localTools = [
  new URL("../runtime/evaluations/embedding-server.mjs", import.meta.url),
  new URL("../runtime/evaluations/download-embedding.mjs", import.meta.url),
  new URL("../runtime/evaluations/local-service.mjs", import.meta.url),
  new URL("../runtime/evaluations/container-service.mjs", import.meta.url),
  new URL("../runtime/evaluations/prepare-container.mjs", import.meta.url),
];
test("Optional embedding tools default to no network/model startup even without installed evaluation dependencies", () => {
  for (const tool of localTools) {
    const result = invoke([], tool);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).requestsSent, 0);
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes(sentinel));
  }
});
test("Optional embedding tools reject unknown options without echoing private configuration", () => {
  for (const tool of localTools) {
    const result = invoke([sentinel], tool);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.length > 0 && !result.stderr.includes(sentinel));
  }
});
const semantic = new URL(
  "../scripts/semantic-quality-check.ts",
  import.meta.url,
);
test("Semantic quality CLI preflight neither opens a database nor contacts a model", () => {
  const result = invoke([], semantic);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).requestsSent, 0);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(sentinel));
});
test("Semantic quality CLI rejects missing isolation and unknown arguments without exposing private values", () => {
  for (const args of [["--execute"], ["--execute", sentinel]]) {
    const result = invoke(args, semantic);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Semantic quality check did not finish/);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(sentinel));
  }
});
test("Real supplier method CLI defaults to a no-call preflight without opening private configuration", () => {
  const result = invoke([], methods);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const preflight = JSON.parse(result.stdout);
  assert.equal(preflight.mode, "preflight");
  assert.equal(preflight.requestsSent, 0);
  assert.equal(preflight.businessRuns, 8);
  assert.equal(preflight.executionMayBeBillable, true);
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(sentinel));
});

test("Real supplier method CLI rejects secret-shaped IDs and unknown options before any paid request", () => {
  for (const args of [["--execute"], ["--execute", sentinel]]) {
    const result = invoke(args, methods);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Set REAL_MODEL_PROFILE_ID|Real methods check did not finish/,
    );
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(sentinel));
  }
});

test("Real supplier business CLI rejects a secret used as a profile UUID and unknown arguments without echoing it", () => {
  for (const args of [["--execute"], ["--execute", sentinel]]) {
    const result = invoke(args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.length > 0);
    assert.match(
      result.stderr,
      /Set REAL_MODEL_PROFILE_ID|Real business check did not finish/,
    );
    assert.ok(!result.stderr.includes(sentinel));
    assert.equal(result.stdout, "");
  }
});
