import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  CalendarDays,
} from "lucide-react";
import type {
  CalendarCommandInput,
  CalendarAvailabilityQuery,
  CalendarCommandReceipt,
  CalendarOccurrence,
  CalendarMeeting,
  CalendarSeriesRule,
  CalendarPoint,
  CalendarRepeat,
  CalendarSummary,
  CalendarRunPlan,
  CalendarRunInput,
  CalendarRunSummary,
} from "@hyper/contracts/calendar";
import type { WorkspaceView } from "@hyper/contracts";
import type { ModelSummary } from "./ModelSettings";
import { runStateLabels } from "./RunDetails";
import type { RunState } from "@hyper/contracts";
import {
  CalendarInvitationFacts,
  CalendarInvitees,
  CalendarMeetingFacts,
} from "./CalendarInvitees";
import { CalendarAvailabilityPanel } from "./CalendarAvailabilityPanel";
import { CalendarLinkDialog } from "./CalendarLinkDialog";
import { api, mutation, ApiError } from "../api";
import { Dialog } from "./Dialog";

const labels: Record<CalendarCommandReceipt["state"], string> = {
  prepared: "已准备，尚未执行",
  applying: "正在写入并核对",
  succeeded: "来源结果已核实",
  failed: "未完成",
  recovery_required: "结果待核对",
  cancelled: "已停止，未发送",
};
const frequencyLabel: Record<CalendarRepeat["frequency"], string> = {
  DAILY: "天",
  WEEKLY: "周",
  MONTHLY: "个月",
  YEARLY: "年",
};
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const addDays = (day: string, count: number) => {
  const date = new Date(day + "T12:00:00");
  date.setDate(date.getDate() + count);
  return localDate(date);
};
const utc = (date: Date) => date.toISOString().replace(".000Z", "Z");
const weekWindow = (day: string) => ({
  start: utc(new Date(day + "T00:00:00")),
  end: utc(new Date(addDays(day, 7) + "T00:00:00")),
});
function pointLabel(point: CalendarPoint) {
  if (point.kind === "date") return point.value + " · 全天";
  if (point.kind === "instant")
    return new Date(point.value).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return (
    point.value.replace("T", " ") +
    (point.kind === "floating" ? " · 时区待确定" : " · 时区定义缺失")
  );
}
function initialTime(day: string, hour: string) {
  return day + "T" + hour;
}
function inputTime(point: CalendarPoint) {
  if (point.kind === "date") return point.value;
  if (point.kind !== "instant") return point.value.slice(0, 16);
  const date = new Date(point.value);
  return (
    localDate(date) +
    "T" +
    String(date.getHours()).padStart(2, "0") +
    ":" +
    String(date.getMinutes()).padStart(2, "0")
  );
}
function instantInput(value: string) {
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    inputTime({
      kind: "instant",
      value: date.toISOString(),
      timeZone: "UTC",
    }) !== value
  )
    throw new Error("所选本机时间无效或处于夏令时跳过区间，请重新选择。");
  return utc(date);
}
type Booking = {
  query: CalendarAvailabilityQuery;
  slot: { start: string; end: string };
};
function BookingTime({ booking }: { booking: Booking }) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: booking.query.timeZone,
  });
  return (
    <p>
      所选候选时段 {formatter.format(new Date(booking.slot.start))} 至{" "}
      {formatter.format(new Date(booking.slot.end))}（{booking.query.timeZone}
      ）。提交前会重新核对 {booking.query.calendarIds.length} 个日历。
    </p>
  );
}
const meetingReplies = {
  ACCEPTED: "接受",
  TENTATIVE: "暂定",
  DECLINED: "拒绝",
};
type SeriesChoice = CalendarRepeat["frequency"] | "none" | "";
type CalendarScope = "series" | "occurrence" | "meeting" | "series_rule";
type MeetingAction =
  | keyof typeof meetingReplies
  | "cancel"
  | "edit"
  | "reschedule_series";
