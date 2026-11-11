import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  CLOSE_REASONS,
  SOURCE_STATUS_BUCKETS,
} from "../../runtime/office-gateway/protocol.mjs";

const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : 0;
export function sanitizeGatewayStatus(value) {
  if (!value || value.ok !== true) return { available: false };
  return {
    available: true,
    attempted: count(value.attempted),
    connected: count(value.connected),
    active: count(value.active),
    holds: count(value.holds),
    closed: Object.fromEntries(
      CLOSE_REASONS.map((key) => [key, count(value.closed?.[key])]),
    ),
    source: Object.fromEntries(
      ["cfi", "acl"].map((stage) => [
        stage,
        Object.fromEntries(
          SOURCE_STATUS_BUCKETS.map((key) => [
            key,
            count(value.source?.[stage]?.[key]),
          ]),
        ),
      ]),
    ),
  };
}
export function collectGatewayStatus(container) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container || ""))
    return { available: false };
  // The secret stays inside the named container. Neither argv nor captured output contains it.
  const script = `import{readFileSync}from'node:fs';try{const secret=readFileSync(process.env.HYPER_OFFICE_GATEWAY_GUARD_SECRET_FILE,'utf8').trim();const r=await fetch('http://127.0.0.1:9982/status',{method:'POST',headers:{'content-type':'application/json','x-hyper-office-guard-secret':secret},body:'{}',signal:AbortSignal.timeout(3000)});if(!r.ok)process.exitCode=1;else process.stdout.write(JSON.stringify(await r.json()))}catch{process.exitCode=1}`;
  const result = spawnSync(
    "docker",
    ["exec", container, "node", "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 16384,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) return { available: false };
  try {
    return sanitizeGatewayStatus(JSON.parse(result.stdout));
  } catch {
    return { available: false };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(
    JSON.stringify({ office_gateway: collectGatewayStatus(process.argv[2]) }),
  );
