import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { issueSession } from "../../apps/api/src/core/security.js";
import type { Subject } from "@hyper/contracts";
import { CalendarCommandInput } from "@hyper/contracts/calendar";
import { Database } from "../../apps/api/src/db/database.js";
import { CalendarService } from "../../apps/api/src/core/calendar.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
import { requireNextcloud } from "../../apps/api/src/providers/nextcloud.js";
import { CalDavFixture } from "../fixtures/caldav.js";
import ICAL from "ical.js";
import {
  expandMeetingFixture,
  meetingOverride,
} from "../fixtures/calendar-meetings.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Isolated _test database required");
const db = new Database(url),
  service = new CalendarService(db),
  fixture = new CalDavFixture(),
  workspaceId = randomUUID();
const subjects = new Map<string, Subject>();
const server = createServer((req, res) => {
  fixture.handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.CREDENTIAL_MASTER_KEY = "ab".repeat(32);
  process.env.NEXTCLOUD_CALENDAR_ENABLED = "true";
  process.env.NEXTCLOUD_URL =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  delete process.env.NEXTCLOUD_INTERNAL_URL;
  process.env.NEXTCLOUD_WORKSPACE_ID = workspaceId;
  process.env.NEXTCLOUD_MEMBER_GROUP = "members";
  process.env.NEXTCLOUD_BOOTSTRAP_ADMIN_IDS = "[]";
  await db.migrate();
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Calendar protocol fixture')",
    [workspaceId],
  );
  for (const uid of ["alice", "bob", "revoked"]) {
    const id = randomUUID(),
      identityId = randomUUID(),
      credentialId = randomUUID(),
      password = "synthetic-" + randomUUID();
    fixture.add(uid, password);
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      id,
      uid,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,'member')",
      [workspaceId, id],
    );
    await db.pool.query(
      "INSERT INTO cw_external_identities(id,provider_key,remote_uid,user_id,workspace_id)VALUES($1,$2,$3,$4,$5)",
      [identityId, requireNextcloud().providerKey, uid, id, workspaceId],
    );
    await db.pool.query(
      "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc)VALUES($1,$2,$3,$4)",
      [credentialId, identityId, uid, new Vault().encrypt(password)],
    );
    subjects.set(uid, {
      id,
      name: uid,
      workspaceId,
      role: "member",
      demo: false,
      identityCredentialId: credentialId,
    });
  }
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});
const actor = (uid = "alice") => subjects.get(uid)!;
function create() {
  fixture.mode = "ok";
  return CalendarCommandInput.parse({
    operation: "create",
    calendarId: "personal",
    idempotencyKey: randomUUID(),
    draft: {
      title: "合成日历验收",
      description: "保持版本与回执",
      location: "会议室 A",
      interval: {
        kind: "timed",
        start: "2026-11-04T01:00:00Z",
        end: "2026-11-04T02:00:00Z",
      },
    },
  });
}

