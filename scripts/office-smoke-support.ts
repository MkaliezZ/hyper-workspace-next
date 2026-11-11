/** No model calls or process startup: helpers for the explicit supplier harness. */
type CleanupReport = { status: string; cleanupFailures?: string[] };
type Cleanup = () => unknown | Promise<unknown>;

export async function finalizeOfficeSmoke(input: {
  report: CleanupReport;
  clearCredential?: Cleanup;
  closeSource?: Cleanup;
  closeDatabase: Cleanup;
  restoreEnvironment: Cleanup;
  saveReport: Cleanup;
}) {
  const failures: string[] = [];
  async function attempt(code: string, action?: Cleanup) {
    if (!action) return;
    try {
      await action();
    } catch {
      // Cleanup errors may contain a connection string, key or source response.
      // Retain only our fixed step identifier, never the error or its message.
      failures.push(code);
      input.report.status = "failed";
    }
  }
  await attempt("model_credential_clear", input.clearCredential);
  await attempt("source_close", input.closeSource);
  await attempt("database_close", input.closeDatabase);
  await attempt("environment_restore", input.restoreEnvironment);
  input.report.cleanupFailures = failures;
  // Persistence is last: a failed disk write cannot prevent resource cleanup,
  // and a persisted success cannot precede a cleanup failure.
  await attempt("report_write", input.saveReport);
  return { status: input.report.status, cleanupFailures: [...failures] };
}

export function officeFixtureEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LD_LIBRARY_PATH",
  ]) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return result;
}
