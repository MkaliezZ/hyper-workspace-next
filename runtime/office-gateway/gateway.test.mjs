import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createGateway } from "./gateway.mjs";
import { sanitizeGatewayStatus } from "../../scripts/ci/office-gateway-diagnostics.mjs";
import {
  websocketBinding,
  requestUrl,
  publicRoute,
  checkRequestHeaders,
} from "./protocol.mjs";

const secret = "guard_test_secret_".repeat(3);
const fixtureConfig = {
  publicOrigin: "http://office.test:9981",
  internalOrigin: "http://office-gateway:9981",
  sourceOrigin: "http://source.test",
  wopiOrigin: "http://source.test",
  secret,
  leaseMs: 1000,
  checkTimeoutMs: 200,
  holdMs: 500,
  maxViews: 8,
  maxBuffer: 256 * 1024,
  maxBody: 65536,
  requestTimeoutMs: 500,
};
const wopi =
  "http://source.test/index.php/apps/richdocuments/wopi/files/42_instance";
function wsPath(token = "bob", extra = {}) {
  return (
    "/cool/ws?" +
    new URLSearchParams({
      WOPISrc: wopi,
      access_token: token,
      compat: "",
      ...extra,
    })
  );
}
function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
}
function request(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const bytes =
      body === undefined
        ? undefined
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          host: "office.test:9981",
          ...(bytes ? { "content-length": bytes.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}
async function until(predicate, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("condition timed out");
    await delay(5);
  }
}
async function fixture(t, overrides = {}) {
  const permissions = new Map(
    ["alice", "bob"].map((token) => [
      token,
      { userId: token, canRead: true, canWrite: true },
    ]),
  );
  const backendViews = new Map(),
    sockets = new Set(),
    upstreamRequests = [];
  const sourceState = {
    unavailable: false,
    wrongIdentity: false,
    redirect: false,
    stalled: false,
    calls: 0,
  };
  const backend = http.createServer((req, res) => {
    upstreamRequests.push(req.url);
    if (req.url.includes("redirect")) {
      res.writeHead(302, { location: "http://evil.test/" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("static fixture");
    }
  });
  backend.on("upgrade", (req, socket, head) => {
    const token = new URL(req.url, "http://fixture").searchParams.get(
      "access_token",
    );
    const key = createHash("sha1")
      .update(
        req.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    const record = {
      socket,
      received: head.length ? [head] : [],
      headers: req.headers,
      url: req.url,
    };
    backendViews.set(token, record);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (chunk) => record.received.push(chunk));
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: " +
        key +
        "\r\n\r\n",
    );
  });
  const source = http.createServer(async (req, res) => {
    sourceState.calls++;
    if (sourceState.stalled) return;
    if (sourceState.unavailable) {
      res.writeHead(503);
      res.end("synthetic-secret-upstream-error");
      return;
    }
    if (sourceState.redirect) {
      res.writeHead(302, { location: "http://evil.test/" });
      res.end();
      return;
    }
    const url = new URL(req.url, "http://fixture");
    let value;
    if (
      req.method === "GET" &&
      url.pathname === "/index.php/apps/richdocuments/wopi/files/42_instance"
    ) {
      const token = url.searchParams.get("access_token");
      if (!permissions.has(token)) {
        res.writeHead(403);
        res.end();
        return;
      }
      value = { UserId: token, UserCanWrite: true };
    } else if (
      req.method === "POST" &&
      url.pathname === "/index.php/apps/hyper_office_guard/check"
    ) {
      assert.equal(req.headers["x-hyper-office-guard-secret"], secret);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      const permission = permissions.get(input.token);
      if (!permission) {
        res.writeHead(403);
        res.end();
        return;
      }
      value = {
        fileId: input.fileId,
        ...permission,
        ...(sourceState.wrongIdentity ? { userId: "other" } : {}),
      };
      if (sourceState.checkGate) await sourceState.checkGate;
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  });
  const backendPort = await listen(backend),
    sourcePort = await listen(source);
  const config = {
    ...fixtureConfig,
    backendOrigin: `http://127.0.0.1:${backendPort}`,
    sourceInternalOrigin: `http://127.0.0.1:${sourcePort}`,
    ...overrides,
  };
  const gateway = createGateway(config);
  const port = await listen(gateway.server),
    controlPort = await listen(gateway.control);
  t.after(async () => {
    await gateway.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [backend, source].map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      ),
    );
  });
  const control = (path, body, headers = {}) =>
    request(controlPort, path, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-hyper-office-guard-secret": secret,
        ...headers,
      },
    });
  return {
    gateway,
    port,
    control,
    permissions,
    sourceState,
    backendViews,
    upstreamRequests,
    config,
  };
}
async function connect(
  port,
  path = wsPath(),
  headers = {},
  initial = Buffer.alloc(0),
) {
  const socket = net.connect(port, "127.0.0.1");
  const peer = { socket, chunks: [], closed: false, status: 0, headers: "" };
  socket.on("error", () => {});
  socket.on("close", () => {
    peer.closed = true;
  });
  await new Promise((resolve) => socket.once("connect", resolve));
  const all = {
    Host: "office.test:9981",
    Origin: "http://office.test:9981",
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": "MDEyMzQ1Njc4OWFiY2RlZg==",
    ...headers,
  };
  const handshake = Buffer.from(
    `GET ${path} HTTP/1.1\r\n` +
      Object.entries(all)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("") +
      "\r\n",
  );
  let buffer = Buffer.alloc(0),
    settled = false;
  await new Promise((resolve) => {
    socket.on("data", (chunk) => {
      if (settled) {
        peer.chunks.push(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      peer.headers = buffer.subarray(0, split).toString();
      peer.status = Number(peer.headers.split(" ")[1]);
      if (buffer.length > split + 4)
        peer.chunks.push(buffer.subarray(split + 4));
      settled = true;
      resolve();
    });
    socket.once("close", resolve);
    socket.write(Buffer.concat([handshake, initial]));
  });
  return peer;
}

test("binding rejects ambiguous identity, cross origin, traversal and non-WS transport", () => {
  const binding = websocketBinding(wsPath("bob"), fixtureConfig);
  assert.equal(binding.fileId, "42_instance");
  assert.equal(binding.token, "bob");
  const legacy =
    "/cool/" +
    encodeURIComponent(wopi + "?access_token=bob") +
    "/ws?WOPISrc=" +
    encodeURIComponent(wopi) +
    "&compat=/ws";
  assert.equal(
    websocketBinding(legacy, fixtureConfig).backendPath,
    binding.backendPath,
  );
  for (const raw of [
    wsPath() + "&access_token=alice",
    wsPath() + "&WOPISrc=" + encodeURIComponent(wopi),
    wsPath("bob", { WOPISrc: wopi.replace("source.test", "evil.test") }),
    wsPath("bob", { access_header: "Bearer_other" }),
    wsPath("bob", { WOPISrc: wopi + "?access_token=alice" }),
    wsPath("bob", { compat: "/session/read/1" }),
    "/cool/adminws",
    "/co/collab/ws",
    "//evil.test/cool/ws",
    "/cool/%2e%2e/adminws",
  ]) {
    assert.throws(() => websocketBinding(raw, fixtureConfig));
  }
  assert.throws(() =>
    checkRequestHeaders(
      { headers: { host: "office.test:9981" } },
      fixtureConfig,
      true,
    ),
  );
  assert.throws(() =>
    checkRequestHeaders(
      { headers: { host: "office.test:9981", origin: "http://evil.test" } },
      fixtureConfig,
      true,
    ),
  );
  assert.throws(() =>
    checkRequestHeaders(
      {
        headers: { host: "office.test:9981" },
        rawHeaders: ["Host", "a", "host", "b"],
      },
      fixtureConfig,
    ),
  );
  for (const route of [
    "/cool/clipboard",
    "/cool/preview/x/content",
    "/cool/convert-to/pdf",
    "/cool/x/download/y",
    "/cool/x/insertfile",
    "/browser/dist/admin.html",
  ]) {
    assert.throws(() => publicRoute(requestUrl(route), "GET"));
  }
});

test("HTTP exposes static resources only; launch is authenticated; redirects and independent exports are denied", async (t) => {
  const f = await fixture(t);
  assert.equal((await request(f.port, "/hosting/discovery")).status, 200);
  assert.equal((await request(f.port, "/browser/hash/cool.js")).status, 200);
  assert.equal(
    (await request(f.port, "/browser/hash/redirect.js")).status,
    502,
  );
  const count = f.upstreamRequests.length;
  for (const path of [
    "/cool/adminws",
    "/cool/convert-to/pdf",
    "/cool/clipboard",
    "/cool/preview/x/content",
    "/cool/x/download/y",
    "/browser/dist/admin.html",
  ]) {
    assert.equal((await request(f.port, path)).status, 403);
  }
  assert.equal(f.upstreamRequests.length, count);
  const path = "/browser/hash/cool.html?WOPISrc=" + encodeURIComponent(wopi);
  const launch = () =>
    request(f.port, path, {
      method: "POST",
      headers: {
        origin: "http://source.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "access_token=bob",
    });
  assert.equal((await launch()).status, 200);
  const opaqueLaunch = (body = "access_token=bob") =>
    request(f.port, path, {
      method: "POST",
      headers: {
        origin: "null",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  assert.equal((await opaqueLaunch()).status, 200);
  assert.equal((await opaqueLaunch("access_token=missing")).status, 403);
  assert.equal(
    (
      await request(f.port, path, {
        method: "POST",
        headers: {
          origin: "http://evil.test",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "access_token=bob",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(f.port, "/browser/hash/cool.js", {
        headers: { origin: "null" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(f.port, path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "access_token=bob",
      })
    ).status,
    403,
  );
  f.permissions.get("bob").canWrite = false;
  assert.equal((await launch()).status, 403);
  assert.equal((await opaqueLaunch()).status, 403);
  f.permissions.get("bob").canWrite = true;
  f.sourceState.redirect = true;
  assert.equal((await launch()).status, 403);
  assert.equal(
    (
      await request(f.port, "/hosting/discovery", {
        headers: { origin: "http://evil.test" },
      })
    ).status,
    403,
  );
});

test("upgrade uses both CFI identity and current permissions; unauthorized clients never reach CODE", async (t) => {
  const f = await fixture(t);
  assert.notEqual(
    (await connect(f.port, wsPath(), { Origin: undefined })).status,
    101,
  );
  assert.notEqual(
    (await connect(f.port, wsPath(), { Origin: "null" })).status,
    101,
  );
  assert.notEqual((await connect(f.port, wsPath("missing"))).status, 101);
  f.sourceState.wrongIdentity = true;
  assert.notEqual((await connect(f.port)).status, 101);
  f.sourceState.wrongIdentity = false;
  f.permissions.get("bob").canRead = false;
  assert.notEqual((await connect(f.port)).status, 101);
  assert.equal(f.backendViews.size, 0);
});

test("raw stream preserves fragmented, binary, control, masked and coalesced upgrade bytes", async (t) => {
  const f = await fixture(t);
  const first = Buffer.from([0x01, 0x83, 1, 2, 3, 4, 96, 96, 96]);
  const peer = await connect(
    f.port,
    wsPath(),
    { "Sec-WebSocket-Extensions": "permessage-deflate" },
    first,
  );
  assert.equal(peer.status, 101);
  const record = f.backendViews.get("bob");
  const rest = Buffer.from([
    0x80, 0x81, 4, 3, 2, 1, 99, 0x89, 0x80, 0, 0, 0, 0, 0x82, 0x82, 1, 2, 3, 4,
    9, 8,
  ]);
  peer.socket.write(rest.subarray(0, 2));
  peer.socket.write(rest.subarray(2));
  await until(
    () => Buffer.concat(record.received).length === first.length + rest.length,
  );
  assert.deepEqual(
    Buffer.concat(record.received),
    Buffer.concat([first, rest]),
  );
  assert.equal(record.headers["sec-websocket-extensions"], undefined);
  const response = Buffer.from([0x82, 3, 0, 128, 255, 0x89, 0]);
  record.socket.write(response.subarray(0, 1));
  record.socket.write(response.subarray(1));
  await until(() => Buffer.concat(peer.chunks).length === response.length);
  assert.deepEqual(Buffer.concat(peer.chunks), response);
});

test("multiple mutation holds pause both directions; revalidation closes only revoked author", async (t) => {
  const f = await fixture(t, { leaseMs: 5000 });
  const alice = await connect(f.port, wsPath("alice")),
    bob = await connect(f.port);
  const id1 = "1".repeat(32),
    id2 = "2".repeat(32);
  assert.equal((await f.control("/pause", { id: id1 })).status, 200);
  assert.equal((await f.control("/pause", { id: id2 })).status, 200);
  alice.socket.write("alice-after-pause");
  bob.socket.write("bob-after-pause");
  f.backendViews.get("alice").socket.write("server-after-pause");
  await delay(30);
  assert.equal(Buffer.concat(f.backendViews.get("alice").received).length, 0);
  assert.equal(Buffer.concat(alice.chunks).length, 0);
  assert.equal((await connect(f.port, wsPath("alice"))).status, 423);
  f.permissions.get("bob").canRead = false;
  const first = await f.control("/revalidate", { id: id1 });
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).held, true);
  await until(() => bob.closed);
  assert.equal(Buffer.concat(f.backendViews.get("bob").received).length, 0);
  assert.equal(Buffer.concat(f.backendViews.get("alice").received).length, 0);
  assert.equal((await f.control("/revalidate", { id: id2 })).status, 200);
  await until(
    () =>
      Buffer.concat(f.backendViews.get("alice").received).toString() ===
      "alice-after-pause",
  );
  await until(
    () => Buffer.concat(alice.chunks).toString() === "server-after-pause",
  );
  assert.equal(alice.closed, false);
});

test("lease catches lost notification and downgrade, source timeout closes; hold timeout never reopens", async (t) => {
  const f = await fixture(t, { leaseMs: 60, checkTimeoutMs: 60, holdMs: 90 });
  const bob = await connect(f.port);
  f.permissions.get("bob").canWrite = false;
  await until(() => bob.closed);
  f.permissions.get("bob").canWrite = true;
  const alice = await connect(f.port, wsPath("alice"));
  f.sourceState.stalled = true;
  await until(() => alice.closed);
  f.sourceState.stalled = false;
  const fresh = await connect(f.port);
  assert.equal((await f.control("/pause", { id: "3".repeat(32) })).status, 200);
  await until(() => fresh.closed);
  assert.equal((await connect(f.port)).status, 423);
  assert.equal(f.gateway.state.holds.size, 1);
  assert.equal(
    (await f.control("/revalidate", { id: "3".repeat(32) })).status,
    200,
  );
  assert.equal((await connect(f.port)).status, 101);
});

test("control authentication and bounded inputs fail without upstream secrets; no unauthenticated pause", async (t) => {
  const f = await fixture(t);
  const peer = await connect(f.port);
  assert.equal(
    (
      await f.control(
        "/pause",
        { id: "4".repeat(32) },
        { "x-hyper-office-guard-secret": "wrong" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.control(
        "/pause",
        { id: "4".repeat(32) },
        { origin: "http://source.test" },
      )
    ).status,
    403,
  );
  assert.equal(f.gateway.state.holds.size, 0);
  assert.equal(
    (await f.control("/invalidate", { token: "must-not-be-accepted" })).status,
    400,
  );
  f.sourceState.unavailable = true;
  const result = await f.control("/invalidate", {});
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).closed, 1);
  assert.equal(result.body.includes("synthetic-secret"), false);
  await until(() => peer.closed);
  const oversized = await request(
    f.port,
    "/browser/hash/cool.html?WOPISrc=" + encodeURIComponent(wopi),
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://source.test",
      },
      body: "a".repeat(65537),
    },
  );
  assert.equal(oversized.status, 413);
});

test("bounded raw buffering applies backpressure and a hold cannot be bypassed by drain", async (t) => {
  const f = await fixture(t, { leaseMs: 5000 });
  const peer = await connect(f.port);
  peer.socket.pause();
  const record = f.backendViews.get("bob"),
    view = [...f.gateway.state.views][0];
  const block = Buffer.alloc(65536, 7);
  for (let i = 0; i < 128; i++) record.socket.write(block);
  await until(() => view.directions[1].waiting || view.closed, 2000);
  assert.equal(view.closed, false);
  assert.ok(
    view.directions[1].bytes + view.client.writableLength <= f.config.maxBuffer,
  );
  const id = "5".repeat(32);
  assert.equal((await f.control("/pause", { id })).status, 200);
  peer.socket.resume();
  await delay(30);
  assert.equal(view.paused, true);
  assert.equal(view.backend.isPaused(), true);
  f.permissions.get("bob").canRead = false;
  await f.control("/revalidate", { id });
  await until(() => peer.closed);
  assert.equal(f.gateway.state.views.size, 0);
});

test("an authorization response from before a permission barrier cannot open a stale session", async (t) => {
  const f = await fixture(t, { checkTimeoutMs: 500 });
  let release;
  f.sourceState.checkGate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const opening = connect(f.port);
  await until(() => f.sourceState.calls >= 2);
  const id = "6".repeat(32);
  await f.control("/pause", { id });
  f.permissions.get("bob").canRead = false;
  const revalidating = f.control("/revalidate", { id });
  f.sourceState.checkGate = undefined;
  release();
  assert.equal((await revalidating).status, 200);
  assert.notEqual((await opening).status, 101);
  assert.equal(f.backendViews.size, 0);
});

test("slow HTTP bodies have an absolute deadline and pending upgrades count against capacity", async (t) => {
  const f = await fixture(t, { requestTimeoutMs: 60, maxViews: 1 });
  const peer = await connect(f.port);
  assert.equal((await connect(f.port, wsPath("alice"))).status, 503);
  peer.socket.destroy();
  await until(() => f.gateway.state.views.size === 0);
  const socket = net.connect(f.port, "127.0.0.1");
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  const chunks = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(
    "POST /browser/hash/cool.html?WOPISrc=" +
      encodeURIComponent(wopi) +
      " HTTP/1.1\r\nHost: office.test:9981\r\nOrigin: http://source.test\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 100\r\n\r\n",
  );
  const timer = setInterval(() => socket.write("x"), 10);
  t.after(() => clearInterval(timer));
  await until(() => Buffer.concat(chunks).toString().includes("408"));
  clearInterval(timer);
  assert.equal(f.upstreamRequests.length, 0);
});

test("denied pending authorization discards a coalesced partial frame after client disconnect", async (t) => {
  const f = await fixture(t, { checkTimeoutMs: 500 });
  let release;
  f.sourceState.checkGate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const socket = net.connect(f.port, "127.0.0.1");
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(
    Buffer.concat([
      Buffer.from(
        "GET " +
          wsPath() +
          " HTTP/1.1\r\nHost: office.test:9981\r\nOrigin: http://office.test:9981\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n\r\n",
      ),
      Buffer.from([0x81, 0x85, 1, 2]),
    ]),
  );
  await until(() => f.sourceState.calls >= 2);
  const id = "7".repeat(32);
  await f.control("/pause", { id });
  f.permissions.get("bob").canRead = false;
  socket.destroy();
  const revalidating = f.control("/revalidate", { id });
  f.sourceState.checkGate = undefined;
  release();
  await revalidating;
  await until(() => f.gateway.state.views.size === 0);
  assert.equal(f.backendViews.size, 0);
});

test("private diagnostics retain only bounded counters and distinguish authorization from socket close", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await request(f.port, "/status", { method: "POST", body: {} })).status,
    403,
  );
  assert.equal(
    (await f.control("/status", {}, { "x-hyper-office-guard-secret": "wrong" }))
      .status,
    403,
  );
  assert.equal(
    (await f.control("/status", {}, { origin: "http://source.test" })).status,
    403,
  );
  assert.equal(
    (await f.control("/status", { extra: "forbidden" })).status,
    400,
  );
  const peer = await connect(f.port);
  f.permissions.get("bob").canWrite = false;
  await f.control("/invalidate", {});
  await until(() => peer.closed);
  const response = await f.control("/status", {});
  assert.equal(response.status, 200);
  const value = sanitizeGatewayStatus(JSON.parse(response.body));
  assert.equal(value.connected, 1);
  assert.equal(value.active, 0);
  assert.equal(value.closed.authorization_source_denied, 1);
  assert.ok(value.source.cfi["200"] >= 2);
  assert.ok(value.source.acl["200"] >= 2);
  const filtered = sanitizeGatewayStatus({
    ok: true,
    token: "synthetic-secret",
    active: "synthetic-secret",
    closed: { unknown: "synthetic-secret", client_closed: 3 },
    source: { cfi: { 200: 2, unknown: "synthetic-secret" } },
  });
  assert.equal(JSON.stringify(filtered).includes("synthetic-secret"), false);
  assert.equal(filtered.closed.client_closed, 3);
  assert.equal(filtered.active, 0);
});
