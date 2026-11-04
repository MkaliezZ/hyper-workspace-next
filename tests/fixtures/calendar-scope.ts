import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Subject } from "@hyper/contracts";
import { CalendarCommandInput } from "@hyper/contracts/calendar";
import type { Database } from "../../apps/api/src/db/database.js";
import { CalendarService } from "../../apps/api/src/core/calendar.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
import { requireNextcloud } from "../../apps/api/src/providers/nextcloud.js";
import { CalDavFixture } from "./caldav.js";

/** Isolated synthetic employee credentials and CalDAV, never a company endpoint. */
export async function createCalendarScope(db: Database) {
  const source = new CalDavFixture(),
    workspaceId = randomUUID();
  const server = createServer((req, res) => {
    void source.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const env = {
    NEXTCLOUD_URL: base,
    NEXTCLOUD_INTERNAL_URL: base,
    NEXTCLOUD_WORKSPACE_ID: workspaceId,
    NEXTCLOUD_MEMBER_GROUP: "members",
    NEXTCLOUD_BOOTSTRAP_ADMIN_IDS: "[]",
    NEXTCLOUD_CALENDAR_ENABLED: "true",
    CREDENTIAL_MASTER_KEY: "ab".repeat(32),
  };
  const original = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Synthetic calendar run')",
    [workspaceId],
  );
  const actors: Subject[] = [];
  for (const uid of ["alice", "bob"]) {
    const actor: Subject = {
      id: randomUUID(),
      workspaceId,
      name: uid,
      role: uid === "bob" ? "admin" : "member",
      demo: false,
      identityCredentialId: randomUUID(),
    };
    const identityId = randomUUID(),
      password = "synthetic-calendar-password-" + randomUUID();
    source.add(uid, password);
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      actor.id,
      uid,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
      [workspaceId, actor.id, actor.role],
    );
    await db.pool.query(
      "INSERT INTO cw_external_identities(id,provider_key,remote_uid,user_id,workspace_id)VALUES($1,$2,$3,$4,$5)",
      [identityId, requireNextcloud().providerKey, uid, actor.id, workspaceId],
    );
    await db.pool.query(
      "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc)VALUES($1,$2,$3,$4)",
      [
        actor.identityCredentialId,
        identityId,
        uid,
        new Vault().encrypt(password),
      ],
    );
    actors.push(actor);
  }
  return {
    source,
    actor: actors[0]!,
    peer: actors[1]!,
    service: new CalendarService(db),
    create: () =>
      CalendarCommandInput.parse({
        operation: "create",
        calendarId: "personal",
        idempotencyKey: randomUUID(),
        draft: {
          title: "Synthetic private calendar event",
          description: "Untrusted source data",
          location: "Synthetic room",
          interval: {
            kind: "timed",
            start: "2026-11-04T01:00:00Z",
            end: "2026-11-04T02:00:00Z",
          },
        },
      }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      for (const [k, v] of original) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
