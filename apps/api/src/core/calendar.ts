import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Subject } from "@hyper/contracts";
import {
  CalendarCommandInput,
  CalendarQuery,
  CalendarAvailabilityQuery,
  type CalendarCommandReceipt,
} from "@hyper/contracts/calendar";
import type { Database } from "../db/database.js";
import { sourceConnection } from "./source-connection.js";
import {
  NextcloudCalendarProvider,
  CalendarSourceRejected,
} from "../providers/nextcloud-calendar.js";
import { stableDigest } from "./credentials.js";
import {
  createCalendarObject,
  patchCalendarObject,
  calendarObjectDigest,
  calendarCommandMarker,
} from "./calendar-codec.js";
import { calendarOccurrences } from "./calendar-projection.js";

const publicReceipt = (row: any): CalendarCommandReceipt => ({
  sourceRunId: row.source_run_id ?? null,
  plan: row.plan,
  id: row.id,
  operation: row.operation,
  calendarId: row.calendar_id,
  objectId: row.object_id,
  state: row.state,
  title: row.title,
  error: row.error ?? null,
  stopRequested: !!row.stop_requested_at,
  sourceEtag: row.source_etag ?? null,
  observedResult: row.observed_result ?? null,
  acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});
type Source = Awaited<ReturnType<CalendarService["connection"]>>;

