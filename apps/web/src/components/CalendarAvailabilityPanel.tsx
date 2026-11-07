import { useEffect, useRef, useState } from "react";
import type {
  CalendarAvailabilityQuery,
  CalendarAvailabilityResult,
  CalendarSummary,
} from "@hyper/contracts/calendar";
import { api } from "../api";

function time(value: string, zone: string) {
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: zone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
export function CalendarAvailabilityResults({
  result,
}: {
  result: CalendarAvailabilityResult;
}) {
  return (
    <div className="calendar-availability-results">
      <p>
        核对时间：{new Date(result.checkedAt).toLocaleString("zh-CN")} ·{" "}
        {result.timeZone}
      </p>
      <p>
        {result.busy.length} 段占用，{result.conflicts.length}
        {result.conflictsTruncated ? "+" : ""}{" "}
        组重叠。候选时段仅供参考，尚未预订或发送邀请。
      </p>
      {result.state === "blocked" ? (
        <p role="alert">
          {result.unknown.length}{" "}
          条来源时间尚未确定，未提供空闲建议；请先明确原日程时区。
        </p>
      ) : result.candidates.length ? (
        <ol className="calendar-slots">
          {result.candidates.map((c) => (
            <li key={c.start}>
              {time(c.start, result.timeZone)} — {time(c.end, result.timeZone)}
            </li>
          ))}
        </ol>
      ) : (
        <p>所选窗口与工作时间内没有符合条件的候选时段。</p>
      )}
      {result.skippedWindows.length ? (
        <p role="status">
          {result.skippedWindows.map((w) => w.date).join("、")}{" "}
          的工作时间落在夏令时缺口、重复时刻或不存在的日期，未擅自调整；请修改查询条件后重查。
        </p>
      ) : null}
      <details>
        <summary>核对范围与来源版本</summary>
        <p>
          {time(result.window.start, result.timeZone)} 至{" "}
          {time(result.window.end, result.timeZone)}（不含结束时刻）。最多显示{" "}
          {result.candidateLimit} 个候选，不表示同事所有日历均已纳入。
        </p>
        {result.observations.map((c) => (
          <p key={c.calendarId}>
            {c.calendarId} · {c.objects.length} 个来源对象 · 来源时区：
            {c.timeZoneId ?? "未指定"}
          </p>
        ))}
        {result.conflicts.length ? (
          <ul>
            {result.conflicts.map((c, i) => (
              <li key={i}>
                {time(c.start, result.timeZone)} —{" "}
                {time(c.end, result.timeZone)}：{c.left.objectId} 与{" "}
                {c.right.objectId}
              </li>
            ))}
          </ul>
        ) : null}
        <p>
          这些是核对时的来源快照。后续修改可能改变空闲情况，新建日程前请再次核对。
        </p>
      </details>
    </div>
  );
}
export function CalendarAvailabilityPanel({
  calendars,
  selectedId,
  start,
  end,
  disabled,
  aiReady,
  onAi,
  onFailure,
}: {
  calendars: CalendarSummary[];
  selectedId: string;
  start: string;
  end: string;
  disabled: boolean;
  aiReady: boolean;
  onAi: (query: CalendarAvailabilityQuery) => Promise<void>;
  onFailure: (error: unknown) => void;
}) {
  const [ids, setIds] = useState([selectedId]),
    [zone, setZone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  const [duration, setDuration] = useState(60),
    [dailyStart, setDailyStart] = useState("09:00"),
    [dailyEnd, setDailyEnd] = useState("18:00"),
    [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [result, setResult] = useState<CalendarAvailabilityResult | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const changed = () => {
    request.current?.abort();
    setLoading(false);
    setResult(null);
    setError("");
  };
  async function query(ai: boolean) {
    if (loading || disabled || !ids.length) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const input: CalendarAvailabilityQuery = {
      calendarIds: ids,
      start,
      end,
      timeZone: zone,
      durationMinutes: duration,
      stepMinutes: 30,
      weekdays: days,
      dailyStart,
      dailyEnd,
    };
    setLoading(true);
    setError("");
    setResult(null);
    try {
      if (ai) await onAi(input);
      else {
        const next = await api<CalendarAvailabilityResult>(
          "/calendar/availability",
          {
            method: "POST",
            body: JSON.stringify(input),
            signal: controller.signal,
          },
        );
        if (!controller.signal.aborted) setResult(next);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : "排期核对暂未完成。");
        onFailure(e);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <section className="calendar-availability" aria-label="忙闲与候选时段">
      <h3>忙闲与候选时段</h3>
      <p className="muted">
        选择要合并核对的获准日历；暂定日程也计入占用，取消或透明日程不占用。只查询，不写入来源。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void query(false);
        }}
      >
        <fieldset disabled={loading || disabled}>
          <legend>纳入本次查询的日历（最多10个）</legend>
          <div className="calendar-choices">
            {calendars.map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(c.id)}
                  disabled={!ids.includes(c.id) && ids.length >= 10}
                  onChange={(e) => {
                    changed();
                    setIds(
                      e.target.checked
                        ? [...ids, c.id]
                        : ids.filter((id) => id !== c.id),
                    );
                  }}
                />
                {c.name}
              </label>
            ))}
          </div>
          <div className="calendar-availability-fields">
            <label>
              工作时间的时区
              <input
                aria-label="排期时区"
                value={zone}
                required
                onChange={(e) => {
                  changed();
                  setZone(e.target.value);
                }}
                placeholder="Asia/Shanghai"
              />
            </label>
            <label>
              会议时长（分钟）
              <input
                aria-label="排期时长"
                type="number"
                min={5}
                max={480}
                step={1}
                value={duration}
                onChange={(e) => {
                  changed();
                  setDuration(Number(e.target.value));
                }}
              />
            </label>
            <label>
              每天开始
              <input
                aria-label="排期每天开始"
                type="time"
                value={dailyStart}
                required
                onChange={(e) => {
                  changed();
                  setDailyStart(e.target.value);
                }}
              />
            </label>
            <label>
              每天结束
              <input
                aria-label="排期每天结束"
                type="time"
                value={dailyEnd}
                required
                onChange={(e) => {
                  changed();
                  setDailyEnd(e.target.value);
                }}
              />
            </label>
          </div>
          <div
            className="calendar-choices"
            role="group"
            aria-label="排期工作日"
          >
            {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(
              (label, i) => (
                <label key={i}>
                  <input
                    type="checkbox"
                    checked={days.includes(i + 1)}
                    onChange={(e) => {
                      changed();
                      setDays(
                        e.target.checked
                          ? [...days, i + 1]
                          : days.filter((d) => d !== i + 1),
                      );
                    }}
                  />
                  {label}
                </label>
              ),
            )}
          </div>
          <p className="muted">
            结束不晚于开始时，按跨午夜的工作时段计算；日期范围沿用上方当前周视图。更换时区后，实际查询起止时刻请在结果范围中核对。
          </p>
          <div className="calendar-availability-actions">
            <button type="submit" disabled={!ids.length || !days.length}>
              {loading ? "正在核对来源…" : "查询忙闲与候选"}
            </button>
            <button
              type="button"
              disabled={!aiReady || !ids.length || !days.length}
              onClick={() => void query(true)}
            >
              由 AI 核对排期
            </button>
          </div>
        </fieldset>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {result ? <CalendarAvailabilityResults result={result} /> : null}
    </section>
  );
}
