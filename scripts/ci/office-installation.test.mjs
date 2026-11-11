import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupOwnedResources,
  validateOfficeTopology,
  classifyInstallationPageError,
} from "./office-installation.mjs";
import {
  saveSourceFixtureKey,
  loadSourceFixtureKey,
} from "./office-source-fixture.mjs";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  lstat,
  chmod,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

test("installation page errors expose only fixed categories, never messages or URLs", () => {
  assert.equal(
    classifyInstallationPageError({
      name: "ReferenceError",
      message: "__name is not defined",
    }),
    "transpiler_helper",
  );
  assert.equal(
    classifyInstallationPageError({
      name: "Error",
      message:
        "postMessage target origin https://private.invalid/?access_token=synthetic-secret does not match recipient window",
    }),
    "postmessage_origin",
  );
  assert.equal(
    classifyInstallationPageError({
      name: "TypeError",
      message: "synthetic-secret",
    }),
    "type_error",
  );
  assert.equal(
    classifyInstallationPageError({
      name: "synthetic-secret",
      message: "synthetic-secret",
    }),
    "other",
  );
});

test("the installation probe loader keeps the actual Office observer executable in the browser realm", async () => {
  const shell = await readFile(
    new URL("./office-installation.sh", import.meta.url),
    "utf8",
  );
  const command = shell.match(
    /^node (.*?)scripts\/ci\/office-installation\.mjs probe$/m,
  );
  assert.ok(
    command,
    "Exercise the loader used by the actual installation probe",
  );
  const loaderArgs = command[1].trim() ? command[1].trim().split(/\s+/) : [];
  // addInitScript serializes a function into the browser. Transpiler helpers in
  // its outer Node scope cannot follow it, even when importing the module succeeds.
  const script = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import { observeOffice } from './tests/nextcloud/office-helpers.ts';
    let injected, config, listener;
    await observeOffice({on(){},async exposeBinding(){},async addInitScript(fn,args){injected=fn;config=args}},'http://editor.test','http://source.test');
    const sender={}, iframe={contentWindow:sender,dataset:{}}, reports=[];
    const window={location:{origin:config.sourceOrigin},addEventListener(name,fn){listener=fn},async __hyperOfficeObserved(value){reports.push(value)}};
    vm.runInNewContext('('+injected.toString()+')(config)',{window,document:{querySelectorAll:()=>[iframe]},config});
    listener({origin:config.editorOrigin,source:sender,data:JSON.stringify({MessageId:'App_LoadingStatus',Values:{Status:'Document_Loaded'}})});
    assert.equal(reports.length,1);
    assert.equal(reports[0].status,'Document_Loaded');
  `;
  await promisify(execFile)(
    process.execPath,
    [...loaderArgs, "--input-type=module", "-e", script],
    { timeout: 10000 },
  );
});

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

test("installation cleanup only removes its labelled empty Office and ingress networks", async () => {
  const project = "hyper-deployment-ci";
  for (const [label, containers, allowed] of [
    [project, {}, true],
    ["foreign", {}, false],
    [project, { foreignEndpoint: {} }, false],
  ]) {
    const removed = [];
    const failures = await cleanupOwnedResources(
      { project, sourceVolume: project + "_nextcloud_data" },
      {},
      {
        volumeLabels: () => undefined,
        verifyPreserved: () => {},
        networkInfo: (name) => ({
          Labels: {
            "com.docker.compose.project": label,
            "com.docker.compose.network": name.slice(project.length + 1),
          },
          Containers: containers,
        }),
        removeNetwork: (name) => {
          removed.push(name);
        },
      },
    );
    assert.deepEqual(
      removed,
      allowed ? [project + "_office", project + "_office-ingress"] : [],
    );
    assert.deepEqual(
      failures,
      allowed ? [] : ["network_cleanup_failed", "network_cleanup_failed"],
    );
  }
});

test("installation topology requires real loopback publication, private CODE and a separate gateway ingress", () => {
  const project = "hyper-deployment-ci";
  const snapshot = {
    codePorts: { "9980/tcp": null },
    guardPorts: {
      "9981/tcp": [{ HostIp: "127.0.0.1", HostPort: "18091" }],
      "9982/tcp": null,
    },
    codeNetworks: { [project + "_office"]: {} },
    guardNetworks: {
      [project + "_office"]: {},
      [project + "_office-ingress"]: {},
    },
    office: {
      Internal: true,
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.network": "office",
      },
    },
    ingress: {
      Internal: false,
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.network": "office-ingress",
      },
    },
  };
  assert.doesNotThrow(() => validateOfficeTopology(project, snapshot));
  for (const mutate of [
    // Actual Docker result for internal-only: configured HostConfig bindings exist,
    // but NetworkSettings has no published port and loopback connections fail.
    (s) => {
      s.guardPorts["9981/tcp"] = null;
      delete s.guardNetworks[project + "_office-ingress"];
    },
    (s) => {
      s.guardPorts["9981/tcp"][0].HostIp = "0.0.0.0";
    },
    (s) => {
      s.guardPorts["9982/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "18092" }];
    },
    (s) => {
      s.codeNetworks[project + "_office-ingress"] = {};
    },
    (s) => {
      s.codePorts["9980/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "18093" }];
    },
    (s) => {
      s.office.Internal = false;
    },
    (s) => {
      s.ingress.Labels["com.docker.compose.project"] = "foreign";
    },
  ]) {
    const candidate = structuredClone(snapshot);
    mutate(candidate);
    assert.throws(() => validateOfficeTopology(project, candidate));
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
