import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("Office gateway initialization preserves its private secret and rejects damaged credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "hyper-office-secret-"));
  const directory = join(root, ".runtime", "office-guard");
  const secret = join(directory, "secret");
  const script = join(root, "scripts", "office-guard-init.mjs");
  try {
    await mkdir(join(root, "scripts"));
    await copyFile("scripts/office-guard-init.mjs", script);
    const run = () => spawnSync(process.execPath, [script], { encoding: "utf8" });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const value = await readFile(secret, "utf8");
    assert.match(value, /^[a-f0-9]{64}\n$/);
    assert.ok(!first.stdout.includes(value.trim()));
    assert.equal(run().status, 0);
    assert.equal(await readFile(secret, "utf8"), value);
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(secret)).mode & 0o777, 0o444);
    }
    await chmod(secret, 0o600);
    await writeFile(secret, "damaged-credential");
    const failed = run();
    assert.equal(failed.status, 1);
    assert.ok(!failed.stderr.includes("damaged-credential"));
    assert.equal(await readFile(secret, "utf8"), "damaged-credential");
    if (process.platform !== "win32") {
      await rm(secret);
      const unrelated = join(root, "unrelated-secret");
      await writeFile(unrelated, value, { mode: 0o600 });
      await symlink(unrelated, secret);
      assert.equal(run().status, 1);
      assert.equal((await stat(unrelated)).mode & 0o777, 0o600);
      assert.equal(await readFile(unrelated, "utf8"), value);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
