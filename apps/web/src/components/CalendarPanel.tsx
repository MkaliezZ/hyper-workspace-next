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
  CalendarCommandReceipt,
  CalendarOccurrence,
  CalendarPoint,
  CalendarSummary,
} from "@hyper/contracts/calendar";
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
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const addDays = (day: string, count: number) => {
  const date = new Date(day + "T12:00:00");
  date.setDate(date.getDate() + count);
  return localDate(date);
};
const utc = (date: Date) => date.toISOString().replace(".000Z", "Z");
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
  return day + "T" + hour + ":00";
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
function CalendarPreview({ receipt }: { receipt: CalendarCommandReceipt }) {
  const plan = receipt.plan;
  const fields =
    plan.operation === "create"
      ? plan.draft
      : plan.operation === "update"
        ? plan.patch
        : null;
  return (
    <div className="calendar-preview">
      <p>
        {plan.operation === "create"
          ? "新建日程"
          : plan.operation === "update"
            ? "修改整个日程系列"
            : "删除整个日程系列"}
      </p>
      {fields ? (
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
                : "（结束日期不含当天）"}
            </p>
          ) : null}
        </>
      ) : (
        <p>重复实例也会一并删除。</p>
      )}
      <details>
        <summary>核对目标引用</summary>
        <p>
          日历：{receipt.calendarId}
          <br />
          日程：{receipt.objectId}
        </p>
      </details>
    </div>
  );
}
export function CalendarPanel() {
  const [calendars, setCalendars] = useState<CalendarSummary[]>([]),
    [calendarId, setCalendarId] = useState("");
  const [day, setDay] = useState(localDate(new Date())),
    [events, setEvents] = useState<CalendarOccurrence[]>([]);
  const [history, setHistory] = useState<CalendarCommandReceipt[]>([]),
    [error, setError] = useState("");
  const [listLoading, setListLoading] = useState(true),
    [queryLoading, setQueryLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<"create" | "update" | "delete" | null>(null),
    [selected, setSelected] = useState<CalendarOccurrence | null>(null);
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [location, setLocation] = useState("");
  const [allDay, setAllDay] = useState(false),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [reschedule, setReschedule] = useState(false);
  const [intent, setIntent] = useState<CalendarCommandReceipt | null>(null),
    [modalError, setModalError] = useState("");
  const pending = useRef<{
    fingerprint: string;
    input: CalendarCommandInput;
  } | null>(null);
  const currentCalendar = calendars.find((c) => c.id === calendarId);
  const loading = listLoading || queryLoading;
  const displayZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clearPrivate = useCallback(() => {
    setCalendars([]);
    setCalendarId("");
    setEvents([]);
    setHistory([]);
    setMode(null);
    setSelected(null);
    setIntent(null);
    pending.current = null;
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
    setListLoading(true);
    setError("");
    void Promise.all([
      api<CalendarSummary[]>("/calendar/calendars", {
        signal: controller.signal,
      }),
      api<CalendarCommandReceipt[]>("/calendar/commands", {
        signal: controller.signal,
      }),
    ])
      .then(([list, receipts]) => {
        if (controller.signal.aborted) return;
        setCalendars(list);
        setHistory(receipts);
        setCalendarId((previous) =>
          list.some((c) => c.id === previous) ? previous : (list[0]?.id ?? ""),
        );
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          clearPrivate();
          failure(e);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false);
      });
    return () => controller.abort();
  }, [revision, clearPrivate, failure]);
  useEffect(() => {
    setEvents([]);
    setQueryLoading(false);
    if (!calendarId) return;
    const controller = new AbortController();
    setQueryLoading(true);
    setError("");
    void api<CalendarOccurrence[]>("/calendar/query", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        calendarId,
        start: utc(new Date(day + "T00:00:00")),
        end: utc(new Date(addDays(day, 7) + "T00:00:00")),
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
    return () => controller.abort();
  }, [calendarId, day, revision, failure]);
  function open(
    operation: "create" | "update" | "delete",
    event?: CalendarOccurrence,
  ) {
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
    setStart(event ? inputTime(event.start) : initialTime(day, "09:00"));
    setEnd(event ? inputTime(event.end) : initialTime(day, "10:00"));
  }
  function close() {
    if (!busy) {
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
        if (intent.state === "prepared") await execute(intent, "apply");
        else if (["applying", "recovery_required"].includes(intent.state))
          await execute(intent, "reconcile");
        return;
      }
      let input: CalendarCommandInput;
      const interval = allDay
        ? { kind: "all_day" as const, start, end }
        : {
            kind: "timed" as const,
            start: instantInput(start),
            end: instantInput(end),
          };
      if (mode === "create")
        input = {
          operation: "create",
          calendarId,
          idempotencyKey: "",
          draft: { title, description, location, interval },
        };
      else {
        if (!selected) throw new Error("请重新选择日程。");
        const base = {
          calendarId: selected.calendarId,
          objectId: selected.objectId,
          etag: selected.etag,
          scope: "series" as const,
          idempotencyKey: "",
        };
        input =
          mode === "delete"
            ? { ...base, operation: "delete" }
            : {
                ...base,
                operation: "update",
                patch: {
                  ...(title !== selected.title ? { title } : {}),
                  ...(description !== selected.description
                    ? { description }
                    : {}),
                  ...(location !== selected.location ? { location } : {}),
                  ...(reschedule ? { interval } : {}),
                },
              };
        if (input.operation === "update" && !Object.keys(input.patch).length)
          throw new Error("请先修改日程内容。");
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
      if (receipt.state === "prepared") await execute(receipt, "apply");
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
          日历
          <select
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
                        <button
                          disabled={!currentCalendar?.canUpdate || busy}
                          onClick={() => open("update", event)}
                        >
                          修改
                        </button>
                        <button
                          disabled={!currentCalendar?.canDelete || busy}
                          onClick={() => open("delete", event)}
                        >
                          删除
                        </button>
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
                      setMode(receipt.operation);
                      setModalError("");
                    }}
                  >
                    查看准备操作
                  </button>
                ) : null}
                <strong>{receipt.title}</strong>
                <span>
                  {labels[receipt.state]}
                  {receipt.stopRequested && receipt.state !== "cancelled"
                    ? " · 已请求停止后续"
                    : ""}
                </span>
                <time dateTime={receipt.acknowledgedAt ?? receipt.createdAt}>
                  {new Date(
                    receipt.acknowledgedAt ?? receipt.createdAt,
                  ).toLocaleString("zh-CN")}
                </time>
                {receipt.error ? (
                  <p>
                    {receipt.error === "calendar_version_conflict"
                      ? "来源已变化，请刷新后重新修改。"
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
      {mode ? (
        <Dialog
          title={
            mode === "create"
              ? "新建日程"
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
            ) : mode === "delete" ? (
              <p>
                删除「{selected?.title || "所选日程"}
                」的整个系列，包含重复实例；已发生的其他操作不会随之撤销。
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
                      修改作用于整个系列；保留来源中的重复规则与例外。
                    </p>
                    <label className="calendar-check">
                      <input
                        type="checkbox"
                        checked={reschedule}
                        onChange={(e) => setReschedule(e.target.checked)}
                      />
                      同时调整时间（当前仅单次日程）
                    </label>
                  </>
                ) : null}
                {mode === "create" || reschedule ? (
                  <>
                    <label className="calendar-check">
                      <input
                        type="checkbox"
                        checked={allDay}
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
                    <label>
                      开始{!allDay ? "（本机时区）" : "日期"}
                      <input
                        type={allDay ? "date" : "datetime-local"}
                        required
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                      />
                    </label>
                    <label>
                      {allDay ? "结束日期（不含当天）" : "结束（本机时区）"}
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
                  (!!intent &&
                    ["failed", "cancelled", "succeeded"].includes(intent.state))
                }
              >
                {busy
                  ? "正在核对…"
                  : intent &&
                      ["applying", "recovery_required"].includes(intent.state)
                    ? "核对原操作"
                    : mode === "delete"
                      ? "确认删除系列"
                      : "保存日程"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </section>
  );
}
