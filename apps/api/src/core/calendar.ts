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
  CalendarObjectQuery,
  CalendarLinkChange,
  type CalendarLink,
  type CalendarLinkReceipt,
  type CalendarLinkTarget,
  type CalendarMeeting,
  type CalendarCommandReceipt,
  type CalendarInvitationStatus,
} from "@hyper/contracts/calendar";
import type { Database } from "../db/database.js";
import { sourceConnection } from "./source-connection.js";
import {
  NextcloudCalendarProvider,
  CalendarSourceRejected,
} from "../providers/nextcloud-calendar.js";
import { NextcloudOrganizationProvider } from "../providers/nextcloud-organization.js";
import { stableDigest } from "./credentials.js";
import {
  createCalendarObject,
  patchCalendarObject,
  patchCalendarOccurrence,
  patchCalendarSeriesRule,
  readCalendarSeriesRule,
  calendarObjectDigest,
  calendarCommandMarker,
  invitationStatuses,
  meetingParticipants,
  calendarMeeting,
  patchCalendarMeeting,
} from "./calendar-codec.js";
import { calendarOccurrences } from "./calendar-projection.js";
import { ProjectAccess } from "./project-access.js";

const publicReceipt = (row: any): CalendarCommandReceipt => ({
  sourceRunId: row.source_run_id ?? null,
  ...(row.booking_checked_at
    ? { bookingCheckedAt: row.booking_checked_at.toISOString() }
    : {}),
  ...(row.invitation_status ? { invitations: row.invitation_status } : {}),
  ...(row.meeting_result ? { meeting: row.meeting_result } : {}),
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
type Creation = Extract<CalendarCommandInput, { operation: "create" }>;
class CalendarSlotUnavailable extends ConflictException {
  constructor() {
    super("所选时段已无法确认空闲，请重新查询候选时段。");
  }
}
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
      bindingKey: this.bindingKey(source),
    };
  }
  private bindingKey(source: Source) {
    return stableDigest({
      provider: source.config.providerKey,
      transport: source.config.transportUrl,
      workspaceId: source.config.workspaceId,
      memberGroup: source.config.memberGroup,
      actor: source.remoteUid,
    });
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
  private async meetingAddresses(
    source: Source,
    calendarId: string,
    invitees: string[],
  ) {
    const calendar = await this.calendar(source, calendarId, "create");
    if (calendar.ownerUid !== source.remoteUid)
      throw new ForbiddenException("邀请只能从当前员工拥有的日历发出。");
    const people = new NextcloudOrganizationProvider(
      source.config,
      source.credentials,
    );
    const assertRoster = async () => {
      const members = new Set(await people.members());
      if (
        !members.has(source.remoteUid) ||
        invitees.some((uid) => uid === source.remoteUid || !members.has(uid))
      )
        throw new ForbiddenException(
          "参会人必须是当前企业成员，不能重复邀请组织者。",
        );
    };
    await assertRoster();
    const organizer = await source.provider.schedulingAddress(source.remoteUid);
    const attendees: string[] = [];
    for (let index = 0; index < invitees.length; index += 4)
      attendees.push(
        ...(await Promise.all(
          invitees
            .slice(index, index + 4)
            .map((uid) => source.provider.schedulingAddress(uid)),
        )),
      );
    if (
      new Set([organizer, ...attendees].map((value) => value.toLowerCase()))
        .size !==
      attendees.length + 1
    )
      throw new ConflictException("来源日历地址重复，请重新核对参会员工。");
    await assertRoster();
    return { organizer, attendees };
  }
  private async ownMeetingAddress(
    source: Source,
    calendarId: string,
    writing = false,
  ) {
    const calendar = await this.calendar(
      source,
      calendarId,
      writing ? "update" : undefined,
    );
    if (calendar.ownerUid !== source.remoteUid)
      throw new ForbiddenException(
        "请在本人拥有的来源日历查看会议身份与回复。",
      );
    return {
      address: await source.provider.schedulingAddress(source.remoteUid),
      canUpdate: calendar.canUpdate,
    };
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
      .map((c) => {
        const { ownerUid, ...calendar } = live.get(c.id)!;
        return {
          ...calendar,
          ...(ownerUid === current.remoteUid && calendar.canCreate
            ? { canInvite: true }
            : {}),
        };
      });
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
  async seriesRule(s: Subject, raw: unknown) {
    const input = CalendarObjectQuery.parse(raw);
    const source = await this.connection(s);
    await this.calendar(source, input.calendarId, "update");
    const actual = await source.provider.read(input.calendarId, input.objectId);
    if (actual.etag !== input.etag)
      throw new ConflictException("来源重复日程已更新，请刷新日历。");
    const rule = readCalendarSeriesRule(actual.ical);
    await this.recheck(s, source, input.calendarId);
    return rule;
  }
  private async linkEvent(s: Subject, raw: unknown) {
    const input = CalendarObjectQuery.parse(raw);
    const source = await this.connection(s);
    await this.calendar(source, input.calendarId);
    const event = await source.provider.read(input.calendarId, input.objectId);
    await this.recheck(s, source, input.calendarId);
    return { source, event, bindingKey: this.bindingKey(source) };
  }
  private async assertLinkTarget(
    s: Subject,
    target: CalendarLinkTarget,
    current = false,
  ) {
    await new ProjectAccess(this.db).assert(s, target.projectId);
    if (target.kind === "task") {
      const task = await this.db.pool.query(
        "SELECT version FROM cw_tasks WHERE id=$1 AND project_id=$2 AND workspace_id=$3",
        [target.taskId, target.projectId, s.workspaceId],
      );
      if (!task.rowCount) throw new NotFoundException("待办不存在或无权访问。");
      if (current && task.rows[0].version !== target.taskVersion)
        throw new ConflictException("待办版本已更新，请刷新项目。");
    }
  }
  async linkScope(s: Subject, change: CalendarLinkChange, current: boolean) {
    await this.assertLinkTarget(s, change.target, current);
    const { event, bindingKey } = await this.linkEvent(s, change.event);
    if (current && event.etag !== change.event.etag)
      throw new ConflictException("来源日程已更新，请刷新日历。");
    return { bindingKey: stableDigest({ bindingKey, uid: event.uid }) };
  }
  async links(s: Subject, raw: unknown): Promise<CalendarLink[]> {
    const input = CalendarObjectQuery.parse(raw);
    const { source, event, bindingKey } = await this.linkEvent(s, input);
    if (event.etag !== input.etag)
      throw new ConflictException("来源日程已更新，请刷新日历。");
    const allowed = new Map(
      (await new ProjectAccess(this.db).list(s)).map((p) => [p.id, p.name]),
    );
    const rows = (
      await this.db.pool.query(
        `SELECT latest.project_id, latest.task_id, task.title, task.version
           FROM (
             SELECT DISTINCT ON (project_id,task_id) project_id,task_id,linked
             FROM cw_calendar_link_operations
             WHERE workspace_id=$1 AND actor_id=$2 AND source_binding=$3
               AND calendar_id=$4 AND object_id=$5 AND source_uid=$6
             ORDER BY project_id,task_id,revision DESC
           ) latest LEFT JOIN cw_tasks task ON task.id=latest.task_id
             AND task.project_id=latest.project_id AND task.workspace_id=$1
           WHERE latest.linked AND latest.project_id=ANY($7::uuid[])
             AND (latest.task_id IS NULL OR task.id IS NOT NULL)`,
        [
          s.workspaceId,
          s.id,
          bindingKey,
          event.calendarId,
          event.objectId,
          event.uid,
          [...allowed.keys()],
        ],
      )
    ).rows;
    await this.recheck(s, source, input.calendarId);
    return rows.map((row) =>
      row.task_id
        ? {
            target: {
              kind: "task",
              projectId: row.project_id,
              taskId: row.task_id,
              taskVersion: row.version,
            },
            label: row.title,
          }
        : {
            target: { kind: "project", projectId: row.project_id },
            label: allowed.get(row.project_id)!,
          },
    );
  }
  async changeLink(
    s: Subject,
    raw: unknown,
    execution?: { runId: string; lease: string; signal?: AbortSignal },
  ): Promise<CalendarLinkReceipt> {
    const input = CalendarLinkChange.parse(raw);
    const { target, linked } = input;
    await this.assertLinkTarget(s, target);
    const { source, event, bindingKey } = await this.linkEvent(s, input.event);
    await this.assertLinkTarget(s, target);
    const hash = stableDigest({ input, bindingKey, sourceUid: event.uid });
    const receipt = (row: {
      id: string;
      source_etag: string;
      recorded_at: Date;
    }) => ({
      id: row.id,
      linked,
      target,
      sourceEtag: row.source_etag,
      recordedAt: row.recorded_at.toISOString(),
    });
    return this.db.tx(async (c) => {
      execution?.signal?.throwIfAborted();
      if (execution) {
        const alive = await c.query(
          `SELECT id FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3
            AND state='running' AND lease_owner=$4 AND lease_expires_at>clock_timestamp()
            AND workflow='manage_calendar' AND calendar_plan=$5::jsonb AND calendar_binding=$6
            FOR UPDATE`,
          [
            execution.runId,
            s.workspaceId,
            s.id,
            execution.lease,
            { operation: "link", change: input },
            stableDigest({ bindingKey, uid: event.uid }),
          ],
        );
        if (!alive.rowCount)
          throw new ConflictException("日历执行已停止或租约失效。");
      }
      await this.guard(c, s, source);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `calendar-link:${s.workspaceId}:${s.id}`,
      ]);
      const previous = (
        await c.query(
          `SELECT id,params_hash,source_etag,recorded_at FROM cw_calendar_link_operations
            WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3`,
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        if (previous.params_hash !== hash)
          throw new ConflictException("同一关联操作键不能更换日程或目标。");
        return receipt(previous);
      }
      if (event.etag !== input.event.etag)
        throw new ConflictException("来源日程已更新，请刷新日历。");
      const project = await c.query(
        "SELECT id FROM cw_projects WHERE id=$1 AND workspace_id=$2 FOR SHARE",
        [target.projectId, s.workspaceId],
      );
      if (!project.rowCount)
        throw new NotFoundException("项目不存在或无权访问。");
      if (target.kind === "task") {
        const task = await c.query(
          "SELECT version FROM cw_tasks WHERE id=$1 AND project_id=$2 AND workspace_id=$3 FOR SHARE",
          [target.taskId, target.projectId, s.workspaceId],
        );
        if (task.rows[0]?.version !== target.taskVersion)
          throw new ConflictException("待办版本已更新，请刷新项目。");
      }
      execution?.signal?.throwIfAborted();
      const { rows } = await c.query(
        `INSERT INTO cw_calendar_link_operations
          (id,workspace_id,actor_id,source_binding,calendar_id,object_id,source_uid,source_etag,
           project_id,task_id,task_version,linked,idempotency_key,params_hash,source_run_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING id,source_etag,recorded_at`,
        [
          randomUUID(),
          s.workspaceId,
          s.id,
          bindingKey,
          event.calendarId,
          event.objectId,
          event.uid,
          event.etag,
          target.projectId,
          target.kind === "task" ? target.taskId : null,
          target.kind === "task" ? target.taskVersion : null,
          linked,
          input.idempotencyKey,
          hash,
          execution?.runId ?? null,
        ],
      );
      return receipt(rows[0]);
    });
  }
  async meeting(s: Subject, raw: unknown) {
    const input = CalendarObjectQuery.parse(raw);
    const source = await this.connection(s);
    const { address, canUpdate } = await this.ownMeetingAddress(
      source,
      input.calendarId,
    );
    const actual = await source.provider.read(input.calendarId, input.objectId);
    if (actual.etag !== input.etag)
      throw new ConflictException("会议已更新，请刷新日历后再读取。");
    const meeting = calendarMeeting(actual.ical, address);
    if (meeting.role === "organizer") {
      const saved = (
        await this.db.pool.query(
          `SELECT plan,desired_ical FROM cw_calendar_commands
         WHERE workspace_id=$1 AND actor_id=$2 AND provider_key=$3 AND source_actor_id=$4
           AND calendar_id=$5 AND object_id=$6 AND source_uid=$7 AND operation='create'
           AND state='succeeded' LIMIT 1`,
          [
            s.workspaceId,
            s.id,
            source.config.providerKey,
            source.remoteUid,
            input.calendarId,
            input.objectId,
            actual.uid,
          ],
        )
      ).rows[0];
      if (saved) {
        const plan = CalendarCommandInput.parse(saved.plan);
        if (plan.operation === "create" && plan.invitees)
          meeting.invitations = invitationStatuses(
            saved.desired_ical,
            actual.ical,
            plan.invitees,
          );
      }
    }
    const live = await this.recheck(s, source);
    const current = await this.ownMeetingAddress(live, input.calendarId);
    if (address !== current.address)
      throw new ConflictException("来源会议身份已变化，请刷新日历。");
    return { ...meeting, canUpdate: canUpdate && current.canUpdate };
  }
  async availability(s: Subject, raw: unknown, signal?: AbortSignal) {
    const input = CalendarAvailabilityQuery.parse(raw),
      source = await this.connection(s);
    return this.readAvailability(s, source, input, signal);
  }
  private async readAvailability(
    s: Subject,
    source: Source,
    input: CalendarAvailabilityQuery,
    signal?: AbortSignal,
  ) {
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
  private async checkBooking(
    s: Subject,
    source: Source,
    plan: Creation,
    signal?: AbortSignal,
  ) {
    const interval = plan.draft.interval;
    if (!plan.booking || interval.kind !== "timed")
      throw new CalendarSlotUnavailable();
    // Narrow the refreshed read to the exact selected interval. The working-hours
    // grid and source calendar set remain bound to the confirmed query.
    const refreshed = await this.readAvailability(
      s,
      source,
      {
        ...plan.booking,
        start: interval.start,
        end: interval.end,
      },
      signal,
    );
    if (
      refreshed.state !== "evaluated" ||
      !refreshed.candidates.some(
        (slot) => slot.start === interval.start && slot.end === interval.end,
      )
    )
      throw new CalendarSlotUnavailable();
    return refreshed.checkedAt;
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
      meetingActor: string | null = null,
      title: string;
    if (input.operation === "create") {
      objectId = "hyper-" + id + ".ics";
      uid = id + "@hyper-workspace";
      title = input.draft.title;
      const participants = input.invitees
        ? await this.meetingAddresses(source, input.calendarId, input.invitees)
        : undefined;
      if (input.booking) await this.checkBooking(s, source, input);
      desired = createCalendarObject(input.draft, uid, id, participants);
    } else {
      const original = await source.provider.read(
        input.calendarId,
        input.objectId,
      );
      if (original.etag !== input.etag)
        throw new ConflictException("日程已更新，请重新读取后再修改。");
      objectId = input.objectId;
      uid = original.uid;
      title = "所选日程";
      if (input.operation === "update" && input.scope === "meeting") {
        const { address } = await this.ownMeetingAddress(
          source,
          input.calendarId,
          true,
        );
        meetingActor = address;
        title = calendarMeeting(original.ical, address).title;
        desired = patchCalendarMeeting(
          original.ical,
          address,
          input.change,
          id,
        );
      } else {
        const { calendarUid } = await import(
          "../providers/nextcloud-calendar.js"
        );
        calendarUid(original.ical, true);
        if (input.operation === "update") {
          if (input.scope === "series")
            desired = patchCalendarObject(original.ical, input.patch, id);
          else if (input.scope === "series_rule")
            desired = patchCalendarSeriesRule(original.ical, input.repeat, id);
          else if (input.scope === "occurrence") {
            const selected = (
              await source.provider.occurrences(
                input.calendarId,
                input.target.window,
              )
            ).find((object) => object.objectId === original.objectId);
            if (
              !selected ||
              selected.etag !== original.etag ||
              selected.uid !== original.uid
            )
              throw new ConflictException(
                "本次日程已更新或不在所选窗口，请重新读取。",
              );
            const occurrence = calendarOccurrences([selected]).find(
              (event) => event.recurrenceId === input.target.recurrenceId,
            );
            if (!occurrence)
              throw new ConflictException("当前来源窗口内未找到本次重复日程。");
            title = occurrence.title || "所选日程";
            desired = patchCalendarOccurrence(
              original.ical,
              occurrence,
              input.change,
              id,
            );
          }
        }
      }
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
        "INSERT INTO cw_calendar_commands(id,workspace_id,actor_id,identity_credential_id,provider_key,source_actor_id,calendar_id,object_id,source_uid,operation,idempotency_key,params_hash,title,expected_etag,desired_ical,desired_digest,plan,meeting_actor_address,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'prepared')",
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
          desired
            ? calendarObjectDigest(
                desired,
                (input.operation === "create" && !!input.invitees) ||
                  !!meetingActor,
              )
            : null,
          input,
          meetingActor,
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
    const plan = CalendarCommandInput.parse(row.plan);
    const invitees = plan.operation === "create" ? plan.invitees : undefined;
    let invitations: CalendarInvitationStatus[] | null = null;
    let meetingResult: CalendarMeeting | null = null;
    let etag: string | null = null,
      outcome: "matched" | "absent" | null = null;
    try {
      const actual = await source.provider.read(row.calendar_id, row.object_id);
      if (
        row.operation !== "delete" &&
        actual.uid === row.source_uid &&
        calendarCommandMarker(actual.ical) === row.id &&
        calendarObjectDigest(
          actual.ical,
          !!invitees || !!row.meeting_actor_address,
        ) === row.desired_digest
      ) {
        etag = actual.etag;
        outcome = "matched";
        if (plan.operation === "update" && plan.scope === "meeting") {
          const address = row.meeting_actor_address;
          const seen = calendarMeeting(actual.ical, address);
          const expected = calendarMeeting(row.desired_ical, address);
          if (
            seen.role !== expected.role ||
            seen.cancelled !== expected.cancelled ||
            (plan.change.operation === "reply" &&
              seen.ownResponse !== expected.ownResponse)
          ) {
            outcome = null;
            etag = null;
          } else meetingResult = seen;
        }
        if (invitees)
          invitations = invitationStatuses(
            row.desired_ical,
            actual.ical,
            invitees,
          );
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
        "UPDATE cw_calendar_commands SET state=$2,source_etag=$3,observed_result=$4,error=$5,invitation_status=$6,meeting_result=$7,acknowledged_at=CASE WHEN $2='succeeded' THEN now() ELSE acknowledged_at END,updated_at=now() WHERE id=$1 AND state IN ('applying','recovery_required')",
        [
          id,
          outcome ? "succeeded" : "recovery_required",
          etag,
          outcome,
          outcome ? null : "calendar_result_unmatched",
          invitations ? JSON.stringify(invitations) : null,
          meetingResult ? JSON.stringify(meetingResult) : null,
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
    const plan = CalendarCommandInput.parse(row.plan);
    const booking = plan.operation === "create" && plan.booking ? plan : null;
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
      if (booking) {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `calendar-booking:${s.workspaceId}:${source.config.providerKey}:${source.remoteUid}`,
        ]);
        const interval = booking.draft.interval;
        const overlap = await c.query(
          `SELECT 1 FROM cw_calendar_commands
           WHERE workspace_id=$1 AND provider_key=$2 AND source_actor_id=$3 AND id<>$4
             AND state IN ('applying','recovery_required') AND plan ? 'booking'
             AND plan #>> '{draft,interval,start}' < $6
             AND plan #>> '{draft,interval,end}' > $5 LIMIT 1`,
          [
            s.workspaceId,
            source.config.providerKey,
            source.remoteUid,
            id,
            interval.start,
            interval.end,
          ],
        );
        if (overlap.rowCount)
          throw new ConflictException(
            "已有重叠时段正在提交或待核对，请先查看原操作回执。",
          );
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
      const invitees = plan.operation === "create" ? plan.invitees : undefined;
      if (invitees) {
        const participants = await this.meetingAddresses(
          live,
          row.calendar_id,
          invitees,
        );
        if (
          stableDigest(participants) !==
          stableDigest(meetingParticipants(row.desired_ical))
        )
          throw new ConflictException("来源参会身份已变化，请重新确认。");
      }
      if (plan.operation === "update" && plan.scope === "meeting") {
        const current = await this.ownMeetingAddress(
          live,
          row.calendar_id,
          true,
        );
        if (current.address !== row.meeting_actor_address)
          throw new ConflictException("来源会议身份已变化，请重新确认。");
      }
      const checkedAt = booking
        ? await this.checkBooking(s, live, booking, execution?.signal)
        : null;
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
      if (checkedAt) {
        const ready = await this.db.pool.query(
          `UPDATE cw_calendar_commands SET booking_checked_at=$2,updated_at=now()
           WHERE id=$1 AND state='applying' AND stop_requested_at IS NULL
           RETURNING id`,
          [id, checkedAt],
        );
        if (!ready.rowCount) {
          await this.db.pool.query(
            "UPDATE cw_calendar_commands SET state='cancelled',updated_at=now() WHERE id=$1 AND state='applying' AND stop_requested_at IS NOT NULL",
            [id],
          );
          return this.get(s, id);
        }
        execution?.signal?.throwIfAborted();
      }
      dispatched = true;
      if (invitees)
        await live.provider.createMeeting(
          row.calendar_id,
          row.object_id,
          row.desired_ical,
        );
      else if (plan.operation === "update" && plan.scope === "meeting")
        await live.provider.replaceMeeting(
          row.calendar_id,
          row.object_id,
          row.expected_etag,
          row.desired_ical,
        );
      else if (row.operation === "create")
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
          "UPDATE cw_calendar_commands SET state=$2,error=$3,updated_at=now() WHERE id=$1 AND state='applying'",
          [
            id,
            execution?.signal?.aborted ? "cancelled" : "failed",
            error instanceof CalendarSlotUnavailable
              ? "calendar_slot_no_longer_available"
              : "calendar_dispatch_not_started",
          ],
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