function commandLabel(plan: CalendarCommandInput) {
  if (plan.operation === "create")
    return plan.booking
      ? plan.invitees?.length
        ? "复核时段并邀请员工"
        : "复核候选时段并预约"
      : plan.invitees?.length
        ? "新建会议并邀请员工"
        : "新建日程";
  if (plan.operation === "delete") return "删除整个日程系列";
  if (plan.scope === "series") return "修改整个日程系列";
  if (plan.scope === "series_rule") return "调整整组重复规则";
  if (plan.scope === "meeting")
    return plan.change.operation === "reply"
      ? "提交参会回复"
      : plan.change.operation === "reschedule_series"
        ? "整组会议改期并通知参会人"
        : plan.change.operation === "edit"
          ? "调整会议并通知参会人"
          : "取消会议并通知参会人";
  return plan.change.operation === "edit"
    ? "修改本次重复日程"
    : "取消本次重复日程";
}
function CalendarPreview({ receipt }: { receipt: CalendarCommandReceipt }) {
  const plan = receipt.plan;
  const fields =
    plan.operation === "create"
      ? plan.draft
      : plan.operation === "update"
        ? plan.scope === "series"
          ? plan.patch
          : (plan.scope === "occurrence" || plan.scope === "meeting") &&
              plan.change.operation === "edit"
            ? plan.change.patch
            : null
        : null;
  const single = plan.operation === "update" && plan.scope === "occurrence";
  return (
    <div className="calendar-preview">
      <p>{commandLabel(plan)}</p>
      {plan.operation === "create" &&
      plan.booking &&
      plan.draft.interval.kind === "timed" ? (
        <BookingTime
          booking={{ query: plan.booking, slot: plan.draft.interval }}
        />
      ) : null}
      {plan.operation === "update" && plan.scope === "series_rule" ? (
        <p>
          {plan.repeat
            ? `每 ${plan.repeat.interval} ${frequencyLabel[plan.repeat.frequency]}重复，共 ${plan.repeat.count} 次。`
            : "取消重复，保留首次日程。"}
        </p>
      ) : fields ? (
        <>
          <strong>{fields.title ?? "保留原标题"}</strong>
          {fields.location !== undefined ? (
            <p>地点：{fields.location || "清空"}</p>
          ) : null}
          {fields.description !== undefined ? (
            <p>{fields.description || "清空说明"}</p>
          ) : null}
          {fields.interval ? (
            <p>
              {fields.interval.start} 至 {fields.interval.end}
              {fields.interval.kind === "timed"
                ? "（UTC）"
                : fields.interval.kind === "zoned"
                  ? `（${fields.interval.timeZone}）`
                  : "（结束日期不含当天）"}
            </p>
          ) : null}
        </>
      ) : plan.operation === "update" && plan.scope === "meeting" ? (
        plan.change.operation === "reply" ? (
          <p>
            回复：{meetingReplies[plan.change.response]} ·{" "}
            {plan.change.target?.scope === "occurrence"
              ? `仅本次（${plan.change.target.recurrenceId}）`
              : "整组，含本人收到的单次例外"}
          </p>
        ) : plan.change.operation === "reschedule_series" ? (
          <p>
            系列首次时间：{plan.change.interval.start} 至{" "}
            {plan.change.interval.end}
            ；保留重复规则和已有单次例外的特殊安排。受改期影响的参会状态由来源重新请求回复。
          </p>
        ) : (
          <p>向来源提交取消会议。</p>
        )
      ) : (
        <p>{single ? "其他重复实例保持原样。" : "重复实例也会一并删除。"}</p>
      )}
      {plan.operation === "create" && plan.draft.repeat ? (
        <p>
          每 {plan.draft.repeat.interval}{" "}
          {frequencyLabel[plan.draft.repeat.frequency]}重复，共{" "}
          {plan.draft.repeat.count} 次。
        </p>
      ) : null}
      {plan.operation === "create" && plan.invitees ? (
        <p>已选参会员工：{plan.invitees.join("、")}</p>
      ) : null}
      {receipt.invitations ? (
        <CalendarInvitationFacts invitations={receipt.invitations} />
      ) : null}
      {receipt.meeting ? (
        <CalendarMeetingFacts meeting={receipt.meeting} />
      ) : null}
      <details>
        <summary>核对目标引用</summary>
        <p>
          日历：{receipt.calendarId}
          <br />
          日程：{receipt.objectId}
          {single ? (
            <>
              <br />
              原重复实例：{plan.target.recurrenceId}
            </>
          ) : null}
        </p>
      </details>
    </div>
  );
}
export function CalendarPanel({
  engines,
  view,
  run,
  onRun,
}: {
  engines: WorkspaceView["engines"];
  view: WorkspaceView;
  run: { id: string; state: string } | null;
  onRun: (run: any) => void;
}) {
  const [executor, setExecutor] = useState<"manual" | "dsh" | "hermes">(
    "manual",
  );
  const [models, setModels] = useState<ModelSummary[]>([]),
    [modelId, setModelId] = useState("");
  const [modelError, setModelError] = useState("");
  const aiPending = useRef<{
    fingerprint: string;
    input: CalendarRunInput;
  } | null>(null);
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]),
    [calendarId, setCalendarId] = useState("");
  const [day, setDay] = useState(localDate(new Date())),
    [events, setEvents] = useState<CalendarOccurrence[]>([]);
  const [history, setHistory] = useState<CalendarCommandReceipt[]>([]),
    [error, setError] = useState("");
  const [runHistory, setRunHistory] = useState<CalendarRunSummary[]>([]);
  const [linkEvent, setLinkEvent] = useState<CalendarOccurrence | null>(null);
  const [listLoading, setListLoading] = useState(true),
    [queryLoading, setQueryLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<"create" | "update" | "delete" | null>(null),
    [selected, setSelected] = useState<CalendarOccurrence | null>(null);
  const [scope, setScope] = useState<CalendarScope>("series");
  const [seriesRule, setSeriesRule] = useState<CalendarSeriesRule | null>(null);
  const [seriesChoice, setSeriesChoice] = useState<SeriesChoice>("");
  const [meeting, setMeeting] = useState<CalendarMeeting | null>(null);
  const [meetingAction, setMeetingAction] = useState<MeetingAction | "">("");
  const [replyScope, setReplyScope] = useState<"series" | "occurrence">(
    "series",
  );
  const objectLoad = useRef<AbortController | null>(null);
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [location, setLocation] = useState("");
  const [allDay, setAllDay] = useState(false),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [reschedule, setReschedule] = useState(false);
  const [eventZone, setEventZone] = useState("");
  const [booking, setBooking] = useState<Booking | null>(null);
  const [invitees, setInvitees] = useState<{ uid: string; name: string }[]>([]);
  const [frequency, setFrequency] = useState<CalendarRepeat["frequency"] | "">(
    "",
  );
  const [repeatInterval, setRepeatInterval] = useState(1),
    [repeatCount, setRepeatCount] = useState(4);
  const [intent, setIntent] = useState<CalendarCommandReceipt | null>(null),
    [modalError, setModalError] = useState("");
  const pending = useRef<{
    fingerprint: string;
    input: CalendarCommandInput;
  } | null>(null);
  const loaders = useRef(new Set<AbortController>());
  const currentCalendar = calendars.find((c) => c.id === calendarId);
  const loading = listLoading || queryLoading;
  const displayZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clearPrivate = useCallback(() => {
    for (const controller of loaders.current) controller.abort();
    setListLoading(false);
    setQueryLoading(false);
    setCalendars([]);
    setCalendarId("");
    setEvents([]);
    setHistory([]);
    setRunHistory([]);
    setLinkEvent(null);
    setMode(null);
    setSelected(null);
    setIntent(null);
    setMeeting(null);
    setMeetingAction("");
    setReplyScope("series");
    setSeriesRule(null);
    setSeriesChoice("");
    setInvitees([]);
    setBooking(null);
    pending.current = null;
    aiPending.current = null;
    setModels([]);
    setModelId("");
  }, []);
  const failure = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status))
        clearPrivate();
      setError(e instanceof Error ? e.message : "日历暂时不可用。");
    },
    [clearPrivate],
  );
  useEffect(() => {
    const controller = new AbortController();
    loaders.current.add(controller);
    void api<ModelSummary[]>("/models", { signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) {
          setModels(rows.filter((m) => m.purpose === "chat"));
          setModelError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setModelError(e.message);
      });
    return () => {
      loaders.current.delete(controller);
      controller.abort();
    };
  }, []);
  useEffect(() => {
    if (
      run &&
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    )
      setRevision((v) => v + 1);
  }, [run?.id, run?.state]);
  const aiReady =
    executor !== "manual" &&
    engines[executor]?.configured &&
    !!models.find(
      (m) =>
        m.id === modelId &&
        (!engines[executor]?.modelProviders ||
          engines[executor].modelProviders!.includes(m.provider)),
    );
  async function ai(plan: CalendarRunPlan) {
    if (executor === "manual" || !aiReady)
      throw new Error("请选择可用的执行器和模型连接。");
    const base = { plan, engine: executor, modelProfileId: modelId };
    const fingerprint = JSON.stringify(base);
    if (!aiPending.current || aiPending.current.fingerprint !== fingerprint)
      aiPending.current = {
        fingerprint,
        input: { ...base, idempotencyKey: crypto.randomUUID() },
      };
    const result = await mutation("/calendar/runs", aiPending.current.input);
    onRun(result);
    setMode(null);
    setIntent(null);
    setSelected(null);
    pending.current = null;
    aiPending.current = null;
    setRevision((v) => v + 1);
  }
  async function readWithAi() {
    setBusy(true);
    setError("");
    try {
      await ai({
        operation: "read",
        query: {
          calendarId,
          ...weekWindow(day),
        },
      });
    } catch (e) {
      failure(e);
    } finally {
      setBusy(false);
    }
  }
  async function applyPrepared(receipt: CalendarCommandReceipt) {
    if (receipt.sourceRunId) {
      onRun(await api("/runs/" + receipt.sourceRunId));
      return;
    }
    if (executor === "manual") await execute(receipt, "apply");
    else
      await ai({ operation: "apply", commandId: receipt.id, confirmed: true });
  }
  useEffect(() => {
    const controller = new AbortController();
    loaders.current.add(controller);
    setListLoading(true);
    setError("");
    setHistory([]);
    setRunHistory([]);
    const denied = (e: unknown) =>
      e instanceof ApiError && [401, 403, 404].includes(e.status);
    const historyFailure = (e: unknown) => {
      if (controller.signal.aborted) return;
      if (denied(e)) {
        controller.abort();
        clearPrivate();
        setListLoading(false);
      }
      failure(e);
    };
    void api<CalendarSummary[]>("/calendar/calendars", {
      signal: controller.signal,
    })
      .then((list) => {
        if (controller.signal.aborted) return;
        setCalendars(list);
        setCalendarId((previous) =>
          list.some((c) => c.id === previous) ? previous : (list[0]?.id ?? ""),
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          controller.abort();
          clearPrivate();
          setListLoading(false);
          failure(e);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false);
      });
    void api<CalendarCommandReceipt[]>("/calendar/commands", {
      signal: controller.signal,
    })
      .then((rows) => {
        if (!controller.signal.aborted) setHistory(rows);
      })
      .catch(historyFailure);
    void api<CalendarRunSummary[]>("/calendar/runs", {
      signal: controller.signal,
    })
      .then((rows) => {
        if (!controller.signal.aborted) setRunHistory(rows);
      })
      .catch(historyFailure);
    return () => {
      loaders.current.delete(controller);
      controller.abort();
    };
  }, [revision, clearPrivate, failure]);
  useEffect(() => {
    setEvents([]);
    setQueryLoading(false);
    if (!calendarId) return;
    const controller = new AbortController();
    loaders.current.add(controller);
    setQueryLoading(true);
    setError("");
    void api<CalendarOccurrence[]>("/calendar/query", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        calendarId,
        ...weekWindow(day),
      }),
    })
      .then((rows) => {
        if (!controller.signal.aborted) setEvents(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setEvents([]);
          failure(e);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setQueryLoading(false);
      });
    return () => {
      loaders.current.delete(controller);
      controller.abort();
    };
  }, [calendarId, day, revision, failure]);
  function open(
    operation: "create" | "update" | "delete",
    event?: CalendarOccurrence,
    actionScope: CalendarScope = "series",
  ) {
    objectLoad.current?.abort();
    setMeeting(null);
    setMeetingAction("");
    setReplyScope("series");
    setSeriesRule(null);
    setSeriesChoice("");
    setScope(actionScope);
    setSelected(event ?? null);
    setMode(operation);
    setIntent(null);
    setModalError("");
    pending.current = null;
    setTitle(event?.title ?? "");
    setDescription(event?.description ?? "");
    setLocation(event?.location ?? "");
    setAllDay(event?.start.kind === "date");
    setReschedule(false);
    setEventZone("");
    setBooking(null);
    setInvitees([]);
    setFrequency("");
    setRepeatInterval(1);
    setRepeatCount(4);
    setStart(event ? inputTime(event.start) : initialTime(day, "09:00"));
    setEnd(event ? inputTime(event.end) : initialTime(day, "10:00"));
  }
  useEffect(() => () => objectLoad.current?.abort(), []);
  function loadObjectDetails<T>(
    event: CalendarOccurrence,
    path: "meeting" | "series-rule",
    onLoaded: (value: T) => void,
  ) {
    const controller = new AbortController();
    objectLoad.current = controller;
    loaders.current.add(controller);
    void api<T>("/calendar/" + path, {
      method: "POST",
      body: JSON.stringify({
        calendarId: event.calendarId,
        objectId: event.objectId,
        etag: event.etag,
        ...(path === "meeting" && event.recurrenceId
          ? {
              target: {
                recurrenceId: event.recurrenceId,
                window: weekWindow(day),
              },
            }
          : {}),
      }),
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) onLoaded(value);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status))
          failure(error);
        else
          setModalError(
            error instanceof Error ? error.message : "读取日程详情失败。",
          );
      })
      .finally(() => loaders.current.delete(controller));
  }
  function openMeeting(event: CalendarOccurrence) {
    open("update", event, "meeting");
    loadObjectDetails<CalendarMeeting>(event, "meeting", setMeeting);
  }
  function openSeriesRule(event: CalendarOccurrence) {
    open("update", event, "series_rule");
    loadObjectDetails<CalendarSeriesRule>(event, "series-rule", (value) => {
      setSeriesRule(value);
      if (value.simple) {
        setSeriesChoice(value.simple.frequency);
        setRepeatInterval(value.simple.interval);
        setRepeatCount(value.simple.count);
      }
    });
  }
  function close() {
    if (!busy) {
      objectLoad.current?.abort();
      setMode(null);
      setSelected(null);
      setIntent(null);
      pending.current = null;
    }
  }
  async function refresh() {
    setRevision((v) => v + 1);
  }
  async function execute(
    receipt: CalendarCommandReceipt,
    action: "apply" | "reconcile" | "cancel",
  ) {
    const result = await mutation<CalendarCommandReceipt>(
      `/calendar/commands/${receipt.id}/${action}`,
      action === "apply" ? { confirmed: true } : {},
    );
    setIntent(result);
    setHistory((previous) =>
      [result, ...previous.filter((r) => r.id !== result.id)].slice(0, 30),
    );
    if (result.state === "succeeded" || result.state === "cancelled") {
      setMode(null);
      setSelected(null);
      pending.current = null;
      setRevision((v) => v + 1);
    }
    return result;
  }
  async function submit() {
    if (!mode || busy || !calendarId) return;
    setBusy(true);
    setModalError("");
    try {
      if (intent) {
        if (intent.state === "prepared") await applyPrepared(intent);
        else if (["applying", "recovery_required"].includes(intent.state))
          await execute(intent, "reconcile");
        return;
      }
      let input: CalendarCommandInput;
      const interval = () => {
        if (allDay) return { kind: "all_day" as const, start, end };
        if (eventZone.trim()) {
          const seconds = (value: string) =>
            value.length === 16 ? value + ":00" : value;
          if (
            scope === "meeting" &&
            meetingAction === "reschedule_series" &&
            meeting?.series?.interval.kind === "timed"
          )
            return {
              kind: "timed" as const,
              start: seconds(start) + "Z",
              end: seconds(end) + "Z",
            };
          return {
            kind: "zoned" as const,
            start: seconds(start),
            end: seconds(end),
            timeZone: eventZone.trim(),
          };
        }
        return {
          kind: "timed" as const,
          start: instantInput(start),
          end: instantInput(end),
        };
      };
      if (mode === "create")
        input = {
          operation: "create",
          calendarId,
          idempotencyKey: "",
          ...(booking ? { booking: booking.query } : {}),
          ...(invitees.length
            ? { invitees: invitees.map((person) => person.uid) }
            : {}),
          draft: {
            title,
            description,
            location,
            interval: booking ? { kind: "timed", ...booking.slot } : interval(),
            ...(!booking && frequency
              ? {
                  repeat: {
                    frequency,
                    interval: repeatInterval,
                    count: repeatCount,
                  },
                }
              : {}),
          },
        };
      else {
        if (!selected) throw new Error("请重新选择日程。");
        const base = {
          calendarId: selected.calendarId,
          objectId: selected.objectId,
          etag: selected.etag,
          idempotencyKey: "",
        };
        const patch =
          mode === "update"
            ? {
                ...(title !== selected.title ? { title } : {}),
                ...(description !== selected.description
                  ? { description }
                  : {}),
                ...(location !== selected.location ? { location } : {}),
                ...(reschedule ? { interval: interval() } : {}),
              }
            : null;
        if (
          scope !== "meeting" &&
          scope !== "series_rule" &&
          patch &&
          !Object.keys(patch).length
        )
          throw new Error("请先修改日程内容。");
        if (scope === "series_rule") {
          if (!seriesRule || !seriesChoice)
            throw new Error("请明确选择新的重复规则。");
          input = {
            ...base,
            operation: "update",
            scope,
            repeat:
              seriesChoice === "none"
                ? null
                : {
                    frequency: seriesChoice,
                    interval: repeatInterval,
                    count: repeatCount,
                  },
          };
        } else if (scope === "meeting") {
          if (!meeting?.canUpdate || !meetingAction)
            throw new Error("请选择要确认的会议操作。");
          if (
            meetingAction === "edit" &&
            (!patch || !Object.keys(patch).length)
          )
            throw new Error("请先修改会议内容。");
          input = {
            ...base,
            operation: "update",
            scope,
            change:
              meetingAction === "cancel"
                ? { operation: "cancel" }
                : meetingAction === "reschedule_series"
                  ? {
                      operation: "reschedule_series",
                      interval: interval(),
                      exceptions: "preserve_overrides",
                    }
                  : meetingAction === "edit"
                    ? { operation: "edit", patch: patch! }
                    : {
                        operation: "reply",
                        response: meetingAction,
                        target:
                          replyScope === "occurrence" && selected.recurrenceId
                            ? {
                                scope: "occurrence",
                                recurrenceId: selected.recurrenceId,
                                window: weekWindow(day),
                              }
                            : { scope: "series" },
                      },
          };
        } else if (scope === "occurrence") {
          if (!selected.recurrenceId) throw new Error("请重新选择重复实例。");
          input = {
            ...base,
            operation: "update",
            scope,
            target: {
              recurrenceId: selected.recurrenceId,
              window: weekWindow(day),
            },
            change: patch
              ? { operation: "edit", patch }
              : { operation: "cancel" },
          };
        } else {
          input = patch
            ? { ...base, operation: "update", scope, patch }
            : { ...base, operation: "delete", scope };
        }
      }
      const fingerprint = JSON.stringify(input);
      if (!pending.current || pending.current.fingerprint !== fingerprint)
        pending.current = {
          fingerprint,
          input: { ...input, idempotencyKey: crypto.randomUUID() },
        };
      const receipt =
        intent ??
        (await mutation<CalendarCommandReceipt>(
          "/calendar/commands",
          pending.current.input,
        ));
      setIntent(receipt);
      if (receipt.state === "prepared") await applyPrepared(receipt);
      else if (
        receipt.state === "applying" ||
        receipt.state === "recovery_required"
      )
        await execute(receipt, "reconcile");
    } catch (e) {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status))
        failure(e);
      else
        setModalError(
          e instanceof Error ? e.message : "暂未取得日历回执，请先核对原记录。",
        );
    } finally {
      setBusy(false);
    }
  }
  async function fromHistory(
    receipt: CalendarCommandReceipt,
    action: "reconcile" | "cancel",
  ) {
    setBusy(true);
    setError("");
    try {
      await execute(receipt, action);
    } catch (e) {
      failure(e);
    } finally {
      setBusy(false);
    }
  }
  const days = Array.from({ length: 7 }, (_, i) => addDays(day, i));
  return (
    <section className="calendar-panel" aria-label="企业日历">
      <div className="calendar-toolbar">
        <div>
          <h2>日历排期</h2>
          <p className="muted">查看获准日程，修改与操作结果保留来源回执。</p>
        </div>
        <button
          className="primary"
          disabled={!currentCalendar?.canCreate || loading || busy}
          onClick={() => open("create")}
        >
          <Plus size={17} />
          新建日程
        </button>
      </div>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}
      <div className="calendar-controls">
        <label>
          操作方式
          <select
            aria-label="日历操作方式"
            value={executor}
            disabled={busy || !!aiPending.current}
            onChange={(e) => setExecutor(e.target.value as typeof executor)}
          >
            <option value="manual">人工操作</option>
            <option value="dsh" disabled={!engines.dsh?.configured}>
              DSH
            </option>
            <option value="hermes" disabled={!engines.hermes?.configured}>
              Hermes
            </option>
          </select>
        </label>
        {executor !== "manual" ? (
          <>
            <label>
              模型连接
              <select
                aria-label="日历模型连接"
                value={modelId}
                disabled={busy || !!aiPending.current}
                onChange={(e) => setModelId(e.target.value)}
              >
                <option value="">选择 chat 连接</option>
                {models
                  .filter(
                    (m) =>
                      !engines[executor]?.modelProviders ||
                      engines[executor].modelProviders!.includes(m.provider),
                  )
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {m.model}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={!aiReady || !calendarId || loading || busy}
              onClick={() => void readWithAi()}
            >
              AI 核对本周
            </button>
            {modelError ? <span role="alert">{modelError}</span> : null}
          </>
        ) : null}
      </div>
      <div className="calendar-controls">
        <label>
          日历
          <select
            aria-label="日历"
            value={calendarId}
            onChange={(e) => setCalendarId(e.target.value)}
            disabled={busy}
          >
            <option value="">选择日历</option>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.canCreate ? "" : " · 只读"}
              </option>
            ))}
          </select>
        </label>
        <div className="calendar-range">
          <button
            className="icon-button"
            aria-label="上一周"
            onClick={() => setDay(addDays(day, -7))}
          >
            <ChevronLeft size={19} />
          </button>
          <label>
            起始日期
            <input
              type="date"
              value={day}
              required
              onChange={(e) => {
                if (e.target.validity.valid && e.target.value)
                  setDay(e.target.value);
              }}
            />
          </label>
          <button
            className="icon-button"
            aria-label="下一周"
            onClick={() => setDay(addDays(day, 7))}
          >
            <ChevronRight size={19} />
          </button>
        </div>
        <button
          className="secondary"
          onClick={() => void refresh()}
          disabled={busy}
        >
          <RefreshCw size={15} />
          刷新
        </button>
      </div>
      <p className="muted calendar-zone">
        显示时区：{displayZone}
        ；全天事件按原日期展示。浮动时间与缺失时区不会用于判定空闲。
      </p>
      {loading ? (
        <p role="status">正在读取来源日历…</p>
      ) : !calendarId ? (
        <div className="calendar-empty">
          <CalendarDays size={28} />
          <p>暂无可读取日历；请连接企业账号并启用日历服务。</p>
        </div>
      ) : (
        <div className="calendar-week">
          {days.map((date) => {
            const rows = events
              .filter((event) => {
                if (
                  event.start.kind === "instant" &&
                  event.end.kind === "instant"
                ) {
                  const start = Date.parse(event.start.value),
                    end = Date.parse(event.end.value);
                  const first = new Date(date + "T00:00:00").getTime(),
                    last = new Date(addDays(date, 1) + "T00:00:00").getTime();
                  return (
                    start < last &&
                    (end > first || (end === start && start >= first))
                  );
                }
                const start = event.start.value.slice(0, 10),
                  end = event.end.value.slice(0, 10);
                return (
                  start <= date &&
                  (end > date || (end === start && start === date))
                );
              })
              .sort((a, b) => a.start.value.localeCompare(b.start.value));
            return (
              <section key={date} className="calendar-day" aria-label={date}>
                <header>
                  <strong>
                    {new Date(date + "T12:00:00").toLocaleDateString("zh-CN", {
                      weekday: "short",
                    })}
                  </strong>
                  <span>{date.slice(5)}</span>
                </header>
                {rows.length ? (
                  rows.map((event, i) => (
                    <article
                      key={event.objectId + ":" + (event.recurrenceId ?? i)}
                      className={
                        "calendar-event" +
                        (event.status === "cancelled" ? " is-cancelled" : "")
                      }
                    >
                      <h3>{event.title || "未命名日程"}</h3>
                      <p>
                        {pointLabel(event.start)}
                        <br />至 {pointLabel(event.end)}
                      </p>
                      {event.location ? <p>{event.location}</p> : null}
                      {event.status === "cancelled" ? (
                        <span>已取消</span>
                      ) : null}
                      <div className="calendar-event-actions">
                        {event.status !== "cancelled" ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setLinkEvent(event)}
                          >
                            关联项目与待办
                          </button>
                        ) : null}
                        {event.meeting ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => openMeeting(event)}
                          >
                            查看会议与回复
                          </button>
                        ) : (
                          <>
                            <button
                              disabled={!currentCalendar?.canUpdate || busy}
                              onClick={() => open("update", event)}
                            >
                              {event.recurrenceId ? "修改系列" : "修改"}
                            </button>
                            <button
                              disabled={!currentCalendar?.canDelete || busy}
                              onClick={() => open("delete", event)}
                            >
                              {event.recurrenceId ? "删除系列" : "删除"}
                            </button>
                            {event.recurrenceId &&
                            event.status !== "cancelled" ? (
                              <>
                                <button
                                  disabled={!currentCalendar?.canUpdate || busy}
                                  onClick={() =>
                                    open("update", event, "occurrence")
                                  }
                                >
                                  修改本次
                                </button>
                                <button
                                  disabled={!currentCalendar?.canUpdate || busy}
                                  onClick={() =>
                                    open("delete", event, "occurrence")
                                  }
                                >
                                  取消本次
                                </button>
                                <button
                                  type="button"
                                  disabled={!currentCalendar?.canUpdate || busy}
                                  onClick={() => openSeriesRule(event)}
                                >
                                  调整重复规则
                                </button>
                              </>
                            ) : null}
                          </>
                        )}
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="muted">此日无日程</p>
                )}
              </section>
            );
          })}
        </div>
      )}
      <section className="calendar-history" aria-label="日历操作回执">
        <h3>最近操作</h3>
        {history.length ? (
          history.map((receipt) => (
            <article key={receipt.id}>
              <div>
                {receipt.state === "prepared" ? (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setIntent(receipt);
                      const plan = receipt.plan;
                      const one =
                        plan.operation === "update" &&
                        plan.scope === "occurrence";
                      setScope(
                        plan.operation === "update" ? plan.scope : "series",
                      );
                      setMode(
                        one && plan.change.operation === "cancel"
                          ? "delete"
                          : receipt.operation,
                      );
                      setModalError("");
                    }}
                  >
                    查看准备操作
                  </button>
                ) : null}
                <strong>{receipt.title}</strong>
                <span>{commandLabel(receipt.plan)}</span>
                {receipt.invitations ? (
                  <CalendarInvitationFacts invitations={receipt.invitations} />
                ) : null}
                {receipt.meeting ? (
                  <CalendarMeetingFacts meeting={receipt.meeting} />
                ) : null}
                {receipt.sourceRunId ? (
                  <button
                    disabled={busy}
                    onClick={() => {
                      void api("/runs/" + receipt.sourceRunId)
                        .then(onRun)
                        .catch(failure);
                    }}
                  >
                    查看 AI 执行
                  </button>
                ) : null}
                <span>
                  {labels[receipt.state]}
                  {receipt.stopRequested && receipt.state !== "cancelled"
                    ? " · 已请求停止后续"
                    : ""}
                </span>
                {receipt.bookingCheckedAt ? (
                  <span>
                    写入前复核{" "}
                    {new Date(receipt.bookingCheckedAt).toLocaleString("zh-CN")}
                  </span>
                ) : null}
                <time dateTime={receipt.acknowledgedAt ?? receipt.createdAt}>
                  {new Date(
                    receipt.acknowledgedAt ?? receipt.createdAt,
                  ).toLocaleString("zh-CN")}
                </time>
                {receipt.error ? (
                  <p>
                    {receipt.error === "calendar_version_conflict"
                      ? "来源已变化，请刷新后重新修改。"
                      : receipt.error === "calendar_slot_no_longer_available"
                        ? "所选时段已无法确认空闲，请重新查询候选时段。"
                        : "请先核对原操作，避免重复提交。"}
                  </p>
                ) : null}
              </div>
              <div>
                {["applying", "recovery_required"].includes(receipt.state) ? (
                  <button
                    disabled={busy}
                    onClick={() => void fromHistory(receipt, "reconcile")}
                  >
                    核对回执
                  </button>
                ) : null}
                {["prepared", "applying"].includes(receipt.state) ? (
                  <button
                    disabled={busy}
                    onClick={() => void fromHistory(receipt, "cancel")}
                  >
                    停止后续
                  </button>
                ) : null}
              </div>
            </article>
          ))
        ) : (
          <p className="muted">尚无日历操作。</p>
        )}
      </section>
      {currentCalendar ? (
        <CalendarAvailabilityPanel
          key={calendarId + ":" + day + ":" + revision}
          calendars={calendars}
          selectedId={calendarId}
          start={utc(new Date(day + "T00:00:00"))}
          end={utc(new Date(addDays(day, 7) + "T00:00:00"))}
          disabled={busy || listLoading}
          aiReady={!!aiReady}
          onAi={async (query) => {
            setBusy(true);
            try {
              await ai({ operation: "availability", query });
            } finally {
              setBusy(false);
            }
          }}
          onBook={
            currentCalendar.canCreate
              ? (query, slot) => {
                  open("create");
                  setBooking({ query, slot });
                }
              : undefined
          }
          onFailure={failure}
        />
      ) : null}
      <section aria-label="本人日历执行历史">
        <h3>本人 AI 日历执行</h3>
        {runHistory.length ? (
          runHistory.map((r) => (
            <article key={r.id} className="calendar-receipt">
              <div>
                <strong>
                  {r.operation === "read"
                    ? "核对日历窗口"
                    : r.operation === "availability"
                      ? "核对忙闲与候选时段"
                      : r.operation === "link"
                        ? "保存私人日程关联"
                        : "执行确认的日历操作"}{" "}
                  · {r.engine === "dsh" ? "DSH" : "Hermes"}
                </strong>
                <span>
                  {runStateLabels[r.state as RunState] ?? "请打开核对"}
                </span>
                <time dateTime={r.createdAt}>
                  {new Date(r.createdAt).toLocaleString("zh-CN")}
                </time>
              </div>
              <button
                onClick={() =>
                  void api("/runs/" + r.id)
                    .then(onRun)
                    .catch(failure)
                }
              >
                查看执行
              </button>
            </article>
          ))
        ) : (
          <p className="muted">尚无可访问的日历 AI 执行。</p>
        )}
      </section>
      {linkEvent ? (
        <CalendarLinkDialog
          event={linkEvent}
          view={view}
          onClose={() => setLinkEvent(null)}
          onUnavailable={failure}
          onAi={
            executor !== "manual"
              ? (change) => ai({ operation: "link", change })
              : undefined
          }
          aiUnavailable={executor !== "manual" && !aiReady}
        />
      ) : null}
      {mode ? (
        <Dialog
          title={
            mode === "create"
              ? "新建日程"
              : scope === "series_rule"
                ? "调整整组重复规则"
                : scope === "meeting"
                  ? "会议与参会回复"
                  : scope === "occurrence"
                    ? mode === "update"
                      ? "修改本次重复日程"
                      : "取消本次重复日程"
                    : mode === "update"
                      ? "修改日程"
                      : "删除日程"
          }
          onClose={close}
          error={modalError}
          dismissible={!busy}
        >
          <form
            className="calendar-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {intent ? (
              <CalendarPreview receipt={intent} />
            ) : scope === "series_rule" ? (
              seriesRule ? (
                <fieldset disabled={busy}>
                  <p>当前来源规则 {seriesRule.rules.join("；")}</p>
                  <p>
                    已有单次例外 {seriesRule.exceptionCount}{" "}
                    条。提交时会核对它们仍能对应原实例。
                  </p>
                  <label>
                    新的重复规则
                    <select
                      aria-label="新的重复规则"
                      value={seriesChoice}
                      onChange={(e) =>
                        setSeriesChoice(e.target.value as SeriesChoice)
                      }
                    >
                      <option value="">请选择</option>
                      <option value="none">取消重复，仅保留首次</option>
                      <option value="DAILY">按天</option>
                      <option value="WEEKLY">按周</option>
                      <option value="MONTHLY">按月</option>
                      <option value="YEARLY">按年</option>
                    </select>
                  </label>
                  {seriesChoice && seriesChoice !== "none" ? (
                    <>
                      <label>
                        重复间隔
                        <input
                          type="number"
                          min={1}
                          max={12}
                          required
                          value={repeatInterval}
                          onChange={(e) =>
                            setRepeatInterval(e.target.valueAsNumber)
                          }
                        />
                      </label>
                      <label>
                        重复总次数（含首次）
                        <input
                          type="number"
                          min={2}
                          max={104}
                          required
                          value={repeatCount}
                          onChange={(e) =>
                            setRepeatCount(e.target.valueAsNumber)
                          }
                        />
                      </label>
                    </>
                  ) : null}
                </fieldset>
              ) : !modalError ? (
                <p role="status">正在核对来源重复规则…</p>
              ) : null
            ) : scope === "meeting" ? (
              meeting ? (
                <fieldset disabled={busy}>
                  <strong>{meeting.title}</strong>
                  <CalendarMeetingFacts meeting={meeting} />
                  {meeting.canUpdate && !meeting.cancelled ? (
                    <label>
                      会议操作
                      <select
                        aria-label="会议操作"
                        value={meetingAction}
                        onChange={(e) => {
                          const action = e.target.value as MeetingAction | "";
                          setMeetingAction(action);
                          setReschedule(action === "reschedule_series");
                          if (
                            action === "reschedule_series" &&
                            meeting.series
                          ) {
                            const value = meeting.series.interval;
                            setAllDay(value.kind === "all_day");
                            setEventZone(
                              value.kind === "zoned"
                                ? value.timeZone
                                : value.kind === "timed"
                                  ? "UTC"
                                  : "",
                            );
                            setStart(value.start.replace(/Z$/u, ""));
                            setEnd(value.end.replace(/Z$/u, ""));
                          } else if (selected) {
                            setAllDay(selected.start.kind === "date");
                            setEventZone("");
                            setStart(inputTime(selected.start));
                            setEnd(inputTime(selected.end));
                          }
                        }}
                      >
                        <option value="">请选择</option>
                        {meeting.role === "organizer" ? (
                          <>
                            <option value="edit">调整会议并通知参会人</option>
                            {meeting.series?.canReschedule ? (
                              <option value="reschedule_series">
                                整组改期，保留单次例外安排
                              </option>
                            ) : null}
                            <option value="cancel">取消会议并通知参会人</option>
                          </>
                        ) : (
                          Object.entries(meetingReplies).map(
                            ([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ),
                          )
                        )}
                      </select>
                    </label>
                  ) : null}
                  {meeting.role === "attendee" &&
                  selected?.recurrenceId &&
                  meetingAction ? (
                    <label>
                      回复范围
                      <select
                        aria-label="回复范围"
                        value={replyScope}
                        onChange={(e) =>
                          setReplyScope(
                            e.target.value as "series" | "occurrence",
                          )
                        }
                      >
                        <option value="series">
                          整组，含本人收到的单次例外
                        </option>
                        <option value="occurrence">仅所选本次</option>
                      </select>
                    </label>
                  ) : null}
                  {meetingAction === "edit" ||
                  meetingAction === "reschedule_series" ? (
                    <>
                      {meetingAction === "reschedule_series" &&
                      meeting.series ? (
                        <p>
                          调整系列首次时间。每 {meeting.series.repeat.interval}{" "}
                          {frequencyLabel[meeting.series.repeat.frequency]}
                          重复，共 {meeting.series.repeat.count} 次；保留{" "}
                          {meeting.series.exceptionCount}{" "}
                          个单次例外的特殊安排和原时区，其他实例按新时间展开。
                        </p>
                      ) : null}
                      {meetingAction === "edit" ? (
                        <>
                          <label>
                            会议标题
                            <input
                              value={title}
                              maxLength={500}
                              required
                              disabled={selected?.truncatedFields.includes(
                                "summary",
                              )}
                              onChange={(e) => setTitle(e.target.value)}
                            />
                          </label>
                          <label>
                            会议地点
                            <input
                              value={location}
                              maxLength={1000}
                              disabled={selected?.truncatedFields.includes(
                                "location",
                              )}
                              onChange={(e) => setLocation(e.target.value)}
                            />
                          </label>
                          <label>
                            会议说明
                            <textarea
                              value={description}
                              maxLength={10000}
                              disabled={selected?.truncatedFields.includes(
                                "description",
                              )}
                              onChange={(e) => setDescription(e.target.value)}
                            />
                          </label>
                          {!selected?.recurrenceId ? (
                            <label className="calendar-check">
                              <input
                                type="checkbox"
                                checked={reschedule}
                                onChange={(e) =>
                                  setReschedule(e.target.checked)
                                }
                              />
                              同时调整会议时间
                            </label>
                          ) : null}
                        </>
                      ) : null}
                      {reschedule ? (
                        <>
                          {!allDay ? (
                            <label>
                              会议时区
                              <input
                                value={eventZone}
                                disabled={meetingAction === "reschedule_series"}
                                maxLength={100}
                                placeholder="留空使用本机时区"
                                onChange={(e) => setEventZone(e.target.value)}
                              />
                            </label>
                          ) : null}
                          <label>
                            {allDay
                              ? "会议开始日期"
                              : eventZone
                                ? "会议开始（指定时区）"
                                : "会议开始（本机时区）"}
                            <input
                              required
                              type={allDay ? "date" : "datetime-local"}
                              value={start}
                              onChange={(e) => setStart(e.target.value)}
                            />
                          </label>
                          <label>
                            {allDay
                              ? "会议结束日期（不含当天）"
                              : eventZone
                                ? "会议结束（指定时区）"
                                : "会议结束（本机时区）"}
                            <input
                              required
                              type={allDay ? "date" : "datetime-local"}
                              value={end}
                              onChange={(e) => setEnd(e.target.value)}
                            />
                          </label>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </fieldset>
              ) : !modalError ? (
                <p role="status">正在核对来源会议…</p>
              ) : null
            ) : mode === "delete" ? (
              <p>
                {scope === "occurrence"
                  ? `仅取消「${selected?.title || "所选日程"}」的本次实例，其他日期保留。`
                  : `删除「${selected?.title || "所选日程"}」的整个系列，包含重复实例。`}
              </p>
            ) : (
              <fieldset disabled={busy || !!intent}>
                {selected?.truncatedFields.length ? (
                  <p className="muted">
                    部分字段为节选，本次保留这些字段的来源全文。
                  </p>
                ) : null}
                <label>
                  日程标题
                  <input
                    value={title}
                    maxLength={500}
                    required
                    disabled={selected?.truncatedFields.includes("summary")}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <label>
                  地点
                  <input
                    value={location}
                    maxLength={1000}
                    disabled={selected?.truncatedFields.includes("location")}
                    onChange={(e) => setLocation(e.target.value)}
                  />
                </label>
                <label>
                  说明
                  <textarea
                    value={description}
                    maxLength={10000}
                    disabled={selected?.truncatedFields.includes("description")}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                {mode === "update" ? (
                  <>
                    <p className="muted">
                      {scope === "occurrence"
                        ? "修改仅应用于这一次，保留原重复计划。"
                        : "修改作用于整个系列，保留来源中的重复规则与例外。"}
                    </p>
                    {scope === "occurrence" || !selected?.recurrenceId ? (
                      <label className="calendar-check">
                        <input
                          type="checkbox"
                          checked={reschedule}
                          onChange={(e) => setReschedule(e.target.checked)}
                        />
                        同时调整时间
                      </label>
                    ) : null}
                  </>
                ) : null}
                {mode === "create" && currentCalendar?.canInvite ? (
                  <CalendarInvitees
                    selected={invitees}
                    onChange={setInvitees}
                  />
                ) : null}
                {booking ? <BookingTime booking={booking} /> : null}
                {mode === "create" && !booking ? (
                  <>
                    <label>
                      重复
                      <select
                        aria-label="重复规则"
                        value={frequency}
                        onChange={(e) => {
                          const next = e.target.value as typeof frequency;
                          setFrequency(next);
                          if (next && !eventZone)
                            setEventZone(
                              Intl.DateTimeFormat().resolvedOptions().timeZone,
                            );
                        }}
                      >
                        <option value="">不重复</option>
                        <option value="DAILY">按天</option>
                        <option value="WEEKLY">按周</option>
                        <option value="MONTHLY">按月</option>
                        <option value="YEARLY">按年</option>
                      </select>
                    </label>
                    {frequency ? (
                      <>
                        <label>
                          重复间隔（{frequencyLabel[frequency]}）
                          <input
                            aria-label="重复间隔"
                            type="number"
                            min={1}
                            max={12}
                            step={1}
                            required
                            value={repeatInterval}
                            onChange={(e) =>
                              setRepeatInterval(e.target.valueAsNumber)
                            }
                          />
                        </label>
                        <label>
                          重复总次数（含首次）
                          <input
                            type="number"
                            min={2}
                            max={104}
                            step={1}
                            required
                            value={repeatCount}
                            onChange={(e) =>
                              setRepeatCount(e.target.valueAsNumber)
                            }
                          />
                        </label>
                      </>
                    ) : null}
                  </>
                ) : null}
                {(mode === "create" && !booking) || reschedule ? (
                  <>
                    <label className="calendar-check">
                      <input
                        type="checkbox"
                        checked={allDay}
                        disabled={scope === "occurrence"}
                        onChange={(e) => {
                          setAllDay(e.target.checked);
                          setStart(
                            e.target.checked
                              ? start.slice(0, 10)
                              : initialTime(start.slice(0, 10), "09:00"),
                          );
                          setEnd(
                            e.target.checked
                              ? addDays(start.slice(0, 10), 1)
                              : initialTime(start.slice(0, 10), "10:00"),
                          );
                        }}
                      />
                      全天
                    </label>
                    {!allDay ? (
                      <label>
                        日程时区
                        <input
                          value={eventZone}
                          maxLength={100}
                          placeholder="留空使用本机时区"
                          onChange={(e) => setEventZone(e.target.value)}
                        />
                      </label>
                    ) : null}
                    <label>
                      {allDay
                        ? "开始日期"
                        : eventZone.trim()
                          ? "开始（指定时区）"
                          : "开始（本机时区）"}
                      <input
                        type={allDay ? "date" : "datetime-local"}
                        required
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                      />
                    </label>
                    <label>
                      {allDay
                        ? "结束日期（不含当天）"
                        : eventZone.trim()
                          ? "结束（指定时区）"
                          : "结束（本机时区）"}
                      <input
                        type={allDay ? "date" : "datetime-local"}
                        required
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                      />
                    </label>
                  </>
                ) : null}
              </fieldset>
            )}
            {intent ? (
              <p role="status">
                {labels[intent.state]}。
                {intent.error === "calendar_slot_no_longer_available"
                  ? "所选时段已无法确认空闲，请关闭并重新查询候选时段。"
                  : ""}
                {["applying", "recovery_required"].includes(intent.state)
                  ? "只核对来源结果，不重新发送。"
                  : ""}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                onClick={close}
                disabled={busy}
              >
                关闭
              </button>
              {busy && intent ? (
                <button
                  type="button"
                  onClick={() => {
                    void execute(intent, "cancel").catch((e) =>
                      setModalError(
                        e instanceof Error ? e.message : "停止请求未确认。",
                      ),
                    );
                  }}
                >
                  停止后续操作
                </button>
              ) : null}
              <button
                type="submit"
                className="primary"
                disabled={
                  busy ||
                  (scope === "series_rule" &&
                    !intent &&
                    (!seriesRule || !seriesChoice)) ||
                  (scope === "meeting" &&
                    !intent &&
                    (!meeting?.canUpdate ||
                      !meetingAction ||
                      meeting.cancelled)) ||
                  (executor !== "manual" && !aiReady) ||
                  (!!intent &&
                    ["failed", "cancelled", "succeeded"].includes(intent.state))
                }
              >
                {busy
                  ? "正在核对…"
                  : intent &&
                      ["applying", "recovery_required"].includes(intent.state)
                    ? "核对原操作"
                    : scope === "series_rule"
                      ? executor === "manual"
                        ? "确认修改重复规则"
                        : "确认规则并交给 AI"
                      : scope === "meeting"
                        ? executor === "manual"
                          ? "确认提交会议操作"
                          : "确认会议操作并交给 AI"
                        : mode === "delete"
                          ? scope === "occurrence"
                            ? "确认取消本次"
                            : "确认删除系列"
                          : booking ||
                              (intent?.plan.operation === "create" &&
                                intent.plan.booking)
                            ? executor === "manual"
                              ? "确认预约并复核时段"
                              : "确认预约并交给 AI"
                            : executor === "manual"
                              ? mode === "create" &&
                                (invitees.length ||
                                  (intent?.plan.operation === "create" &&
                                    intent.plan.invitees?.length))
                                ? "创建会议并邀请"
                                : "保存日程"
                              : mode === "create" &&
                                  (invitees.length ||
                                    (intent?.plan.operation === "create" &&
                                      intent.plan.invitees?.length))
                                ? "确认邀请并交给 AI"
                                : "确认并交给 AI"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}
