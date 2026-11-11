import test from "node:test";
import assert from "node:assert/strict";
import { cleanupOwnedResources } from "./office-installation.mjs";

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
