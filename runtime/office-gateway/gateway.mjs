import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  GuardError,
  demand,
  configuration,
  secretMatches,
  requestUrl,
  checkRequestHeaders,
  websocketBinding,
  launchBinding,
  publicRoute,
} from "./protocol.mjs";

const SECRET_HEADER = "x-hyper-office-guard-secret";
const transport = (url) => (url.protocol === "https:" ? https : http);
const endpoint = (base, path) => new URL(path, base);
const safeFailure = (error) =>
  error instanceof GuardError ? error : new GuardError("unavailable", 503);
function reply(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
function readBody(req, max, timeout) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(
      () => finish(new GuardError("request_timeout", 408)),
      timeout,
    );
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("error", error);
      req.off("aborted", aborted);
    };
    const finish = (err) => {
      cleanup();
      if (err) {
        req.pause();
        reject(err);
      } else resolve(Buffer.concat(chunks));
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > max) finish(new GuardError("request_too_large", 413));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const error = () => finish(new GuardError("request_failed", 400));
    const aborted = error;
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    req.once("aborted", aborted);
  });
}
async function sourceJson(config, path, body, signal) {
  const url = endpoint(config.sourceInternalOrigin, path);
  return new Promise((resolve, reject) => {
    const bytes =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = transport(url).request(
      url,
      {
        method: bytes ? "POST" : "GET",
        signal,
        headers: {
          host: new URL(config.sourceOrigin).host,
          accept: "application/json",
          ...(bytes
            ? {
                [SECRET_HEADER]: config.secret,
                "content-type": "application/json",
                "content-length": bytes.length,
              }
            : {}),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new GuardError("source_denied"));
          return;
        }
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 65536) {
            response.destroy();
            reject(new GuardError("source_response"));
          } else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(new GuardError("source_unavailable", 503)),
        );
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new GuardError("source_response"));
          }
        });
      },
    );
    request.on("error", () =>
      reject(new GuardError("source_unavailable", 503)),
    );
    request.end(bytes);
  });
}
async function authorize(config, binding, signal) {
  const timeout = AbortSignal.timeout(config.checkTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const cfiPath =
    binding.path + "?access_token=" + encodeURIComponent(binding.token);
  // CFI binds this token to the WOPI identity. Its historical canwrite is not current ACL.
  const cfi = await sourceJson(config, cfiPath, undefined, combined);
  demand(
    cfi &&
      typeof cfi.UserId === "string" &&
      cfi.UserId.length > 0 &&
      cfi.UserId.length <= 512 &&
      typeof cfi.UserCanWrite === "boolean",
    "source_identity",
  );
  const acl = await sourceJson(
    config,
    "/index.php/apps/hyper_office_guard/check",
    {
      fileId: binding.fileId,
      token: binding.token,
    },
    combined,
  );
  demand(
    acl &&
      Object.keys(acl).sort().join(",") === "canRead,canWrite,fileId,userId" &&
      acl.fileId === binding.fileId &&
      acl.userId === cfi.UserId &&
      typeof acl.canRead === "boolean" &&
      typeof acl.canWrite === "boolean",
    "source_identity",
  );
  demand(acl.canRead && (!cfi.UserCanWrite || acl.canWrite), "source_denied");
  return { userId: acl.userId, canWrite: cfi.UserCanWrite && acl.canWrite };
}

class View {
  constructor(gateway, client, binding, head) {
    this.gateway = gateway;
    this.client = client;
    this.binding = binding;
    this.closed = false;
    this.identity = undefined;
    this.validUntil = 0;
    this.checking = undefined;
    this.controller = new AbortController();
    this.initialHead = head;
    this.paused = true;
    client.pause();
    client.on("error", () => this.close());
    client.on("close", () => this.close());
  }
  pause() {
    this.paused = true;
    clearTimeout(this.leaseTimer);
    this.client.pause();
    this.backend?.pause();
  }
  resume() {
    if (
      this.closed ||
      !this.backend ||
      this.gateway.holds.size ||
      this.validUntil <= Date.now()
    )
      return;
    this.paused = false;
    this.directions.forEach((direction) => direction.flush());
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(
      () => {
        this.pause();
        void this.check();
      },
      Math.max(1, this.validUntil - Date.now()),
    );
  }
  async check() {
    this.pause();
    if (this.checking) return this.checking;
    this.checking = (async () => {
      while (!this.closed) {
        const generation = this.gateway.generation;
        try {
          const current = await authorize(
            this.gateway.config,
            this.binding,
            this.controller.signal,
          );
          if (this.closed) return false;
          if (this.identity)
            demand(
              current.userId === this.identity.userId &&
                (!this.identity.canWrite || current.canWrite),
              "source_denied",
            );
          if (generation !== this.gateway.generation) continue;
          this.identity ??= current;
          this.validUntil = Date.now() + this.gateway.config.leaseMs;
          this.resume();
          return true;
        } catch {
          this.close();
          return false;
        }
      }
      return false;
    })();
    try {
      return await this.checking;
    } finally {
      this.checking = undefined;
    }
  }
  connect(backend, backendHead) {
    this.backend = backend;
    backend.pause();
    backend.on("error", () => this.close());
    backend.on("close", () => this.close());
    this.directions = [
      this.direction(this.client, backend),
      this.direction(backend, this.client),
    ];
    if (this.initialHead.length) this.directions[0].enqueue(this.initialHead);
    if (backendHead.length) this.directions[1].enqueue(backendHead);
    this.initialHead = Buffer.alloc(0);
    this.resume();
  }
  direction(input, output) {
    const view = this;
    const direction = {
      queue: [],
      bytes: 0,
      waiting: false,
      enqueue(chunk) {
        if (view.closed) return;
        this.bytes += chunk.length;
        if (
          this.bytes + output.writableLength >
          view.gateway.config.maxBuffer
        ) {
          view.close();
          return;
        }
        this.queue.push(chunk);
        this.flush();
      },
      flush() {
        if (
          view.closed ||
          view.paused ||
          this.waiting ||
          view.gateway.holds.size
        ) {
          input.pause();
          return;
        }
        if (view.validUntil <= Date.now()) {
          view.pause();
          void view.check();
          return;
        }
        while (this.queue.length) {
          if (view.paused || view.gateway.holds.size) break;
          const chunk = this.queue.shift();
          this.bytes -= chunk.length;
          // Bytes are never decoded or re-framed. Masking, fragmentation, control and binary
          // frames retain their exact byte sequence, including data coalesced with upgrade.
          if (!output.write(chunk)) {
            this.waiting = true;
            input.pause();
            return;
          }
        }
        if (!view.paused && !this.waiting && !view.gateway.holds.size)
          input.resume();
      },
    };
    input.on("data", (chunk) => direction.enqueue(chunk));
    output.on("drain", () => {
      direction.waiting = false;
      direction.flush();
    });
    input.on("end", () => view.close());
    return direction;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.leaseTimer);
    this.controller.abort();
    this.client.destroy();
    this.backend?.destroy();
    this.pendingRequest?.destroy();
    this.gateway.views.delete(this);
    this.binding.token = "";
    this.initialHead = Buffer.alloc(0);
    this.directions?.forEach((d) => {
      d.queue.length = 0;
      d.bytes = 0;
    });
  }
}

