import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/models`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
async function child(url?: string) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.HYPER_WORKER_PREFLIGHT_URL;
  if (url) env.HYPER_WORKER_PREFLIGHT_URL = url;
  const processChild = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(resolve("scripts/worker-transport-preflight.mjs")).href,
      "--input-type=module",
      "-e",
      "console.log('worker_started')",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  processChild.stdout.on("data", (chunk) => (stdout += chunk));
  processChild.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(processChild, "close");
  return {
    code,
    stdout,
    stderr,
    events: stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line)),
  };
}

test("Worker transport warmup is opt-in and does not run for ordinary startup or health checks", async () => {
  const result = await child();
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "worker_started");
});

test("A cold connection can recover before worker startup without a key, cookie, prompt or generation", async () => {
  let calls = 0;
  const server = await fixture((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    calls++;
    if (calls === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end('{"error":"synthetic unauthenticated connection"}');
  });
  try {
    const result = await child(server.url);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(calls >= 2 && calls <= 3);
    assert.equal(result.events.at(-1).httpStatus, 401);
    assert.equal(result.events.at(-1).transportReached, true);
    assert.ok(result.events.every((event) => event.modelVerified === false));
    assert.ok(result.stdout.endsWith("worker_started\n"));
    assert.ok(!result.stdout.includes("synthetic unauthenticated connection"));
  } finally {
    await server.close();
  }
});

test("Persistent transport failures stop after three attempts and do not prevent worker startup", async () => {
  let calls = 0;
  const server = await fixture((request) => {
    calls++;
    request.socket.destroy();
  });
  try {
    const result = await child(server.url);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.events.length, 3);
    assert.ok(
      result.events.every(
        (event) => !event.transportReached && !event.modelVerified,
      ),
    );
    assert.ok(calls <= 3);
    assert.ok(result.stdout.endsWith("worker_started\n"));
  } finally {
    await server.close();
  }
});

test("Redirects are never followed and response bodies are not logged", async () => {
  let redirected = 0;
  const server = await fixture((request, response) => {
    if (request.url?.startsWith("/private")) redirected++;
    response.writeHead(302, { Location: "/private?token=synthetic-secret" });
    response.end("synthetic-secret");
  });
  try {
    const result = await child(server.url);
    assert.equal(result.code, 0);
    assert.equal(redirected, 0);
    assert.equal(result.events.length, 3);
    assert.ok(!result.stdout.includes("synthetic-secret"));
  } finally {
    await server.close();
  }
});

test("Credential-bearing or non-model-list URLs fail without disclosing their values", async () => {
  for (const url of [
    "https://user:synthetic-secret@example.invalid/models",
    "https://example.invalid/models?key=synthetic-secret",
    "https://example.invalid/write",
  ]) {
    const result = await child(url);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Worker preflight requires/);
    assert.ok(
      !result.stdout.includes("synthetic-secret") &&
        !result.stderr.includes("synthetic-secret"),
    );
    assert.ok(!result.stdout.includes("worker_started"));
  }
});