/** Private calendar commands shared by manual UI and host-bound AI tools. */
export class CalendarService {
  constructor(private readonly db: Database) {}
  async connection(s: Subject) {
    if (process.env.NEXTCLOUD_CALENDAR_ENABLED !== "true")
      throw new ServiceUnavailableException("企业日历尚未启用。");
    const source = await sourceConnection(this.db, s);
    return {
      ...source,
      provider: new NextcloudCalendarProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      ),
    };
  }
  async scope(s: Subject, calendarId: string) {
    const source = await this.connection(s);
    const calendar = await this.calendar(source, calendarId);
    return {
      calendar,
      bindingKey: stableDigest({
        provider: source.config.providerKey,
        transport: source.config.transportUrl,
        workspaceId: source.config.workspaceId,
        memberGroup: source.config.memberGroup,
        actor: source.remoteUid,
      }),
    };
  }
  private async calendar(
    source: Source,
    calendarId: string,
    operation?: string,
  ) {
    const calendar = (await source.provider.calendars()).find(
      (c) => c.id === calendarId && c.canRead,
    );
    if (!calendar) throw new NotFoundException("日历不存在或无权访问。");
    if (
      (operation === "create" && !calendar.canCreate) ||
      (operation === "update" && !calendar.canUpdate) ||
      (operation === "delete" && !calendar.canDelete)
    )
      throw new ForbiddenException("当前日历没有此操作权限。");
    return calendar;
  }
  private async guard(c: PoolClient, s: Subject, source: Source) {
    const member = await c.query(
      "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
      [s.workspaceId, s.id],
    );
    const identity = await c.query(
      "SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.user_id=$2 AND i.workspace_id=$3 AND i.provider_key=$4 AND i.remote_uid=$5 AND c.disabled_at IS NULL FOR SHARE OF c,i",
      [
        s.identityCredentialId,
        s.id,
        s.workspaceId,
        source.config.providerKey,
        source.remoteUid,
      ],
    );
    if (!member.rowCount || !identity.rowCount)
      throw new ForbiddenException("成员或来源身份已撤销。");
  }
  private async owned(s: Subject, id: string) {
    const row = (
      await this.db.pool.query(
        "SELECT * FROM cw_calendar_commands WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("日历操作记录不存在。");
    return row;
  }
  private async authorized(s: Subject, id: string, writing = false) {
    const source = await this.connection(s),
      row = await this.owned(s, id);
    if (
      row.provider_key !== source.config.providerKey ||
      row.source_actor_id !== source.remoteUid
    )
      throw new ForbiddenException("日历来源身份已变化。");
    await this.calendar(
      source,
      row.calendar_id,
      writing ? row.operation : undefined,
    );
    return { source, row };
  }
  private async recheck(s: Subject, source: Source, calendarId?: string) {
    const current = await this.connection(s);
    if (
      source.config.providerKey !== current.config.providerKey ||
      source.remoteUid !== current.remoteUid ||
      source.config.transportUrl !== current.config.transportUrl ||
      source.config.memberGroup !== current.config.memberGroup ||
      source.config.workspaceId !== current.config.workspaceId
    )
      throw new ForbiddenException("日历来源身份已变化。");
    if (calendarId) await this.calendar(current, calendarId);
    return current;
  }
  async calendars(s: Subject) {
    const source = await this.connection(s),
      calendars = await source.provider.calendars();
    const current = await this.recheck(s, source);
    const live = new Map(
      (await current.provider.calendars()).map((c) => [c.id, c]),
    );
    return calendars
      .filter((c) => live.get(c.id)?.canRead)
      .map((c) => live.get(c.id)!);
  }
  async occurrences(s: Subject, raw: unknown) {
    const input = CalendarQuery.parse(raw),
      source = await this.connection(s);
    await this.calendar(source, input.calendarId);
    const result = calendarOccurrences(
      await source.provider.occurrences(input.calendarId, input),
    );
    await this.recheck(s, source, input.calendarId);
    return result;
  }
  async availability(s: Subject, raw: unknown, signal?: AbortSignal) {
    const input = CalendarAvailabilityQuery.parse(raw),
      source = await this.connection(s);
    const { readCalendarAvailability } = await import(
      "./calendar-source-availability.js"
    );
    return readCalendarAvailability(
      source.provider,
      input,
      async () => {
        const live = await this.recheck(s, source);
        return live.provider.calendars();
      },
      signal,
    );
  }
  async prepare(s: Subject, raw: unknown) {
    const input = CalendarCommandInput.parse(raw),
      source = await this.connection(s);
    await this.calendar(source, input.calendarId, input.operation);
    const hash = stableDigest({
      providerKey: source.config.providerKey,
      sourceActor: source.remoteUid,
      input,
    });
    const prior = (
      await this.db.pool.query(
        "SELECT id,params_hash FROM cw_calendar_commands WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, input.idempotencyKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.params_hash !== hash)
        throw new ConflictException("同一日历操作键不能更换内容或目标。");
      return this.get(s, prior.id);
    }
    const id = randomUUID();
    let objectId: string,
      uid: string,
      desired: string | null = null,
      title: string;
    if (input.operation === "create") {
      objectId = "hyper-" + id + ".ics";
      uid = id + "@hyper-workspace";
      title = input.draft.title;
      desired = createCalendarObject(input.draft, uid, id);
    } else {
      const original = await source.provider.read(
        input.calendarId,
        input.objectId,
      );
      if (original.etag !== input.etag)
        throw new ConflictException("日程已更新，请重新读取后再修改。");
      objectId = input.objectId;
      uid = original.uid;
      // The current mutation path must not silently send invitations/cancellations.
      const { calendarUid } = await import(
        "../providers/nextcloud-calendar.js"
      );
      calendarUid(original.ical, true);
      title = "所选日程";
      if (input.operation === "update")
        desired = patchCalendarObject(original.ical, input.patch, id);
    }
    await this.recheck(s, source, input.calendarId);
    const commandId = await this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "calendar:" + s.workspaceId + ":" + s.id + ":" + input.idempotencyKey,
      ]);
      await this.guard(c, s, source);
      const prior = (
        await c.query(
          "SELECT id,params_hash FROM cw_calendar_commands WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.params_hash !== hash)
          throw new ConflictException("同一日历操作键不能更换内容或目标。");
        return prior.id as string;
      }
      await c.query(
        "INSERT INTO cw_calendar_commands(id,workspace_id,actor_id,identity_credential_id,provider_key,source_actor_id,calendar_id,object_id,source_uid,operation,idempotency_key,params_hash,title,expected_etag,desired_ical,desired_digest,plan,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'prepared')",
        [
          id,
          s.workspaceId,
          s.id,
          s.identityCredentialId,
          source.config.providerKey,
          source.remoteUid,
          input.calendarId,
          objectId,
          uid,
          input.operation,
          input.idempotencyKey,
          hash,
          title,
          input.operation === "create" ? null : input.etag,
          desired,
          desired ? calendarObjectDigest(desired) : null,
          input,
        ],
      );
      return id;
    });
    return this.get(s, commandId);
  }
  async get(s: Subject, id: string) {
    const { row } = await this.authorized(s, id);
    return publicReceipt(row);
  }
  async history(s: Subject) {
    const source = await this.connection(s);
    const allowed = (await source.provider.calendars())
      .filter((c) => c.canRead)
      .map((c) => c.id);
    const rows = (
      await this.db.pool.query(
        "SELECT * FROM cw_calendar_commands WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND source_actor_id=$4 AND calendar_id=ANY($5::text[]) ORDER BY created_at DESC,id DESC LIMIT 30",
        [
          s.workspaceId,
          s.id,
          source.config.providerKey,
          source.remoteUid,
          allowed,
        ],
      )
    ).rows;
    const current = await this.recheck(s, source);
    const live = new Set(
      (await current.provider.calendars())
        .filter((c) => c.canRead)
        .map((c) => c.id),
    );
    return rows.filter((row) => live.has(row.calendar_id)).map(publicReceipt);
  }
  async cancel(s: Subject, id: string) {
    const { source, row } = await this.authorized(s, id);
    await this.db.tx(async (c) => {
      await this.guard(c, s, source);
      if (row.source_run_id) {
        const stopped = await c.query(
          "UPDATE cw_runs SET state='cancelled',next_sequence=next_sequence+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND state IN ('queued','running') RETURNING next_sequence-1 AS sequence",
          [row.source_run_id, s.workspaceId, s.id],
        );
        if (stopped.rowCount)
          await c.query(
            "INSERT INTO cw_run_events(event_id,run_id,sequence,kind,data) VALUES($1,$2,$3,'run.cancelled',$4)",
            [
              randomUUID(),
              row.source_run_id,
              stopped.rows[0].sequence,
              { message: "已停止后续日历执行；已发生效果以来源回执为准。" },
            ],
          );
      }
      await c.query(
        "UPDATE cw_calendar_commands SET stop_requested_at=COALESCE(stop_requested_at,now()),state=CASE WHEN state='prepared' THEN 'cancelled' ELSE state END,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      );
    });
    return this.get(s, id);
  }
  private async observe(s: Subject, id: string) {
    const { source, row } = await this.authorized(s, id);
    let etag: string | null = null,
      outcome: "matched" | "absent" | null = null;
    try {
      const actual = await source.provider.read(row.calendar_id, row.object_id);
      if (
        row.operation !== "delete" &&
        actual.uid === row.source_uid &&
        calendarCommandMarker(actual.ical) === row.id &&
        calendarObjectDigest(actual.ical) === row.desired_digest
      ) {
        etag = actual.etag;
        outcome = "matched";
      }
    } catch (error) {
      if (error instanceof CalendarSourceRejected && error.getStatus() === 404)
        outcome = row.operation === "delete" ? "absent" : null;
      else throw error;
    }
    await this.recheck(s, source, row.calendar_id);
    await this.db.tx(async (c) => {
      await this.guard(c, s, source);
      await c.query(
        "UPDATE cw_calendar_commands SET state=$2,source_etag=$3,observed_result=$4,error=$5,acknowledged_at=CASE WHEN $2='succeeded' THEN now() ELSE acknowledged_at END,updated_at=now() WHERE id=$1 AND state IN ('applying','recovery_required')",
        [
          id,
          outcome ? "succeeded" : "recovery_required",
          etag,
          outcome,
          outcome ? null : "calendar_result_unmatched",
        ],
      );
    });
    return this.get(s, id);
  }
  async reconcile(s: Subject, id: string) {
    const { row } = await this.authorized(s, id);
    if (row.state !== "recovery_required" && row.state !== "applying")
      return publicReceipt(row);
    if (
      row.state === "applying" &&
      Date.now() - row.attempted_at.getTime() < 60000
    )
      return publicReceipt(row);
    return this.observe(s, id);
  }
  async apply(
    s: Subject,
    id: string,
    execution?: {
      runId: string;
      lease: string;
      signal?: AbortSignal;
      beforeWrite: () => Promise<void>;
    },
  ) {
    const { source, row } = await this.authorized(s, id, true);
    if (row.state !== "prepared") return publicReceipt(row);
    execution?.signal?.throwIfAborted();
    if (execution) await execution.beforeWrite();
    const claimed = await this.db.tx(async (c) => {
      await this.guard(c, s, source);
      if (execution) {
        const run = await c.query(
          "SELECT id FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND state='running' AND lease_owner=$4 AND lease_expires_at>clock_timestamp() AND workflow='manage_calendar' AND calendar_plan->>'commandId'=$5 FOR UPDATE",
          [execution.runId, s.workspaceId, s.id, execution.lease, id],
        );
        if (!run.rowCount)
          throw new ConflictException("日历执行已停止或租约失效。");
      } else if (row.source_run_id) {
        const active = await c.query(
          "SELECT id FROM cw_runs WHERE id=$1 AND state IN ('queued','running') FOR UPDATE",
          [row.source_run_id],
        );
        if (active.rowCount)
          throw new ConflictException("请先停止此日历AI执行，再人工接管。");
      }
      return (
        await c.query(
          "UPDATE cw_calendar_commands SET state='applying',attempted_at=now(),updated_at=now() WHERE id=$1 AND state='prepared' AND stop_requested_at IS NULL RETURNING id",
          [id],
        )
      ).rowCount;
    });
    if (!claimed) return this.get(s, id);
    let dispatched = false;
    try {
      const live = await this.recheck(s, source);
      await this.calendar(live, row.calendar_id, row.operation);
      const current = await this.owned(s, id);
      if (current.stop_requested_at) {
        await this.db.pool.query(
          "UPDATE cw_calendar_commands SET state='cancelled',updated_at=now() WHERE id=$1 AND state='applying'",
          [id],
        );
        return this.get(s, id);
      }
      execution?.signal?.throwIfAborted();
      if (execution) await execution.beforeWrite();
      dispatched = true;
      if (row.operation === "create")
        await live.provider.create(
          row.calendar_id,
          row.object_id,
          row.desired_ical,
        );
      else if (row.operation === "update")
        await live.provider.replace(
          row.calendar_id,
          row.object_id,
          row.expected_etag,
          row.desired_ical,
        );
      else
        await live.provider.remove(
          row.calendar_id,
          row.object_id,
          row.expected_etag,
        );
      await this.db.pool.query(
        "UPDATE cw_calendar_commands SET source_acknowledged=true,updated_at=now() WHERE id=$1",
        [id],
      );
    } catch (error) {
      if (!dispatched) {
        await this.db.pool.query(
          "UPDATE cw_calendar_commands SET state=$2,error='calendar_dispatch_not_started',updated_at=now() WHERE id=$1 AND state='applying'",
          [id, execution?.signal?.aborted ? "cancelled" : "failed"],
        );
        return this.get(s, id);
      }
      const rejected = error instanceof CalendarSourceRejected;
      await this.db.pool.query(
        "UPDATE cw_calendar_commands SET state=$2,error=$3,updated_at=now() WHERE id=$1 AND state='applying'",
        [
          id,
          rejected ? "failed" : "recovery_required",
          rejected && error.getStatus() === 412
            ? "calendar_version_conflict"
            : rejected
              ? "calendar_source_rejected"
              : "calendar_delivery_unknown",
        ],
      );
      // A rejected response is final. Unknown outcomes can only be reconciled, never resent.
      if (rejected) return this.get(s, id);
    }
    try {
      return await this.observe(s, id);
    } catch {
      await this.db.pool.query(
        "UPDATE cw_calendar_commands SET state='recovery_required',error='calendar_observation_unavailable',updated_at=now() WHERE id=$1 AND state='applying'",
        [id],
      );
      return this.get(s, id);
    }
  }
}
