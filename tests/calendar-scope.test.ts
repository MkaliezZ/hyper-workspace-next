import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../apps/api/src/db/database.js";
import { createCalendarScope } from "./fixtures/calendar-scope.js";

const keys = [
  "NEXTCLOUD_URL",
  "NEXTCLOUD_INTERNAL_URL",
  "NEXTCLOUD_WORKSPACE_ID",
  "NEXTCLOUD_MEMBER_GROUP",
  "NEXTCLOUD_BOOTSTRAP_ADMIN_IDS",
  "NEXTCLOUD_CALENDAR_ENABLED",
  "CREDENTIAL_MASTER_KEY",
] as const;

for (const failAt of [1, 5]) {
  test(`Calendar fixture closes its source and restores every environment value when initialization query ${failAt} fails`, async () => {
    const original = new Map(keys.map((key) => [key, process.env[key]]));
    const failure = new Error("synthetic initialization failure");
    let sourceUrl = "";
    let queries = 0;
    try {
      for (const [index, key] of keys.entries()) {
        if (index % 2) delete process.env[key];
        else process.env[key] = "original-" + key;
      }
      const expected = keys.map((key) => [key, process.env[key]]);
      const db = {
        pool: {
          async query() {
            if (++queries === failAt) {
              sourceUrl = process.env.NEXTCLOUD_URL!;
              // Prove the allocated server is reachable before the failure.
              const response = await fetch(sourceUrl, {
                signal: AbortSignal.timeout(1000),
              });
              await response.arrayBuffer();
              throw failure;
            }
            return { rows: [] };
          },
        },
      } as unknown as Database;
      await assert.rejects(
        createCalendarScope(db),
        (error) => error === failure,
      );
      assert.equal(queries, failAt);
      assert.match(sourceUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.deepEqual(
        keys.map((key) => [key, process.env[key]]),
        expected,
      );
      await assert.rejects(
        fetch(sourceUrl, { signal: AbortSignal.timeout(1000) }),
        (error: unknown) =>
          error instanceof TypeError &&
          (error.cause as NodeJS.ErrnoException)?.code === "ECONNREFUSED",
      );
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}
