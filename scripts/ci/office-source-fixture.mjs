import assert from "node:assert/strict";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";

const target = () => resolve(".runtime/office-source-test.json");
function binding(project, environment) {
  assert.match(project, /^hyper-deployment-ci(?:-[a-z0-9-]+)?$/);
  return { project, environment: resolve(environment) };
}
export async function saveSourceFixtureKey(
  project,
  environment,
  password,
  path = target(),
) {
  const scope = binding(project, environment);
  assert.ok(
    typeof password === "string" && /^[a-f0-9]{64}$/.test(password),
    "Invalid synthetic source credential",
  );
  await writeFile(
    path,
    JSON.stringify({
      format: "hyper-office-source-test.v1",
      ...scope,
      password,
    }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
export async function loadSourceFixtureKey(
  project,
  environment,
  path = target(),
) {
  const scope = binding(project, environment),
    entry = await lstat(path);
  assert.ok(
    entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.nlink === 1 &&
      entry.size <= 2048,
  );
  if (process.platform !== "win32") assert.equal(entry.mode & 0o077, 0);
  const value = JSON.parse(await readFile(path, "utf8"));
  assert.equal(value.format, "hyper-office-source-test.v1");
  assert.equal(value.project, scope.project);
  assert.equal(value.environment, scope.environment);
  assert.ok(
    typeof value.password === "string" && /^[a-f0-9]{64}$/.test(value.password),
    "Invalid synthetic source credential",
  );
  return value.password;
}
