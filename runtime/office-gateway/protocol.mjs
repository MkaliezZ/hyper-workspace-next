import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const CLOSE_REASONS = [
  "client_closed",
  "client_error",
  "client_end",
  "upstream_closed",
  "upstream_error",
  "upstream_end",
  "upstream_handshake",
  "upstream_timeout",
  "authorization_source_denied",
  "authorization_source_identity",
  "authorization_source_response",
  "authorization_source_unavailable",
  "authorization_failed",
  "buffer_limit",
  "hold_timeout",
  "shutdown",
  "closed",
];
export const SOURCE_STATUS_BUCKETS = [
  "200",
  "400",
  "401",
  "403",
  "404",
  "409",
  "429",
  "500",
  "502",
  "503",
  "504",
  "other",
  "transport",
];

export class GuardError extends Error {
  constructor(code = "denied", status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function demand(condition, code = "denied", status = 403) {
  if (!condition) throw new GuardError(code, status);
}
export function origin(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new GuardError("configuration", 500);
  }
  demand(
    ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash,
    "configuration",
    500,
  );
  return u.origin;
}
function integer(env, key, fallback, min, max) {
  const n = Number(env[key] ?? fallback);
  demand(Number.isSafeInteger(n) && n >= min && n <= max, "configuration", 500);
  return n;
}
export function configuration(env = process.env) {
  const prefix = "HYPER_OFFICE_GATEWAY_";
  const get = (key) => env[prefix + key];
  const publicOrigin = origin(get("PUBLIC_ORIGIN"));
  const sourceOrigin = origin(get("SOURCE_ORIGIN"));
  const secret = readFileSync(get("GUARD_SECRET_FILE"), "utf8").trim();
  demand(/^[A-Za-z0-9_-]{32,256}$/.test(secret), "configuration", 500);
  return {
    publicOrigin,
    sourceOrigin,
    secret,
    internalOrigin: origin(get("INTERNAL_ORIGIN")),
    backendOrigin: origin(get("BACKEND")),
    sourceInternalOrigin: origin(get("SOURCE_INTERNAL_ORIGIN")),
    wopiOrigin: origin(get("WOPI_ORIGIN") || sourceOrigin),
    bindHost: get("BIND_HOST") || "0.0.0.0",
    port: integer(env, prefix + "PORT", 9981, 1, 65535),
    controlPort: integer(env, prefix + "CONTROL_PORT", 9982, 1, 65535),
    leaseMs: integer(env, prefix + "LEASE_MS", 1000, 100, 5000),
    checkTimeoutMs: integer(env, prefix + "CHECK_TIMEOUT_MS", 1000, 100, 5000),
    holdMs: integer(env, prefix + "HOLD_MS", 10000, 1000, 30000),
    maxViews: integer(env, prefix + "MAX_VIEWS", 64, 1, 256),
    maxBuffer: 256 * 1024,
    maxBody: 64 * 1024,
    requestTimeoutMs: 10000,
  };
}
export function secretMatches(input, expected) {
  if (typeof input !== "string") return false;
  const a = Buffer.from(input),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function uniqueParams(value) {
  const params = new URLSearchParams(value);
  const names = new Set();
  for (const [key, item] of params) {
    demand(
      !names.has(key) &&
        key.length <= 128 &&
        item.length <= 8192 &&
        !/[\x00-\x1f\x7f]/.test(key + item),
      "ambiguous_parameters",
    );
    names.add(key);
  }
  return params;
}
export function requestUrl(raw) {
  demand(
    typeof raw === "string" &&
      raw.length <= 16384 &&
      raw.startsWith("/") &&
      !raw.startsWith("//") &&
      !/[\x00-\x20\x7f\\#]/.test(raw),
    "invalid_url",
  );
  // Reject path normalization before WHATWG URL can hide dot segments.
  const rawPath = raw.split("?")[0];
  let path;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    throw new GuardError("invalid_url");
  }
  demand(
    !/[\x00-\x1f\x7f\\]/.test(path) &&
      !path.split("/").some((x) => x === "." || x === ".."),
    "invalid_url",
  );
  const url = new URL(raw, "http://gateway.invalid");
  uniqueParams(url.search);
  return url;
}
export function checkRequestHeaders(
  req,
  config,
  websocket = false,
  opaqueLaunch = false,
) {
  const singleton = new Set([
    "host",
    "origin",
    "content-length",
    "content-type",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
  ]);
  const seen = new Set();
  for (let i = 0; i < (req.rawHeaders?.length || 0); i += 2) {
    const key = req.rawHeaders[i].toLowerCase();
    if (singleton.has(key)) {
      demand(!seen.has(key), "ambiguous_headers");
      seen.add(key);
    }
  }
  const host = req.headers.host;
  demand(
    host === new URL(config.publicOrigin).host ||
      host === new URL(config.internalOrigin).host,
    "invalid_host",
  );
  const suppliedOrigin = req.headers.origin;
  demand(
    (!websocket && suppliedOrigin === undefined) ||
      (!websocket &&
        opaqueLaunch &&
        req.method === "POST" &&
        suppliedOrigin === "null") ||
      suppliedOrigin === config.publicOrigin ||
      suppliedOrigin === config.sourceOrigin,
    "invalid_origin",
  );
  demand(
    !req.headers["x-http-method-override"] &&
      !req.headers["x-original-url"] &&
      !req.headers["x-rewrite-url"],
    "invalid_headers",
  );
}
export function parseWopi(raw, config, allowParameters = false) {
  demand(
    typeof raw === "string" &&
      raw.length <= 8192 &&
      !/[\x00-\x20\x7f\\]/.test(raw),
    "invalid_wopi",
  );
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new GuardError("invalid_wopi");
  }
  demand(
    u.origin === config.wopiOrigin && !u.username && !u.password && !u.hash,
    "invalid_wopi",
  );
  const match =
    /^\/index\.php\/apps\/richdocuments\/wopi\/files\/([0-9]+(?:_[A-Za-z0-9_-]+)?)$/.exec(
      u.pathname,
    );
  demand(
    match &&
      !raw.includes("%") &&
      !raw.includes("/./") &&
      !raw.includes("/../"),
    "invalid_wopi",
  );
  const params = uniqueParams(u.search);
  demand(allowParameters || params.size === 0, "invalid_wopi");
  return {
    fileId: match[1],
    wopi: u.origin + u.pathname,
    path: u.pathname,
    params,
  };
}
function tokenValue(params) {
  const token = params.get("access_token");
  demand(
    typeof token === "string" &&
      token.length >= 1 &&
      token.length <= 4096 &&
      /^[A-Za-z0-9._~-]+$/.test(token),
    "invalid_token",
  );
  return token;
}
const WS_PARAMETERS = new Set([
  "WOPISrc",
  "access_token",
  "access_token_ttl",
  "permission",
  "compat",
  "RouteToken",
  "ReconnectToken",
]);
function allowedWsParameters(params) {
  for (const key of params.keys())
    demand(WS_PARAMETERS.has(key), "unsupported_parameters");
  const ttl = params.get("access_token_ttl");
  demand(ttl === null || /^\d{1,16}$/.test(ttl), "invalid_token");
  const permission = params.get("permission");
  demand(
    permission === null || ["edit", "view", "readonly"].includes(permission),
    "invalid_permission",
  );
  const compat = params.get("compat");
  demand(
    compat === null || compat === "" || compat === "/ws",
    "unsupported_transport",
  );
}
export function websocketBinding(raw, config) {
  const u = requestUrl(raw);
  const outer = uniqueParams(u.search);
  allowedWsParameters(outer);
  let binding, params;
  if (u.pathname === "/cool/ws") {
    binding = parseWopi(outer.get("WOPISrc"), config, true);
    params = new URLSearchParams(outer);
    for (const [key, value] of binding.params) {
      demand(!params.has(key), "ambiguous_parameters");
      params.set(key, value);
    }
  } else {
    const match = /^\/cool\/([^/]+)\/ws$/.exec(u.pathname);
    demand(match, "unsupported_transport");
    let source;
    try {
      source = decodeURIComponent(match[1]);
    } catch {
      throw new GuardError("invalid_wopi");
    }
    binding = parseWopi(source, config, true);
    params = new URLSearchParams(binding.params);
    for (const [key, value] of outer) {
      if (key === "WOPISrc")
        demand(parseWopi(value, config).wopi === binding.wopi, "invalid_wopi");
      else {
        demand(!params.has(key), "ambiguous_parameters");
        params.set(key, value);
      }
    }
  }
  allowedWsParameters(params);
  const token = tokenValue(params);
  // One canonical form prevents different URL parsers from choosing different identities.
  // Reconnect/route hints never bypass a fresh session authorization.
  const canonical = new URLSearchParams({
    WOPISrc: binding.wopi,
    access_token: token,
  });
  if (params.has("access_token_ttl"))
    canonical.set("access_token_ttl", params.get("access_token_ttl"));
  if (params.has("permission"))
    canonical.set("permission", params.get("permission"));
  canonical.set("compat", "");
  return { ...binding, token, backendPath: "/cool/ws?" + canonical.toString() };
}
export function launchBinding(url, body, config) {
  const query = uniqueParams(url.search);
  const params = uniqueParams(body.toString("utf8"));
  demand(
    !params.has("WOPISrc") &&
      !query.has("access_token") &&
      !query.has("access_header") &&
      !params.has("access_header"),
    "ambiguous_parameters",
  );
  const binding = parseWopi(query.get("WOPISrc"), config);
  return { ...binding, token: tokenValue(params) };
}
export function publicRoute(url, method) {
  if (
    method === "GET" &&
    ["/hosting/discovery", "/hosting/capabilities"].includes(url.pathname)
  )
    return "static";
  demand(
    /^\/browser\/[A-Za-z0-9_-]+\//.test(url.pathname),
    "unsupported_route",
  );
  const decoded = decodeURIComponent(url.pathname);
  demand(
    !decoded.includes("%") &&
      !decoded.includes("//") &&
      !/(?:^|\/)admin[^/]*(?:\/|$)/i.test(decoded),
    "unsupported_route",
  );
  demand(
    !/\/(?:cool-qt|cool-preview)\.html$/.test(decoded),
    "unsupported_route",
  );
  if (/\/cool\.html$/.test(decoded)) {
    demand(method === "POST", "unsupported_method");
    return "launch";
  }
  demand(method === "GET" || method === "HEAD", "unsupported_method");
  return "static";
}
