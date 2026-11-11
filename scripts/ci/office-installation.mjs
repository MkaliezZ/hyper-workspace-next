import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSourceFixtureKey } from "./office-source-fixture.mjs";
import { collectGatewayStatus } from "./office-gateway-diagnostics.mjs";

export const directory = resolve(".runtime/office-installation");
const sourceServices = [
  "source-initialize",
  "nextcloud",
  "collabora",
  "office-gateway",
];
const existingServices = ["db", "api", "worker", "ocr", "office-batch"];
const composeFiles = [
  "compose.yaml",
  "deploy/compose.ci.yaml",
  "deploy/compose.local-ocr.yaml",
  "deploy/compose.office-tools.yaml",
  "deploy/compose.source.yaml",
  "deploy/compose.office.yaml",
];
function docker(args, options = {}) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch {
    throw new Error("docker_operation_failed");
  }
}
function projectName() {
  const project = process.env.COMPOSE_TEST_PROJECT;
  assert.match(project || "", /^hyper-deployment-ci(?:-[a-z0-9-]+)?$/);
  return project;
}
function compose(project, env, full = false) {
  return [
    "compose",
    "--project-name",
    project,
    "--env-file",
    env,
    ...(full
      ? composeFiles
      : [
          "compose.yaml",
          "deploy/compose.ci.yaml",
          "deploy/compose.local-ocr.yaml",
          "deploy/compose.office-tools.yaml",
        ]
    ).flatMap((file) => ["-f", file]),
    ...(full ? ["-f", resolve(directory, "loopback.yaml")] : []),
  ];
}
function container(project, service, env, full) {
  return docker([...compose(project, env, full), "ps", "-a", "-q", service]);
}
function labels(id) {
  return JSON.parse(
    docker(["inspect", "--format", "{{json .Config.Labels}}", id]),
  );
}
function owns(id, project, service) {
  assert.match(id, /^[a-f0-9]{12,64}$/);
  const value = labels(id);
  assert.equal(value["com.docker.compose.project"], project);
  assert.equal(value["com.docker.compose.service"], service);
}
async function data() {
  return JSON.parse(await readFile(resolve(directory, "private.json"), "utf8"));
}
async function save(name, value) {
  await writeFile(
    resolve(directory, name),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
}

async function prepare() {
  const project = projectName();
  const original = resolve(process.env.COMPOSE_TEST_ENV || "");
  assert.equal(original, resolve(".runtime/compose-ci.env"));
  const entry = await lstat(original);
  assert.ok(entry.isFile() && !entry.isSymbolicLink());
  const previous = await readFile(original, "utf8");
  const sourcePassword = await loadSourceFixtureKey(project, original);
  // Refuse a source-configured installation. This is an overlay onto the disposable CI job only.
  for (const key of [
    "NEXTCLOUD_URL",
    "NEXTCLOUD_INTERNAL_URL",
    "NEXTCLOUD_MEMBER_GROUP",
  ])
    assert.match(previous, new RegExp("^" + key + "=\\s*$", "m"));
  const before = {};
  for (const service of existingServices) {
    const id = container(project, service, original, false);
    owns(id, project, service);
    before[service] = id;
    assert.equal(
      docker(["inspect", "--format", "{{.State.Status}}", id]),
      "running",
    );
  }
  for (const service of sourceServices) {
    assert.equal(
      docker([
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ]),
      "",
    );
  }
  assert.equal(
    docker([
      "volume",
      "ls",
      "-q",
      "--filter",
      `name=^${project}_nextcloud_data$`,
    ]),
    "",
  );
  for (const network of ["office", "office-ingress"])
    assert.equal(
      docker([
        "network",
        "ls",
        "-q",
        "--filter",
        `name=^${project}_${network}$`,
      ]),
      "",
    );
  await mkdir(directory, { mode: 0o700 }); // No recursive overwrite/reuse of a previous run.
  const value = {
    project,
    original,
    before,
    sourceVolume: project + "_nextcloud_data",
    source: "http://127.0.0.1:18090",
    office: "http://127.0.0.1:18091",
    admin: "office-install-admin",
    employee: "office-install-user",
    group: "office-install-members",
    password: randomBytes(32).toString("hex"),
    adminPassword: randomBytes(32).toString("hex"),
  };
  await save("private.json", value);
  const update = {
    NEXTCLOUD_URL: value.source,
    NEXTCLOUD_INTERNAL_URL: "http://nextcloud",
    NEXTCLOUD_MEMBER_GROUP: value.group,
  };
  let env = previous;
  for (const [key, replacement] of Object.entries(update))
    env = env.replace(
      new RegExp("^" + key + "=.*$", "m"),
      key + "=" + replacement,
    );
  env +=
    "\nHYPER_NEXTCLOUD_DB_PASSWORD=" +
    sourcePassword +
    "\nHYPER_NEXTCLOUD_ADMIN_USER=" +
    value.admin +
    "\nHYPER_NEXTCLOUD_ADMIN_PASSWORD=" +
    value.adminPassword +
    "\nHYPER_NEXTCLOUD_PORT=18090\nHYPER_OFFICE_PORT=18091\nHYPER_OFFICE_PUBLIC_HOST=127.0.0.1:18091\n";
  await writeFile(resolve(directory, "compose.env"), env, { mode: 0o600 });
  await writeFile(
    resolve(directory, "loopback.yaml"),
    `# Disposable loopback validation only; production HTTPS remains in compose.office.yaml.\nservices:\n  collabora:\n    mem_limit: 768m\n    memswap_limit: 768m\n    cpus: 1\n    environment:\n      extra_params: >-\n        --o:ssl.enable=false --o:ssl.termination=false --o:ssl.ssl_verification=true\n        --o:server_name=127.0.0.1:18091\n  office-gateway:\n    environment:\n      HYPER_OFFICE_GATEWAY_PUBLIC_ORIGIN: http://127.0.0.1:18091\n`,
    { mode: 0o600 },
  );
  await save("owned.json", {});
  console.log(
    "Office installation preflight: disposable project and existing services verified",
  );
}
async function record() {
  const value = await data(),
    owned = JSON.parse(
      await readFile(resolve(directory, "owned.json"), "utf8"),
    );
  assert.equal(value.project, projectName());
  for (const service of sourceServices) {
    const id = docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${value.project}`,
      "--filter",
      `label=com.docker.compose.service=${service}`,
    ]);
    if (id) {
      owns(id, value.project, service);
      if (owned[service]) assert.equal(owned[service], id);
      owned[service] = id;
    }
  }
  await save("owned.json", owned);
}
async function employee() {
  const value = await data(),
    id = container(
      value.project,
      "nextcloud",
      resolve(directory, "compose.env"),
      true,
    );
  owns(id, value.project, "nextcloud");
  docker([
    "exec",
    "--user",
    "www-data",
    id,
    "php",
    "occ",
    "group:add",
    value.group,
  ]);
  const result = spawnSync(
    "docker",
    [
      "exec",
      "--user",
      "www-data",
      "--env",
      "OC_PASS",
      id,
      "php",
      "occ",
      "user:add",
      "--password-from-env",
      value.employee,
    ],
    {
      env: { ...process.env, OC_PASS: value.password },
      stdio: "pipe",
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0);
  docker([
    "exec",
    "--user",
    "www-data",
    id,
    "php",
    "occ",
    "group:adduser",
    value.group,
    value.employee,
  ]);
  console.log("Office installation: synthetic source employee initialized");
}
async function preserved() {
  const value = await data();
  for (const [service, id] of Object.entries(value.before)) {
    owns(id, value.project, service);
    assert.equal(container(value.project, service, value.original, false), id);
    assert.equal(
      docker(["inspect", "--format", "{{.State.Status}}", id]),
      "running",
    );
  }
  const probe = `const checks=[['api','http://127.0.0.1:3100/api/health'],['ocr','http://ocr:3122/health'],['office-batch','http://office-batch:3123/health']];for(const [name,url]of checks){const r=await fetch(url,{signal:AbortSignal.timeout(10000)});await r.arrayBuffer();if(!r.ok)process.exit(1)}console.log('Existing API/OCR/Office batch services remain healthy');`;
  docker([
    "exec",
    value.before.api,
    "node",
    "--input-type=module",
    "-e",
    probe,
  ]);
  console.log(
    "Office installation: pre-existing services and health preserved",
  );
}
export function validateOfficeTopology(project, snapshot) {
  const {
    codePorts,
    guardPorts,
    codeNetworks,
    guardNetworks,
    office,
    ingress,
  } = snapshot;
  assert.ok(Object.values(codePorts || {}).every((value) => value === null));
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(guardPorts || {}).filter(([, value]) => value !== null),
    ),
    { "9981/tcp": [{ HostIp: "127.0.0.1", HostPort: "18091" }] },
  );
  assert.deepEqual(Object.keys(codeNetworks), [project + "_office"]);
  assert.deepEqual(
    Object.keys(guardNetworks).sort(),
    [project + "_office", project + "_office-ingress"].sort(),
  );
  for (const [name, network, internal] of [
    ["office", office, true],
    ["office-ingress", ingress, false],
  ]) {
    assert.equal(network.Internal, internal);
    assert.equal(network.Labels?.["com.docker.compose.project"], project);
    assert.equal(network.Labels?.["com.docker.compose.network"], name);
  }
}
async function topology() {
  const value = await data(),
    env = resolve(directory, "compose.env");
  const code = container(value.project, "collabora", env, true),
    guard = container(value.project, "office-gateway", env, true);
  owns(code, value.project, "collabora");
  owns(guard, value.project, "office-gateway");
  const codePorts = JSON.parse(
    docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", code]),
  );
  const guardPorts = JSON.parse(
    docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", guard]),
  );
  const guardNetworks = JSON.parse(
    docker([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      guard,
    ]),
  );
  const codeNetworks = JSON.parse(
    docker(["inspect", "--format", "{{json .NetworkSettings.Networks}}", code]),
  );
  const office = JSON.parse(
    docker(["network", "inspect", value.project + "_office"]),
  )[0];
  const ingress = JSON.parse(
    docker(["network", "inspect", value.project + "_office-ingress"]),
  )[0];
  validateOfficeTopology(value.project, {
    codePorts,
    guardPorts,
    codeNetworks,
    guardNetworks,
    office,
    ingress,
  });
  console.log(
    "Office installation: private CODE, separate ingress and loopback data-only port verified",
  );
  const discovery = await fetch(value.office + "/hosting/discovery", {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(discovery.status, 200);
  const xml = await discovery.text();
  for (const format of ["docx", "xlsx", "pptx"])
    assert.match(
      xml,
      new RegExp(
        '(?=[^>]*name="edit")(?=[^>]*ext="' +
          format +
          '")[^>]+urlsrc="http://127\\.0\\.0\\.1:18091/',
      ),
    );
  assert.equal(
    (await fetch(value.office + "/cool/convert-to/pdf", { redirect: "error" }))
      .status,
    403,
  );
  console.log(
    "Office installation: private CODE/control topology and real discovery verified",
  );
}
export function classifyInstallationPageError(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (error?.name === "ReferenceError" && message === "__name is not defined")
    return "transpiler_helper";
  if (
    /postMessage.*target origin|target origin.*recipient window/i.test(message)
  )
    return "postmessage_origin";
  if (error?.name === "ReferenceError") return "reference_error";
  if (error?.name === "TypeError") return "type_error";
  if (error?.name === "SyntaxError") return "syntax_error";
  return "other";
}
async function probe() {
  const value = await data();
  const { chromium } = await import("@playwright/test");
  const { observeOffice } = await import(
    "../../tests/nextcloud/office-helpers.ts"
  );
  const seed = await readFile(resolve(".runtime/office-compose-seed.docx"));
  assert.ok(
    seed.length > 4 &&
      seed.length < 8 * 1024 * 1024 &&
      seed.subarray(0, 2).toString() === "PK",
  );
  const headers = {
    Authorization:
      "Basic " +
      Buffer.from(value.employee + ":" + value.password).toString("base64"),
  };
  const url =
    value.source +
    "/remote.php/dav/files/" +
    value.employee +
    "/Installation-probe.docx";
  let browser, context, page, observer;
  const browserErrors = {
    transpiler_helper: 0,
    postmessage_origin: 0,
    reference_error: 0,
    type_error: 0,
    syntax_error: 0,
    other: 0,
  };
  let passed = false;
  try {
    const uploaded = await fetch(url, {
      method: "PUT",
      headers: {
        ...headers,
        "If-None-Match": "*",
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      body: seed,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(uploaded.status, 201);
    const found = await fetch(url, {
      method: "PROPFIND",
      headers: { ...headers, Depth: "0", "Content-Type": "application/xml" },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>',
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(found.status, 207);
    const match = /<(?:[A-Za-z]+:)?fileid>(\d+)<\/(?:[A-Za-z]+:)?fileid>/.exec(
      await found.text(),
    );
    assert.ok(match);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ locale: "en-US" });
    context.setDefaultTimeout(30000);
    context.on("page", (candidate) =>
      candidate.on("pageerror", (error) => {
        const category = classifyInstallationPageError(error);
        browserErrors[category] = Math.min(1000, browserErrors[category] + 1);
      }),
    );
    observer = await observeOffice(context, value.office, value.source);
    page = await context.newPage();
    await page.goto(value.source + "/login", { waitUntil: "domcontentloaded" });
    await page.locator('input[name="user"]').fill(value.employee);
    await page.locator('input[name="password"]').fill(value.password);
    await page
      .locator('form[name="login"] button[type="submit"]')
      .click({ noWaitAfter: true });
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
      timeout: 30000,
    });
    await page.goto(value.source + "/index.php/f/" + match[1], {
      waitUntil: "domcontentloaded",
    });
    await observer.waitForLoaded(page);
    assert.ok(observer.loadedFrame(page));
    passed = true;
    await save("result.json", {
      status: "passed",
      installationOverlay: true,
      signedConnector: "10.3.3",
      engine: "26.04.6.1.1",
      documentLoaded: "docx",
      companyHttps: "not-tested",
    });
    console.log(
      "Office installation: signed connector, companion ACL, gateway and real DOCX Document_Loaded passed",
    );
  } finally {
    if (!passed) {
      console.error(
        "Office installation browser error categories:",
        JSON.stringify(browserErrors),
      );
      try {
        if (observer && page)
          console.error(
            "Office installation browser summary:",
            JSON.stringify(await observer.diagnostics(page)),
          );
      } catch {
        console.error("Office installation browser summary unavailable");
      }
      try {
        const id = container(
          value.project,
          "office-gateway",
          resolve(directory, "compose.env"),
          true,
        );
        owns(id, value.project, "office-gateway");
        console.error(
          JSON.stringify({ office_gateway: collectGatewayStatus(id) }),
        );
      } catch {
        console.error(JSON.stringify({ office_gateway: { available: false } }));
      }
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    // Source files are synthetic and the owned source volume is removed by the shell finalizer.
  }
}
export async function cleanupOwnedResources(value, owned, operations) {
  const failures = [];
  for (const service of [...sourceServices].reverse()) {
    const id = owned[service];
    if (!id) continue;
    try {
      const actual = await operations.containerLabels(id);
      assert.equal(actual["com.docker.compose.project"], value.project);
      assert.equal(actual["com.docker.compose.service"], service);
      await operations.removeContainer(id);
    } catch {
      failures.push("container_cleanup_failed");
    }
  }
  try {
    assert.equal(value.sourceVolume, value.project + "_nextcloud_data");
    const volume = await operations.volumeLabels(value.sourceVolume);
    if (volume) {
      assert.equal(volume["com.docker.compose.project"], value.project);
      assert.equal(volume["com.docker.compose.volume"], "nextcloud_data");
      await operations.removeVolume(value.sourceVolume);
    }
  } catch {
    failures.push("volume_cleanup_failed");
  }
  if (operations.networkInfo) {
    for (const name of ["office", "office-ingress"])
      try {
        const network = await operations.networkInfo(
          value.project + "_" + name,
        );
        if (network) {
          assert.equal(
            network.Labels?.["com.docker.compose.project"],
            value.project,
          );
          assert.equal(network.Labels?.["com.docker.compose.network"], name);
          assert.equal(Object.keys(network.Containers || {}).length, 0);
          await operations.removeNetwork(value.project + "_" + name);
        }
      } catch {
        failures.push("network_cleanup_failed");
      }
  }
  try {
    await operations.verifyPreserved();
  } catch {
    failures.push("existing_services_changed");
  }
  return failures;
}
async function cleanup() {
  const value = await data();
  assert.equal(value.project, projectName());
  let recordFailed = false;
  try {
    await record();
  } catch {
    recordFailed = true;
  }
  const owned = JSON.parse(
    await readFile(resolve(directory, "owned.json"), "utf8"),
  );
  const failures = await cleanupOwnedResources(value, owned, {
    containerLabels: labels,
    removeContainer: (id) => docker(["rm", "-f", id]),
    volumeLabels: (name) => {
      const found = docker([
        "volume",
        "ls",
        "-q",
        "--filter",
        `name=^${name}$`,
      ]);
      if (!found) return undefined;
      assert.equal(found, name);
      return JSON.parse(
        docker(["volume", "inspect", "--format", "{{json .Labels}}", name]),
      );
    },
    removeVolume: (name) => docker(["volume", "rm", name]),
    networkInfo: (name) => {
      if (!docker(["network", "ls", "-q", "--filter", `name=^${name}$`]))
        return undefined;
      return JSON.parse(docker(["network", "inspect", name]))[0];
    },
    removeNetwork: (name) => docker(["network", "rm", name]),
    verifyPreserved: preserved,
  });
  assert.ok(!recordFailed && failures.length === 0);
  console.log(
    "Office installation: owned source containers/volume removed; existing services retained",
  );
}
export async function main(action) {
  const commands = {
    prepare,
    record,
    employee,
    topology,
    probe,
    cleanup,
    preserved,
  };
  assert.ok(Object.hasOwn(commands, action));
  await commands[action]();
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv[2]).catch(() => {
    console.error(
      "Office installation stage failed; no credentials or raw upstream errors are reported.",
    );
    process.exitCode = 1;
  });
}