test("Calendar preparation is private and idempotent; concurrent apply performs one conditional source write and readback", async () => {
  const input = create(),
    before = fixture.writes;
  const [a, b] = await Promise.all([
    service.prepare(actor(), input),
    service.prepare(actor(), input),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.state, "prepared");
  assert.equal(fixture.writes, before);
  await assert.rejects(
    service.prepare(actor(), {
      ...input,
      draft: { ...input.draft, title: "另一个目标" },
    }),
    /同一日历操作键/,
  );
  await assert.rejects(service.get(actor("bob"), a.id), /不存在/);
  await Promise.all([
    service.apply(actor(), a.id),
    service.apply(actor(), a.id),
  ]);
  const receipt = await service.get(actor(), a.id);
  assert.equal(fixture.writes, before + 1);
  assert.equal(receipt.state, "succeeded");
  assert.equal(receipt.observedResult, "matched");
  assert.ok(receipt.sourceEtag);
  assert.equal((await service.apply(actor(), a.id)).state, "succeeded");
  assert.equal(fixture.writes, before + 1);
  assert.equal((await service.history(actor("bob"))).length, 0);
});

test("Calendar project and task links remain private, versioned and replay-safe without writing to CalDAV", async () => {
  const projectId = randomUUID(),
    otherProject = randomUUID(),
    taskId = randomUUID();
  await db.pool.query(
    "INSERT INTO cw_projects(id,workspace_id,name) VALUES ($1,$3,'Calendar project'),($2,$3,'Another project')",
    [projectId, otherProject, workspaceId],
  );
  await db.pool.query(
    "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES ($1,$3,$2)",
    [randomUUID(), projectId, workspaceId],
  );
  await db.pool.query(
    "INSERT INTO cw_tasks(id,workspace_id,project_id,title,created_by) VALUES($1,$2,$3,'Schedule task',$4)",
    [taskId, workspaceId, projectId, actor().id],
  );
  const created = await service.apply(
    actor(),
    (await service.prepare(actor(), create())).id,
  );
  const event = {
    calendarId: created.calendarId,
    objectId: created.objectId,
    etag: created.sourceEtag!,
  };
  const input = {
    event,
    target: { kind: "task" as const, projectId, taskId, taskVersion: 1 },
    linked: true,
    idempotencyKey: randomUUID(),
    confirmed: true,
  };
  const copy = "bob/personal/" + event.objectId;
  fixture.objects.set(copy, {
    ...fixture.objects.get("alice/personal/" + event.objectId)!,
  });
  const writes = fixture.writes;
  const change = (patch: Record<string, unknown>) =>
    service.changeLink(actor(), {
      ...input,
      idempotencyKey: randomUUID(),
      ...patch,
    });
  try {
    await assert.rejects(change({ confirmed: false }), /true/);
    await assert.rejects(
      change({ target: { ...input.target, projectId: otherProject } }),
      /待办不存在/,
    );
    await assert.rejects(
      change({ target: { ...input.target, taskVersion: 2 } }),
      /待办版本/,
    );
    await assert.rejects(
      change({ event: { ...event, etag: '"stale"' } }),
      /日程已更新/,
    );
    const [one, two] = await Promise.all([
      service.changeLink(actor(), input),
      service.changeLink(actor(), input),
    ]);
    assert.deepEqual(one, two);
    assert.deepEqual(await service.links(actor(), event), [
      { target: input.target, label: "Schedule task" },
    ]);
    assert.deepEqual(await service.links(actor("bob"), event), []);
    await assert.rejects(
      service.changeLink(actor(), { ...input, linked: false }),
      /同一关联操作键/,
    );
    fixture.people.get("alice")!.read = false;
    try {
      const denied = (e: unknown) =>
        e instanceof Error &&
        "getStatus" in e &&
        typeof e.getStatus === "function" &&
        e.getStatus() === 404;
      await assert.rejects(service.links(actor(), event), denied);
      await assert.rejects(change({ linked: false }), denied);
    } finally {
      fixture.people.get("alice")!.read = true;
    }
    const removed = await change({ linked: false });
    assert.equal(removed.linked, false);
    assert.deepEqual(await service.changeLink(actor(), input), one);
    assert.deepEqual(await service.links(actor(), event), []);
    assert.equal(fixture.writes, writes);
  } finally {
    fixture.objects.delete(copy);
    fixture.objects.delete("alice/personal/" + event.objectId);
  }
});

test("Calendar update preserves unedited properties and rejects stale ETags; delete confirms absence", async () => {
  const input = create();
  const created = await service.apply(
    actor(),
    (await service.prepare(actor(), input)).id,
  );
  const edit = await service.prepare(actor(), {
    operation: "update",
    calendarId: "personal",
    objectId: created.objectId,
    etag: created.sourceEtag,
    scope: "series",
    patch: { title: "新标题" },
    idempotencyKey: randomUUID(),
  });
  const updated = await service.apply(actor(), edit.id);
  assert.equal(updated.state, "succeeded");
  const object = fixture.objects.get("alice/personal/" + created.objectId)!;
  assert.match(object.ical, /DESCRIPTION:保持版本与回执/);
  assert.match(object.ical, /LOCATION:会议室 A/);
  await assert.rejects(
    service.prepare(actor(), {
      operation: "delete",
      calendarId: "personal",
      objectId: created.objectId,
      etag: created.sourceEtag,
      scope: "series",
      idempotencyKey: randomUUID(),
    }),
    /日程已更新/,
  );
  const deleted = await service.apply(
    actor(),
    (
      await service.prepare(actor(), {
        operation: "delete",
        calendarId: "personal",
        objectId: created.objectId,
        etag: updated.sourceEtag,
        scope: "series",
        idempotencyKey: randomUUID(),
      })
    ).id,
  );
  assert.equal(deleted.state, "succeeded");
  assert.equal(deleted.observedResult, "absent");
  assert.equal(
    fixture.objects.has("alice/personal/" + created.objectId),
    false,
  );
});

test("One occurrence binds the current expanded source version and updates the original series without deleting it", async () => {
  const objectId = "synthetic-occurrence.ics";
  const key = "alice/personal/" + objectId;
  const series = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Fixture//EN",
    "BEGIN:VEVENT",
    "UID:synthetic-occurrence",
    "DTSTAMP:20261101T000000Z",
    "DTSTART:20261104T010000Z",
    "DTEND:20261104T020000Z",
    "SUMMARY:Original series",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "EXDATE:20261125T010000Z",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  fixture.objects.set(key, { ical: series, version: 1 });
  fixture.mode = "ok";
  fixture.expand = (ical) => {
    if (ical !== series && !ical.includes("UID:synthetic-occurrence"))
      return ical;
    return series
      .replace("DTSTART:20261104T010000Z", "DTSTART:20261111T010000Z")
      .replace("DTEND:20261104T020000Z", "DTEND:20261111T020000Z")
      .replace("RRULE:FREQ=WEEKLY;COUNT=4", "RECURRENCE-ID:20261111T010000Z")
      .replace("EXDATE:20261125T010000Z\r\n", "");
  };
  try {
    const plan = {
      operation: "update",
      scope: "occurrence",
      calendarId: "personal",
      objectId,
      etag: '"v1"',
      idempotencyKey: randomUUID(),
      target: {
        recurrenceId: "2026-11-11T01:00:00Z",
        window: { start: "2026-11-11T00:00:00Z", end: "2026-11-12T00:00:00Z" },
      },
      change: { operation: "edit", patch: { title: "One instance" } },
    };
    const before = fixture.writes;
    await assert.rejects(
      service.prepare(actor(), {
        ...plan,
        target: { ...plan.target, recurrenceId: "2026-11-12T01:00:00Z" },
      }),
      /未找到本次/,
    );
    await assert.rejects(service.prepare(actor("bob"), plan), { status: 404 });
    const edit = await service.prepare(actor(), plan);
    assert.equal(fixture.writes, before);
    const updated = await service.apply(actor(), edit.id);
    assert.equal(updated.state, "succeeded");
    assert.match(fixture.objects.get(key)!.ical, /SUMMARY:Original series/);
    assert.match(fixture.objects.get(key)!.ical, /SUMMARY:One instance/);
    await assert.rejects(
      service.prepare(actor(), { ...plan, idempotencyKey: randomUUID() }),
      /日程已更新/,
    );
    const cancel = await service.prepare(actor(), {
      ...plan,
      idempotencyKey: randomUUID(),
      etag: updated.sourceEtag,
      change: { operation: "cancel" },
    });
    const cancelled = await service.apply(actor(), cancel.id);
    assert.equal(cancelled.state, "succeeded");
    assert.equal(fixture.writes, before + 2);
    const remaining = fixture.objects.get(key)!.ical;
    assert.match(remaining, /RRULE:FREQ=WEEKLY;COUNT=4/);
    assert.match(remaining, /EXDATE:20261125T010000Z/);
    assert.match(remaining, /EXDATE:20261111T010000Z/);
    assert.doesNotMatch(remaining, /SUMMARY:One instance|RECURRENCE-ID/);
    const target = {
      calendarId: "personal",
      objectId,
      etag: cancelled.sourceEtag,
    };
    assert.deepEqual(await service.seriesRule(actor(), target), {
      rules: ["FREQ=WEEKLY;COUNT=4"],
      simple: { frequency: "WEEKLY", interval: 1, count: 4 },
      exceptionCount: 2,
    });
    const rulePlan = {
      ...target,
      operation: "update",
      scope: "series_rule",
      idempotencyKey: randomUUID(),
    };
    await assert.rejects(
      service.prepare(actor(), {
        ...rulePlan,
        repeat: { frequency: "WEEKLY", interval: 1, count: 2 },
      }),
      /使已有单次例外失去原实例/,
    );
    await assert.rejects(
      service.prepare(actor(), { ...rulePlan, repeat: null }),
      /先处理已有单次例外/,
    );
    const rule = await service.prepare(actor(), {
      ...rulePlan,
      repeat: { frequency: "WEEKLY", interval: 1, count: 5 },
    });
    const extended = await service.apply(actor(), rule.id);
    assert.equal(extended.state, "succeeded");
    assert.equal(fixture.writes, before + 3);
    const unchangedExceptions = fixture.objects.get(key)!.ical;
    assert.match(unchangedExceptions, /RRULE:FREQ=WEEKLY;COUNT=5/);
    assert.match(unchangedExceptions, /EXDATE:20261125T010000Z/);
    assert.match(unchangedExceptions, /EXDATE:20261111T010000Z/);
    await assert.rejects(service.seriesRule(actor(), target), /重复日程已更新/);
  } finally {
    fixture.expand = undefined;
    fixture.objects.delete(key);
  }
});

test("Calendar invitations bind current company identities and reconcile one lost write without resending", async () => {
  fixture.addresses.set("alice", "alice@example.invalid");
  fixture.addresses.set("bob", "bob@example.invalid");
  assert.ok(
    (await service.calendars(actor())).find((c) => c.id === "personal")
      ?.canInvite,
  );
  const invitation = { ...create(), invitees: ["bob"] };
  const before = fixture.writes;
  await assert.rejects(
    service.prepare(actor(), { ...invitation, invitees: ["outsider"] }),
    /当前企业成员/,
  );
  const stale = await service.prepare(actor(), invitation);
  fixture.people.get("bob")!.member = false;
  const rejected = await service.apply(actor(), stale.id);
  assert.equal(rejected.state, "failed");
  assert.equal(fixture.writes, before);
  fixture.people.get("bob")!.member = true;
  const prepared = await service.prepare(actor(), {
    ...invitation,
    idempotencyKey: randomUUID(),
  });
  assert.equal(fixture.writes, before);
  const key = "alice/personal/" + prepared.objectId;
  fixture.afterWrite = async () => {
    const saved = fixture.objects.get(key)!;
    saved.ical = saved.ical.replace(
      "ATTENDEE;",
      "ATTENDEE;SCHEDULE-STATUS=1.2;",
    );
  };
  fixture.mode = "drop-after";
  try {
    const applied = await service.apply(actor(), prepared.id);
    assert.equal(applied.state, "succeeded");
    assert.equal(applied.observedResult, "matched");
    assert.deepEqual(applied.invitations, [
      { employeeUid: "bob", delivery: "delivered", response: "needs_action" },
    ]);
    assert.ok(!JSON.stringify(applied).includes("@example.invalid"));
    assert.equal(
      (await service.reconcile(actor(), prepared.id)).state,
      "succeeded",
    );
    assert.equal(
      (await service.apply(actor(), prepared.id)).state,
      "succeeded",
    );
    assert.equal(fixture.writes, before + 1);
    assert.match(
      fixture.objects.get(key)!.ical,
      /ORGANIZER:mailto:alice@example.invalid/,
    );
    assert.match(
      fixture.objects.get(key)!.ical.replace(/\r\n[ \t]/g, ""),
      /ATTENDEE;[^\r\n]*:mailto:bob@example.invalid/,
    );
    await assert.rejects(
      service.prepare(actor(), {
        operation: "delete",
        scope: "series",
        calendarId: "personal",
        objectId: prepared.objectId,
        etag: applied.sourceEtag,
        idempotencyKey: randomUUID(),
      }),
      /专用排期服务/,
    );
  } finally {
    fixture.mode = "ok";
    fixture.objects.delete(key);
    fixture.addresses.clear();
  }
});

test("Only the attendee can reply and only the organizer can cancel a current meeting", async () => {
  fixture.addresses.set("alice", "alice@example.invalid");
  fixture.addresses.set("bob", "bob@example.invalid");
  const prepared = await service.prepare(actor(), {
    ...create(),
    invitees: ["bob"],
  });
  const saved = await service.apply(actor(), prepared.id);
  assert.equal(saved.state, "succeeded");
  const key = "alice/personal/" + prepared.objectId;
  const copy = "bob/personal/" + prepared.objectId;
  fixture.objects.set(copy, { ...fixture.objects.get(key)! });
  const target = {
    calendarId: "personal",
    objectId: prepared.objectId,
    etag: saved.sourceEtag!,
  };
  const command = {
    ...target,
    operation: "update",
    scope: "meeting",
    idempotencyKey: randomUUID(),
  };
  try {
    assert.equal((await service.meeting(actor(), target)).role, "organizer");
    assert.equal(
      (await service.meeting(actor("bob"), target)).ownResponse,
      "needs_action",
    );
    await assert.rejects(
      service.prepare(actor("bob"), {
        ...command,
        change: { operation: "cancel" },
      }),
      /只有来源会议组织者/,
    );
    await assert.rejects(
      service.prepare(actor(), {
        ...command,
        change: { operation: "reply", response: "ACCEPTED" },
      }),
      /仅可回复本人/,
    );
    const reply = await service.prepare(actor("bob"), {
      ...command,
      change: { operation: "reply", response: "ACCEPTED" },
    });
    const replied = await service.apply(actor("bob"), reply.id);
    assert.equal(replied.state, "succeeded");
    assert.equal(replied.meeting?.ownResponse, "accepted");
    assert.equal(
      (
        await service.meeting(actor("bob"), {
          ...target,
          etag: replied.sourceEtag,
        })
      ).ownResponse,
      "accepted",
    );
    await assert.rejects(service.meeting(actor("bob"), target), /会议已更新/);
    const editChange = {
      operation: "edit",
      patch: {
        title: "Organizer rescheduled",
        interval: {
          kind: "timed",
          start: "2026-11-04T03:00:00Z",
          end: "2026-11-04T04:00:00Z",
        },
      },
    };
    await assert.rejects(
      service.prepare(actor("bob"), {
        ...command,
        etag: replied.sourceEtag,
        idempotencyKey: randomUUID(),
        change: editChange,
      }),
      /只有来源会议组织者/,
    );
    const edit = await service.prepare(actor(), {
      ...command,
      idempotencyKey: randomUUID(),
      change: editChange,
    });
    const edited = await service.apply(actor(), edit.id);
    assert.equal(edited.state, "succeeded");
    assert.equal(edited.meeting?.title, "Organizer rescheduled");
    assert.match(fixture.objects.get(key)!.ical, /DTSTART:20261104T030000Z/);
    assert.match(
      fixture.objects.get(key)!.ical,
      /ORGANIZER:mailto:alice@example.invalid/,
    );
    await assert.rejects(
      service.prepare(actor(), { ...command, change: { operation: "cancel" } }),
      /日程已更新/,
    );
    const cancel = await service.prepare(actor(), {
      ...command,
      etag: edited.sourceEtag,
      change: { operation: "cancel" },
    });
    const cancelled = await service.apply(actor(), cancel.id);
    assert.equal(cancelled.state, "succeeded");
    assert.equal(cancelled.meeting?.cancelled, true);
    assert.match(fixture.objects.get(key)!.ical, /STATUS:CANCELLED/);
    await assert.rejects(
      service.prepare(actor(), {
        ...command,
        etag: cancelled.sourceEtag,
        idempotencyKey: randomUUID(),
        change: { operation: "cancel" },
      }),
      /已经取消/,
    );
  } finally {
    fixture.objects.delete(key);
    fixture.objects.delete(copy);
    fixture.addresses.clear();
  }
});

test("Recurring meeting replies verify every exception; whole-series reschedule and lost writes retain scoped facts", async () => {
  fixture.addresses.set("alice", "alice@example.invalid");
  fixture.addresses.set("bob", "bob@example.invalid");
  const input = create();
  assert.equal(input.operation, "create");
  if (input.operation !== "create")
    throw new Error("Fixture creation required");
  const prepared = await service.prepare(actor(), {
    ...input,
    invitees: ["bob"],
    draft: {
      ...input.draft,
      repeat: { frequency: "WEEKLY", interval: 1, count: 3 },
    },
  });
  await service.apply(actor(), prepared.id);
  const key = "alice/personal/" + prepared.objectId,
    copy = "bob/personal/" + prepared.objectId;
  const original = fixture.objects.get(key)!;
  original.ical = meetingOverride(
    original.ical,
    "2026-11-11T01:00:00Z",
    "2026-11-11T05:00:00Z",
    "2026-11-11T06:00:00Z",
  );
  original.version++;
  fixture.objects.set(copy, { ...original });
  fixture.expand = expandMeetingFixture;
  const base = {
    calendarId: "personal",
    objectId: prepared.objectId,
    operation: "update",
    scope: "meeting",
  };
  const version = (which: string) =>
    '"v' + fixture.objects.get(which)!.version + '"';
  const target = {
    scope: "occurrence",
    recurrenceId: "2026-11-11T01:00:00Z",
    window: { start: "2026-11-11T00:00:00Z", end: "2026-11-12T00:00:00Z" },
  };
  try {
    const before = fixture.writes;
    await assert.rejects(
      service.prepare(actor("bob"), {
        ...base,
        etag: version(copy),
        idempotencyKey: randomUUID(),
        change: {
          operation: "reply",
          response: "DECLINED",
          target: { ...target, recurrenceId: "2026-11-12T01:00:00Z" },
        },
      }),
      /未找到本次/,
    );
    const reply = await service.prepare(actor("bob"), {
      ...base,
      etag: version(copy),
      idempotencyKey: randomUUID(),
      change: { operation: "reply", response: "DECLINED", target },
    });
    assert.equal(fixture.writes, before);
    await assert.rejects(service.get(actor(), reply.id), /不存在/);
    const saved = await service.apply(actor("bob"), reply.id);
    assert.equal(saved.state, "succeeded");
    assert.deepEqual(saved.meeting?.responses, [
      { recurrenceId: null, response: "needs_action" },
      { recurrenceId: target.recurrenceId, response: "declined" },
    ]);
    const query = {
      calendarId: base.calendarId,
      objectId: base.objectId,
      etag: version(copy),
      target: { recurrenceId: target.recurrenceId, window: target.window },
    };
    assert.equal(
      (await service.meeting(actor("bob"), query)).selectedResponse,
      "declined",
    );
    const whole = await service.prepare(actor("bob"), {
      ...base,
      etag: version(copy),
      idempotencyKey: randomUUID(),
      change: {
        operation: "reply",
        response: "ACCEPTED",
        target: { scope: "series" },
      },
    });
    let expected: string | undefined;
    fixture.afterWrite = async () => {
      const stored = fixture.objects.get(copy)!;
      expected = stored.ical;
      const root = new ICAL.Component(ICAL.parse(stored.ical));
      root
        .getAllSubcomponents("vevent")[1]!
        .getFirstProperty("attendee")!
        .setParameter("partstat", "DECLINED");
      stored.ical = root.toString() + "\r\n";
    };
    const uncertain = await service.apply(actor("bob"), whole.id);
    assert.equal(
      uncertain.state,
      "recovery_required",
      "Master accepted alone is not a verified series reply",
    );
    assert.equal(fixture.writes, before + 2);
    await service.apply(actor("bob"), whole.id);
    assert.equal(
      fixture.writes,
      before + 2,
      "Unknown outcome cannot issue another PUT",
    );
    fixture.objects.get(copy)!.ical = expected!;
    assert.equal(
      (await service.reconcile(actor("bob"), whole.id)).state,
      "succeeded",
    );
    assert.equal(fixture.writes, before + 2);
    const move = await service.prepare(actor(), {
      ...base,
      etag: version(key),
      idempotencyKey: randomUUID(),
      change: {
        operation: "reschedule_series",
        exceptions: "preserve_overrides",
        interval: {
          kind: "timed",
          start: "2026-11-05T02:00:00Z",
          end: "2026-11-05T03:00:00Z",
        },
      },
    });
    fixture.mode = "drop-after";
    const moved = await service.apply(actor(), move.id);
    assert.equal(
      moved.state,
      "succeeded",
      "Lost response is recovered from one conditional write",
    );
    assert.match(
      fixture.objects.get(key)!.ical,
      /RECURRENCE-ID:20261112T020000Z/,
    );
    assert.match(fixture.objects.get(key)!.ical, /DTSTART:20261111T050000Z/);
    assert.equal(fixture.writes, before + 3);
    await assert.rejects(
      service.prepare(actor(), {
        ...base,
        etag: '"v1"',
        idempotencyKey: randomUUID(),
        change: { operation: "cancel" },
      }),
      /日程已更新/,
    );
    fixture.mode = "ok";
    const blocked = await service.prepare(actor("bob"), {
      ...base,
      etag: version(copy),
      idempotencyKey: randomUUID(),
      change: {
        operation: "reply",
        response: "TENTATIVE",
        target: { scope: "series" },
      },
    });
    fixture.people.get("bob")!.write = false;
    await assert.rejects(service.apply(actor("bob"), blocked.id), /权限/);
    assert.equal(fixture.writes, before + 3);
  } finally {
    fixture.people.get("bob")!.write = true;
    fixture.expand = undefined;
    fixture.afterWrite = undefined;
    fixture.mode = "ok";
    fixture.objects.delete(key);
    fixture.objects.delete(copy);
    fixture.addresses.clear();
  }
});

test("Calendar response loss reconciles a completed source write, while an unobserved write is never replayed", async () => {
  const sent = await service.prepare(actor(), create());
  fixture.mode = "drop-after";
  const before = fixture.writes;
  const observed = await service.apply(actor(), sent.id);
  assert.equal(observed.state, "succeeded");
  assert.equal(fixture.writes, before + 1);
  fixture.mode = "ok";
  const missing = await service.prepare(actor(), create());
  fixture.mode = "drop-before";
  assert.equal(
    (await service.apply(actor(), missing.id)).state,
    "recovery_required",
  );
  fixture.mode = "ok";
  assert.equal(
    (await service.reconcile(actor(), missing.id)).state,
    "recovery_required",
  );
  assert.equal(
    (await service.apply(actor(), missing.id)).state,
    "recovery_required",
  );
  assert.equal(fixture.writes, before + 2);
});

test("Calendar post-write mismatch stays recovery_required, and conditional conflicts do not overwrite source changes", async () => {
  const command = await service.prepare(actor(), create());
  fixture.mode = "tamper";
  assert.equal(
    (await service.apply(actor(), command.id)).state,
    "recovery_required",
  );
  fixture.mode = "ok";
  const input = create();
  const saved = await service.apply(
    actor(),
    (await service.prepare(actor(), input)).id,
  );
  const edit = await service.prepare(actor(), {
    operation: "update",
    calendarId: "personal",
    objectId: saved.objectId,
    etag: saved.sourceEtag,
    scope: "series",
    patch: { title: "尝试覆盖" },
    idempotencyKey: randomUUID(),
  });
  const object = fixture.objects.get("alice/personal/" + saved.objectId)!;
  object.version++;
  object.ical = object.ical.replace("合成日历验收", "同事修改");
  const result = await service.apply(actor(), edit.id);
  assert.equal(result.state, "failed");
  assert.equal(result.error, "calendar_version_conflict");
  assert.match(object.ical, /同事修改/);
});

test("Calendar cancellation before sending prevents effects; stopping an in-flight action preserves the observed effect", async () => {
  const command = await service.prepare(actor(), create()),
    before = fixture.writes;
  assert.equal((await service.cancel(actor(), command.id)).state, "cancelled");
  assert.equal((await service.apply(actor(), command.id)).state, "cancelled");
  assert.equal(fixture.writes, before);
  const active = await service.prepare(actor(), create());
  fixture.afterWrite = async () => {
    await service.cancel(actor(), active.id);
  };
  const saved = await service.apply(actor(), active.id);
  assert.equal(saved.state, "succeeded");
  assert.equal(saved.stopRequested, true);
  assert.equal(fixture.writes, before + 1);
});

test("Calendar source read-only/revocation and member changes are enforced before writes and after reads", async () => {
  const subject = actor("revoked"),
    command = await service.prepare(subject, create()),
    before = fixture.writes;
  fixture.people.get("revoked")!.write = false;
  await assert.rejects(service.apply(subject, command.id), /操作权限/);
  assert.equal(fixture.writes, before);
  fixture.people.get("revoked")!.write = true;
  const saved = await service.apply(subject, command.id);
  assert.equal(saved.state, "succeeded");
  fixture.afterRead = async () => {
    fixture.people.get("revoked")!.read = false;
  };
  // Force readback, then remove permission while response content is still in flight.
  const edit = await service
    .prepare(subject, {
      operation: "update",
      calendarId: "personal",
      objectId: saved.objectId,
      etag: saved.sourceEtag,
      scope: "series",
      patch: { title: "撤权过程中" },
      idempotencyKey: randomUUID(),
    })
    .catch((error) => error);
  assert.ok(edit instanceof Error);
  fixture.people.get("revoked")!.read = true;
  fixture.people.get("revoked")!.member = false;
  await assert.rejects(service.history(subject), /撤销/);
  assert.equal(fixture.writes, before + 1);
});

test("Calendar HTTP endpoints authenticate actor scope, reject invented identities and require concrete write confirmation", async () => {
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const origin = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: new URL("../../apps/api/", import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: url,
      APP_ORIGIN: origin,
      API_PORT: String(port),
      API_HOST: "127.0.0.1",
      SERVE_WEB: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = (await fetch(origin + "/api/health")).ok;
      } catch {}
      if (ready) break;
      await delay(100);
    }
    assert.equal(ready, true, "Calendar HTTP API did not start");
    const token = await issueSession(
      db,
      actor().id,
      workspaceId,
      false,
      actor().identityCredentialId,
    );
    const headers = {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Origin: origin,
    };
    assert.equal((await fetch(origin + "/api/calendar/calendars")).status, 401);
    assert.equal(
      (await fetch(origin + "/api/calendar/calendars", { headers })).status,
      200,
    );
    const input = create(),
      before = fixture.writes;
    assert.equal(
      (
        await fetch(origin + "/api/calendar/commands", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...input, actorId: actor("bob").id }),
        })
      ).status,
      400,
    );
    const prepared = await fetch(origin + "/api/calendar/commands", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(prepared.status, 201);
    const receipt = await prepared.json();
    assert.equal(
      (
        await fetch(
          origin + "/api/calendar/commands/" + receipt.id + "/apply",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ confirmed: false }),
          },
        )
      ).status,
      400,
    );
    assert.equal(fixture.writes, before);
    const applied = await fetch(
      origin + "/api/calendar/commands/" + receipt.id + "/apply",
      { method: "POST", headers, body: JSON.stringify({ confirmed: true }) },
    );
    assert.equal(applied.status, 201);
    assert.equal((await applied.json()).state, "succeeded");
    assert.equal(fixture.writes, before + 1);
    const bob = await issueSession(
      db,
      actor("bob").id,
      workspaceId,
      false,
      actor("bob").identityCredentialId,
    );
    assert.equal(
      (
        await fetch(origin + "/api/calendar/commands/" + receipt.id, {
          headers: { Authorization: "Bearer " + bob },
        })
      ).status,
      404,
    );
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
  }
});
