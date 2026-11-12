/** Optional, unauthenticated transport warmup. Never a model verification or generation. */
export async function preflightTransport(
  value,
  { attempts = 3, timeoutMs = 15000, log = console.log } = {},
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid worker transport preflight URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/models")
  )
    throw new Error(
      "Worker preflight requires an HTTP(S) /models URL without credentials, query or fragment.",
    );
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 3 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15000
  )
    throw new Error("Invalid worker transport preflight limits.");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Drain small model-list/error bodies to reuse the connection; bound large ones.
      const reader = response.body?.getReader();
      if (reader) {
        let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 65536) {
              await reader.cancel();
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      const result = {
        workerTransportPreflight: true,
        attempt,
        transportReached: true,
        httpStatus: response.status,
        modelVerified: false,
      };
      log(JSON.stringify(result));
      return result;
    } catch (error) {
      const code = error?.cause?.code;
      log(
        JSON.stringify({
          workerTransportPreflight: true,
          attempt,
          transportReached: false,
          modelVerified: false,
          error: ["TypeError", "AbortError", "TimeoutError"].includes(
            error?.name,
          )
            ? error.name
            : "Error",
          ...(typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
            ? { code }
            : {}),
        }),
      );
    }
  }
  return { transportReached: false, modelVerified: false };
}

if (process.env.HYPER_WORKER_PREFLIGHT_URL)
  await preflightTransport(process.env.HYPER_WORKER_PREFLIGHT_URL);
