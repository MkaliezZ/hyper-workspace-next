import test from "node:test";
import assert from "node:assert/strict";
import { cleanupOwnedResources } from "./office-installation.mjs";
import {
  saveSourceFixtureKey,
  loadSourceFixtureKey,
} from "./office-source-fixture.mjs";
import { mkdtemp, rm, writeFile, lstat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

test("installation cleanup rejects foreign labels, continues other cleanup and preserves the existing stack", async () => {
  const project = "hyper-deployment-ci",
    calls = [];
  const failures = await cleanupOwnedResources(
    { project, sourceVolume: project + "_nextcloud_data" },
    {
      "office-gateway": "gateway",
      collabora: "code",
      nextcloud: "foreign",
      api: "must-not-be-removed",
    },
    {
      containerLabels: (id) => ({
        "com.docker.compose.project":
          id === "foreign" ? "another-project" : project,
        "com.docker.compose.service": {
          gateway: "office-gateway",
          code: "collabora",
          foreign: "nextcloud",
        }[id],
      }),
      removeContainer: (id) => {
        calls.push(id);
        if (id === "gateway") throw Error("secret-upstream-detail");
      },
      volumeLabels: () => ({
        "com.docker.compose.project": project,
        "com.docker.compose.volume": "nextcloud_data",
      }),
      removeVolume: () => calls.push("volume"),
      verifyPreserved: () => calls.push("preserved"),
    },
  );
  assert.deepEqual(calls, ["gateway", "code", "volume", "preserved"]);
  assert.deepEqual(failures, [
    "container_cleanup_failed",
    "container_cleanup_failed",
  ]);
  assert.ok(!JSON.stringify(failures).includes("secret"));
});
test("installation cleanup never removes a product database volume or unlabelled volume", async () => {
  for (const sourceVolume of [
    "hyper-deployment-ci_database",
    "hyper-deployment-ci_nextcloud_data",
  ]) {
    let removed = false,
      checked = false;
    const failures = await cleanupOwnedResources(
      { project: "hyper-deployment-ci", sourceVolume },
      {},
      {
        containerLabels: () => ({}),
        removeContainer: () => assert.fail(),
        volumeLabels: () => ({}),
        removeVolume: () => {
          removed = true;
        },
        verifyPreserved: () => {
          checked = true;
        },
      },
    );
    assert.equal(removed, false);
    assert.equal(checked, true);
    assert.deepEqual(failures, ["volume_cleanup_failed"]);
  }
});

test("installation cleanup only removes its labelled empty Office network", async () => {
  const project = "hyper-deployment-ci";
  for (const [label, containers, allowed] of [
    [project, {}, true],
    ["foreign", {}, false],
    [project, { foreignEndpoint: {} }, false],
  ]) {
    let removed = false;
    const failures = await cleanupOwnedResources(
      { project, sourceVolume: project + "_nextcloud_data" },
      {},
      {
        volumeLabels: () => undefined,
        verifyPreserved: () => {},
        networkInfo: () => ({
          Labels: {
            "com.docker.compose.project": label,
            "com.docker.compose.network": "office",
          },
          Containers: containers,
        }),
        removeNetwork: (name) => {
          assert.equal(name, project + "_office");
          removed = true;
        },
      },
    );
    assert.equal(removed, allowed);
    assert.deepEqual(failures, allowed ? [] : ["network_cleanup_failed"]);
  }
});

test("source fixture handoff reuses only the matching private credential and never rotates it", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "hyper-office-source-test-"));
  t.after(async () => {
    assert.ok(
      resolve(folder).startsWith(
        resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"),
      ),
    );
    await rm(folder, { recursive: true, force: true });
  });
  const path = join(folder, "key.json"),
    project = "hyper-deployment-ci",
    env = join(folder, "compose.env"),
    key = "ab".repeat(32);
  await saveSourceFixtureKey(project, env, key, path);
  assert.equal(await loadSourceFixtureKey(project, env, path), key);
  if (process.platform !== "win32")
    assert.equal((await lstat(path)).mode & 0o077, 0);
  await assert.rejects(
    saveSourceFixtureKey(project, env, "cd".repeat(32), path),
  );
  await assert.rejects(loadSourceFixtureKey(project + "-other", env, path));
  await assert.rejects(loadSourceFixtureKey(project, env + ".other", path));
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    await assert.rejects(loadSourceFixtureKey(project, env, path));
    await chmod(path, 0o600);
  }
  await writeFile(
    path,
    JSON.stringify({
      format: "hyper-office-source-test.v1",
      project,
      environment: resolve(env),
      password: "invalid",
    }),
  );
  await assert.rejects(loadSourceFixtureKey(project, env, path));
});
