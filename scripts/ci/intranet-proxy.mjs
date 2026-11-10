// Isolated loopback TLS/proxy proof using ephemeral test keys, never company certificates.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { createServer as netServer } from "node:net";
const dir = await mkdtemp(join(tmpdir(), "hyper-intranet-ci-")),
  ip = "192.168.10.50";
const ssl = (...args) =>
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
const port = async () => {
  const s = netServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
};
let proxy;
const upstream = createServer(async (req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: ready\n\n");
    return;
  }
  const parts = [];
  for await (const p of req) parts.push(p);
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      status: "ok",
      method: req.method,
      origin: req.headers.origin,
      host: req.headers.host,
      body: Buffer.concat(parts).toString(),
    }),
  );
});
upstream.on("upgrade", (req, socket) => {
  socket.end(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      "X-Office-Upstream-Host: " +
      req.headers.host +
      "\r\n\r\n",
  );
});
try {
  ssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-noenc",
    "-days",
    "1",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-subj",
    "/CN=Ephemeral Hyper CI CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  );
  ssl(
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-noenc",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=Hyper Workspace CI",
  );
  await writeFile(
    join(dir, "extensions"),
    "subjectAltName=IP:" +
      ip +
      "\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  );
  ssl(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    "extensions",
    "-out",
    "server.pem",
  );
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const backend = upstream.address().port,
    httpsPort = await port(),
    sourcePort = await port(),
    officePort = await port();
  let template = await readFile(
    new URL("../../deploy/nginx.intranet.conf.example", import.meta.url),
    "utf8",
  );
  template = template
    .replaceAll(ip + ":443 ssl", "127.0.0.1:" + httpsPort + " ssl")
    .replaceAll(ip + ":8443 ssl", "127.0.0.1:" + sourcePort + " ssl")
    .replaceAll(
      "/etc/hyper-workspace/tls/server-chain.pem",
      join(dir, "server.pem"),
    )
    .replaceAll("/etc/hyper-workspace/tls/server.key", join(dir, "server.key"))
    .replaceAll("http://127.0.0.1:8180", "http://127.0.0.1:" + backend)
    .replaceAll("http://127.0.0.1:8090", "http://127.0.0.1:" + backend);
  const office = (
    await readFile(
      new URL(
        "../../deploy/nginx.office.intranet.conf.example",
        import.meta.url,
      ),
      "utf8",
    )
  )
    .replaceAll(ip + ":8444 ssl", "127.0.0.1:" + officePort + " ssl")
    .replaceAll(
      "/etc/hyper-workspace/tls/server-chain.pem",
      join(dir, "server.pem"),
    )
    .replaceAll("/etc/hyper-workspace/tls/server.key", join(dir, "server.key"))
    .replaceAll("http://127.0.0.1:8091", "http://127.0.0.1:" + backend);
  const config = join(dir, "nginx.conf");
  await writeFile(
    config,
    "pid " +
      join(dir, "nginx.pid") +
      ";\nerror_log " +
      join(dir, "error.log") +
      ";\nevents {}\nhttp {\nclient_body_temp_path " +
      join(dir, "body") +
      ";\nproxy_temp_path " +
      join(dir, "proxy") +
      ";\n" +
      template +
      "\n" +
      office +
      "\n}\n",
  );
  execFileSync("nginx", ["-t", "-c", config, "-p", dir], { stdio: "pipe" });
  proxy = spawn("nginx", ["-c", config, "-p", dir, "-g", "daemon off;"], {
    stdio: "ignore",
  });
  const ca = await readFile(join(dir, "ca.pem"));
  const get = (p, path, options = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: p,
          path,
          ca,
          rejectUnauthorized: true,
          servername: "",
          checkServerIdentity: (_h, cert) => checkServerIdentity(ip, cert),
          headers: {
            Host: ip + (p === sourcePort ? ":8443" : ""),
            Origin: "https://" + ip,
          },
          ...options,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
            if (path === "/events") {
              resolve(body);
              req.destroy();
            }
          });
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.setTimeout(5000, () => req.destroy(Error("TLS proxy timed out")));
      req.on("error", reject);
      req.end(options.body);
    });
  let health;
  for (let i = 0; i < 50; i++) {
    try {
      health = await get(httpsPort, "/api/health");
      break;
    } catch (e) {
      if (i === 49) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).host, ip);
  const source = await get(sourcePort, "/status.php");
  assert.equal(JSON.parse(source.body).host, ip + ":8443");
  const post = await get(httpsPort, "/receipt", {
    method: "POST",
    body: "synthetic",
  });
  assert.deepEqual(JSON.parse(post.body), {
    status: "ok",
    method: "POST",
    origin: "https://" + ip,
    host: ip,
    body: "synthetic",
  });
  assert.equal(await get(httpsPort, "/events"), "data: ready\n\n");
  const officeHost = ip + ":8444";
  const discovery = await get(officePort, "/hosting/discovery", {
    headers: { Host: officeHost },
  });
  assert.equal(discovery.status, 200);
  assert.equal(JSON.parse(discovery.body).host, officeHost);
  const internal = await get(officePort, "/cool/transform-document-structure", {
    headers: { Host: officeHost },
  });
  assert.equal(internal.status, 404);
  await new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port: officePort,
      path: "/cool/synthetic/ws",
      ca,
      rejectUnauthorized: true,
      servername: "",
      checkServerIdentity: (_h, cert) => checkServerIdentity(ip, cert),
      headers: {
        Host: officeHost,
        Connection: "Upgrade",
        Upgrade: "websocket",
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      try {
        assert.equal(res.statusCode, 101);
        assert.equal(res.headers["x-office-upstream-host"], officeHost);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    req.on("response", (res) => {
      res.resume();
      reject(Error("Office proxy did not upgrade the connection"));
    });
    req.setTimeout(5000, () =>
      req.destroy(Error("Office WebSocket proxy timed out")),
    );
    req.on("error", reject);
    req.end();
  });
  console.log(
    "7 isolated TLS/proxy checks passed, including Office host preservation, private route rejection and WebSocket upgrade.",
  );
} finally {
  if (proxy && proxy.exitCode === null) {
    proxy.kill("SIGQUIT");
    await new Promise((r) => {
      const timer = setTimeout(() => {
        proxy.kill("SIGKILL");
        r();
      }, 5000);
      proxy.once("exit", () => {
        clearTimeout(timer);
        r();
      });
    });
  }
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
  await rm(dir, { recursive: true, force: true });
}