export function createGateway(config) {
  const gateway = {
    config,
    views: new Set(),
    holds: new Map(),
    finishedHolds: new Map(),
    generation: 0,
    pauseAll() {
      this.generation++;
      for (const view of this.views) view.pause();
    },
    async recheckAll() {
      const views = [...this.views];
      // A small fixed worker pool bounds the requests presented to Nextcloud.
      let next = 0,
        closed = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, views.length) }, async () => {
          while (next < views.length) {
            const view = views[next++];
            if (!(await view.check())) closed++;
          }
        }),
      );
      return {
        ok: true,
        checked: views.length,
        closed,
        held: this.holds.size > 0,
      };
    },
    rememberHold(id, state) {
      this.finishedHolds.set(id, state);
      while (this.finishedHolds.size > 256)
        this.finishedHolds.delete(this.finishedHolds.keys().next().value);
    },
  };
  const server = http.createServer(
    {
      maxHeaderSize: 32768,
      requestTimeout: config.requestTimeoutMs,
      headersTimeout: config.requestTimeoutMs,
    },
    async (req, res) => {
      req.on("error", () => {});
      res.on("error", () => {});
      try {
        checkRequestHeaders(req, config);
        const url = requestUrl(req.url);
        if (url.pathname === "/health" && req.method === "GET") {
          reply(res, 200, { ok: true, protocol: "hyper-office-gateway.v1" });
          return;
        }
        const route = publicRoute(url, req.method);
        let body;
        if (route === "launch") {
          demand(
            req.headers.origin === config.sourceOrigin ||
              req.headers.origin === config.publicOrigin,
            "invalid_origin",
          );
          demand(!gateway.holds.size, "permission_change_pending", 423);
          demand(
            req.headers["content-type"]?.split(";")[0].trim() ===
              "application/x-www-form-urlencoded",
            "unsupported_body",
            415,
          );
          body = await readBody(req, config.maxBody, config.requestTimeoutMs);
          await authorize(config, launchBinding(url, body, config));
          demand(!gateway.holds.size, "permission_change_pending", 423);
        } else
          demand(
            !req.headers["transfer-encoding"] &&
              (!req.headers["content-length"] ||
                req.headers["content-length"] === "0"),
            "unexpected_body",
          );
        const backend = endpoint(config.backendOrigin, req.url);
        const headers = { host: new URL(config.publicOrigin).host };
        for (const key of [
          "accept",
          "accept-encoding",
          "accept-language",
          "content-type",
          "if-none-match",
          "if-modified-since",
          "range",
        ]) {
          if (req.headers[key]) headers[key] = req.headers[key];
        }
        headers["x-forwarded-proto"] = new URL(
          config.publicOrigin,
        ).protocol.slice(0, -1);
        if (body) headers["content-length"] = body.length;
        const proxy = transport(backend).request(
          backend,
          { method: req.method, headers },
          (upstream) => {
            if (
              upstream.statusCode >= 300 &&
              upstream.statusCode < 400 &&
              upstream.statusCode !== 304
            ) {
              upstream.destroy();
              reply(res, 502, { error: "upstream_redirect" });
              return;
            }
            const responseHeaders = {};
            for (const [key, value] of Object.entries(upstream.headers)) {
              if (
                ![
                  "connection",
                  "keep-alive",
                  "transfer-encoding",
                  "upgrade",
                  "set-cookie",
                  "location",
                ].includes(key) &&
                value !== undefined
              )
                responseHeaders[key] = value;
            }
            if (route === "launch")
              responseHeaders["cache-control"] = "no-store";
            res.writeHead(upstream.statusCode || 502, responseHeaders);
            let bytes = 0;
            upstream.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > 64 * 1024 * 1024) {
                upstream.destroy();
                res.destroy();
              }
            });
            upstream.on("error", () => res.destroy());
            upstream.pipe(res);
          },
        );
        const timeout = setTimeout(() => {
          proxy.destroy();
          res.destroy();
        }, config.requestTimeoutMs);
        proxy.on("error", () => {
          if (!res.headersSent)
            reply(res, 502, { error: "upstream_unavailable" });
          else res.destroy();
        });
        res.on("close", () => {
          clearTimeout(timeout);
          proxy.destroy();
        });
        proxy.end(body);
      } catch (error) {
        const failure = safeFailure(error);
        if (!res.headersSent) {
          res.setHeader("connection", "close");
          reply(res, failure.status, { error: failure.code });
        } else res.destroy();
      }
    },
  );
  server.on("upgrade", async (req, socket, head) => {
    let view;
    try {
      socket.pause();
      checkRequestHeaders(req, config, true);
      demand(!gateway.holds.size, "permission_change_pending", 423);
      demand(gateway.views.size < config.maxViews, "busy", 503);
      demand(
        req.method === "GET" &&
          req.headers.upgrade?.toLowerCase() === "websocket" &&
          req.headers["sec-websocket-version"] === "13" &&
          typeof req.headers["sec-websocket-key"] === "string" &&
          /^[A-Za-z0-9+/]{22}==$/.test(req.headers["sec-websocket-key"]) &&
          !req.headers["sec-websocket-protocol"] &&
          !req.headers["transfer-encoding"] &&
          (!req.headers["content-length"] ||
            req.headers["content-length"] === "0") &&
          head.length <= config.maxBuffer,
        "invalid_upgrade",
      );
      const binding = websocketBinding(req.url, config);
      view = new View(gateway, socket, binding, head);
      gateway.views.add(view);
      if (!(await view.check())) return;
      demand(
        !gateway.holds.size && !view.closed,
        "permission_change_pending",
        423,
      );
      const backend = endpoint(config.backendOrigin, binding.backendPath);
      const key = req.headers["sec-websocket-key"];
      const headers = {
        host: new URL(config.publicOrigin).host,
        origin: req.headers.origin,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": key,
        "x-forwarded-proto": new URL(config.publicOrigin).protocol.slice(0, -1),
      };
      // Do not negotiate compression: the bounded transparent stream does not decompress frames.
      const proxy = transport(backend).request(backend, {
        method: "GET",
        headers,
      });
      view.pendingRequest = proxy;
      const timer = setTimeout(() => view.close(), config.checkTimeoutMs);
      proxy.once("upgrade", (response, upstream, upstreamHead) => {
        clearTimeout(timer);
        view.pendingRequest = undefined;
        const expected = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        if (
          view.closed ||
          gateway.holds.size ||
          view.validUntil <= Date.now() ||
          response.statusCode !== 101 ||
          response.headers["sec-websocket-accept"] !== expected ||
          response.headers["sec-websocket-extensions"] ||
          response.headers["sec-websocket-protocol"] ||
          upstreamHead.length > config.maxBuffer
        ) {
          upstream.destroy();
          view.close();
          return;
        }
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
            expected +
            "\r\n\r\n",
        );
        view.connect(upstream, upstreamHead);
      });
      proxy.once("response", (response) => {
        clearTimeout(timer);
        response.destroy();
        view.close();
      });
      proxy.once("error", () => {
        clearTimeout(timer);
        view.close();
      });
      proxy.end();
    } catch (error) {
      if (view) view.close();
      else {
        const status = safeFailure(error).status;
        socket.end(
          `HTTP/1.1 ${status} Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
      }
    }
  });
  const control = http.createServer(
    { maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000 },
    async (req, res) => {
      req.on("error", () => {});
      res.on("error", () => {});
      try {
        demand(
          secretMatches(req.headers[SECRET_HEADER], config.secret) &&
            !req.headers.origin,
          "control_denied",
        );
        demand(
          req.method === "POST" &&
            ["/pause", "/revalidate", "/invalidate"].includes(req.url),
          "unsupported_route",
        );
        demand(
          req.headers["content-type"]?.split(";")[0].trim() ===
            "application/json",
          "unsupported_body",
          415,
        );
        let body;
        try {
          body = JSON.parse((await readBody(req, 128, 3000)).toString("utf8"));
        } catch (error) {
          throw error instanceof GuardError
            ? error
            : new GuardError("invalid_body", 400);
        }
        demand(
          body && !Array.isArray(body) && typeof body === "object",
          "invalid_body",
          400,
        );
        if (req.url === "/invalidate") {
          demand(Object.keys(body).length === 0, "invalid_body", 400);
          gateway.pauseAll();
          reply(res, 200, await gateway.recheckAll());
          return;
        }
        demand(
          Object.keys(body).join(",") === "id" &&
            typeof body.id === "string" &&
            /^[a-f0-9]{32}$/.test(body.id),
          "invalid_body",
          400,
        );
        if (req.url === "/pause") {
          demand(!gateway.finishedHolds.has(body.id), "hold_finished", 409);
          demand(
            gateway.holds.has(body.id) || gateway.holds.size < 64,
            "busy",
            503,
          );
          gateway.pauseAll();
          if (!gateway.holds.has(body.id)) {
            const hold = { expired: false, timer: undefined };
            hold.timer = setTimeout(() => {
              for (const view of [...gateway.views]) view.close();
              // Keep the gate held until the authenticated mutation's completion arrives.
              // A lost completion never silently reopens access after an unknown mutation.
              hold.expired = true;
            }, config.holdMs);
            gateway.holds.set(body.id, hold);
          }
          reply(res, 200, { ok: true, held: true });
          return;
        }
        if (!gateway.holds.has(body.id)) {
          demand(
            gateway.finishedHolds.get(body.id) === "completed",
            "unknown_hold",
            409,
          );
          reply(res, 200, { ok: true, held: gateway.holds.size > 0 });
          return;
        }
        clearTimeout(gateway.holds.get(body.id).timer);
        gateway.holds.delete(body.id);
        gateway.pauseAll();
        const result = await gateway.recheckAll();
        gateway.rememberHold(body.id, "completed");
        reply(res, 200, result);
      } catch (error) {
        const failure = safeFailure(error);
        res.setHeader("connection", "close");
        reply(res, failure.status, { error: failure.code });
      }
    },
  );
  for (const listener of [server, control]) {
    listener.maxConnections = config.maxViews * 4 + 64;
    listener.on("clientError", (_error, socket) => socket.destroy());
  }
  return {
    server,
    control,
    state: gateway,
    async close() {
      for (const view of [...gateway.views]) view.close();
      for (const hold of gateway.holds.values()) clearTimeout(hold.timer);
      gateway.holds.clear();
      await Promise.all(
        [server, control].map(
          (listener) =>
            new Promise((resolve) => {
              listener.close(resolve);
              listener.closeAllConnections();
            }),
        ),
      );
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const config = configuration();
    const gateway = createGateway(config);
    gateway.server.listen(config.port, config.bindHost);
    gateway.control.listen(config.controlPort, config.bindHost);
    // No request URLs, credentials, identities, document text or upstream errors are logged.
    process.stdout.write("Office gateway started\n");
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(
        signal,
        () => void gateway.close().then(() => process.exit(0)),
      );
    gateway.server.on("error", () => {
      process.stderr.write("Office gateway listener failed\n");
      process.exit(1);
    });
    gateway.control.on("error", () => {
      process.stderr.write("Office gateway control listener failed\n");
      process.exit(1);
    });
  } catch {
    process.stderr.write("Office gateway configuration failed\n");
    process.exit(1);
  }
}
