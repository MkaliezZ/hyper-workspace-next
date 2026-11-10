import { useEffect, useState } from "react";
import {
  TerminalStates,
  type PlannedAction,
  type RunEvent,
  type RunState,
} from "@hyper/contracts";
import { api } from "../api";
import { Dialog } from "./Dialog";
import { CalendarAvailabilityResults } from "./CalendarAvailabilityPanel";
import {
  CalendarInvitationFacts,
  CalendarMeetingFacts,
} from "./CalendarInvitees";
import type {
  CalendarAvailabilityResult,
  CalendarInvitationStatus,
  CalendarMeeting,
} from "@hyper/contracts/calendar";

export const runStateLabels: Record<RunState, string> = {
  queued: "等待处理",
  running: "正在推进",
  waiting_input: "需要澄清",
  waiting_confirmation: "等待确认",
  succeeded: "已完成",
  failed: "执行未完成",
  cancelled: "已停止",
  recovery_required: "需要核对已执行操作",
};
export function runErrorText(value: string) {
  return (
    {
      "Task time limit exceeded.":
        "本次执行超过时间限制。请核对已完成操作和当前业务状态，再决定是否续做。",
      "Task stopped or lease lost.":
        "执行已停止或运行租约失效。请先核对已完成操作，不要直接重复提交。",
      "Execution lease could not be renewed.":
        "暂时无法续期运行租约。请先核对当前执行和已完成操作。",
    }[value] ?? value
  );
}
const actionLabels: Record<PlannedAction["tool"], string> = {
  "work.plan": "整理工作计划",
  "artifact.create": "保存成果",
  "artifact.revise": "修改成果",
  "artifact.review": "记录成果验收",
  "task.create": "创建待办",
  "task.update": "修改待办",
  "task.assign": "分配负责人",
  "project.report": "保存项目周报",
  "follow_up.check": "核对项目变化",
  "follow_up.configure": "配置定时跟进",
  "method.write": "保存方法草稿",
  "method.manage": "管理方法",
  "policy.configure": "配置执行规则",
  "notifications.manage": "管理提醒偏好",
  "usage.report": "核对模型用量",
  "spending.manage": "管理价格与预算",
  "brief.write": "保存任务说明",
  "brief.manage": "管理任务说明",
  "directory.read": "读取通讯录",
  "organization.manage": "管理组织",
  "communication.manage": "管理会话",
  "calendar.manage": "核对日历操作",
  "approval.manage": "核对审批操作",
  "ocr.recognize": "保存识别草稿",
  "attachment.share": "分享文件附件",
  "decision.write": "保存项目决定",
  "decision.manage": "管理项目决定",
  "knowledge.answer": "保存资料问答",
  "communication.draft": "保存回复草稿",
  "file.reading.save": "保存文档解读",
};
function receiptLabel(receipt: Record<string, unknown>) {
  if (receipt.tool === "approval.manage") {
    const labels: Record<string, string> = {
      read: "核对审批状态",
      submit: "提交审批申请",
      withdraw: "撤回审批申请",
      transfer: "转交审批分派",
      remind: "记录审批催办",
    };
    if (typeof receipt.operation === "string" && labels[receipt.operation])
      return labels[receipt.operation];
  }
  if (receipt.tool === "calendar.manage") {
    if (receipt.operation === "link") {
      const link = receipt.link as { linked?: boolean } | undefined;
      return link?.linked === false ? "移除私人日程关联" : "保存私人日程关联";
    }
    if (receipt.seriesRuleAction === true) return "调整整组重复规则";
    if (receipt.meetingChange === "edit") return "调整会议";
    if (receipt.meetingChange === "reschedule_series") return "整组会议改期";
    if (receipt.meetingChange === "reply") return "提交参会回复";
    if (receipt.meetingChange === "cancel") return "取消会议";
    if (receipt.occurrenceChange === "edit") return "修改本次重复日程";
    if (receipt.occurrenceChange === "cancel") return "取消本次重复日程";
  }
  if (
    receipt.tool === "method.manage" &&
    typeof receipt.operation === "string"
  ) {
    const label: Record<string, string> = {
      verify: "记录员工方法验证",
      publish: "发布方法",
      withdraw: "撤回方法",
      transfer: "移交方法维护人",
    };
    if (label[receipt.operation]) return label[receipt.operation];
  }
  return typeof receipt.tool === "string"
    ? (actionLabels[receipt.tool as PlannedAction["tool"]] ?? "业务操作")
    : "业务操作";
}
const receiptStateLabels: Record<string, string> = {
  open: "待处理",
  doing: "进行中",
  done: "已完成",
  draft: "草稿",
  accepted: "已验收",
  changes_requested: "待修改",
  candidate: "方法候选",
  published: "已发布",
  withdrawn: "已撤回",
};
const approvalStateLabels: Record<string, string> = {
  draft: "草稿",
  active: "审批中",
  returned: "已退回",
  approved: "已通过",
  rejected: "已拒绝",
  withdrawn: "已撤回",
};
function approvalReceipt(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("state" in value) ||
    typeof value.state !== "string" ||
    !("revision" in value) ||
    typeof value.revision !== "number"
  )
    return null;
  return (
    <span>
      {approvalStateLabels[value.state] ?? value.state} · 申请版本{" "}
      {value.revision}
    </span>
  );
}
const eventLabels: Record<RunEvent["kind"], string> = {
  "run.started": "开始执行",
  "message.delta": "更新执行说明",
  "progress.updated": "更新进度",
  "input.required": "等待补充信息或确认",
  "action.proposed": "提出业务操作",
  "action.completed": "业务操作已有回执",
  "artifact.updated": "成果版本已更新",
  "task.updated": "待办已更新",
  "method.updated": "方法已更新",
  "decision.updated": "决定已更新",
  "usage.updated": "模型用量已记录",
  "run.completed": "执行完成",
  "run.failed": "执行未完成",
  "run.cancelled": "执行已停止",
  "run.recovery_required": "需要核对已执行操作",
};
type Receipt = Record<string, unknown>;
interface RunInfo {
  id: string;
  state: RunState;
  engine: string;
  error: string | null;
  result: { receipts?: Receipt[] } | null;
  modelUsage?: {
    requests: number;
    incomplete: number;
    reportedInputTokens: number | null;
    reportedOutputTokens: number | null;
    costStatus: string;
  };
}
interface HistoryPage {
  events: RunEvent[];
  after: number;
  hasMore: boolean;
}
export function receiptList(info: RunInfo, events: RunEvent[]) {
  const rows = [...(info.result?.receipts ?? [])];
  const signature = (row: Receipt) =>
    JSON.stringify(
      Object.entries(row).sort(([left], [right]) => left.localeCompare(right)),
    );
  const unmatched = rows.map(signature);
  for (const event of events.filter(
    (event) => event.kind === "action.completed",
  )) {
    const match = unmatched.indexOf(signature(event.data));
    if (match >= 0) unmatched.splice(match, 1);
    else rows.push(event.data);
  }
  // Match representations one-for-one, preserving two identical real actions.
  return rows;
}
export function RunDetails({
  runId,
  onClose,
}: {
  runId: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [historyAfter, setHistoryAfter] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    let historyLoaded = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      setLoading(true);
      try {
        const options = { signal: controller.signal };
        const [current, records] = await Promise.all([
          api<RunInfo>("/runs/" + runId, options),
          historyLoaded
            ? Promise.resolve(undefined)
            : api<HistoryPage>("/runs/" + runId + "/history", options),
        ]);
        if (!alive) return;
        setInfo(current);
        if (records) {
          setEvents(records.events);
          setHistoryAfter(records.after);
          setHasMore(records.hasMore);
          historyLoaded = true;
        }
        setError("");
        if (!TerminalStates.has(current.state))
          timer = setTimeout(() => void refresh(), 5000);
      } catch (error) {
        if (!alive) return;
        // Revocation or an unverifiable source must remove the last snapshot.
        setInfo(null);
        setEvents([]);
        setHasMore(false);
        setError((error as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    }
    void refresh();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, revision]);
  useEffect(() => {
    if (!loadingMore) return;
    let alive = true;
    const controller = new AbortController();
    void api<HistoryPage>("/runs/" + runId + "/history?after=" + historyAfter, {
      signal: controller.signal,
    })
      .then((page) => {
        if (!alive) return;
        setEvents((current) => [
          ...current,
          ...page.events.filter(
            (event) => !current.some((old) => old.eventId === event.eventId),
          ),
        ]);
        setHistoryAfter(page.after);
        setHasMore(page.hasMore);
      })
      .catch((error) => {
        if (!alive) return;
        setInfo(null);
        setEvents([]);
        setHasMore(false);
        setError(error.message);
      })
      .finally(() => {
        if (alive) setLoadingMore(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [loadingMore, runId]);
  const receipts = info ? receiptList(info, events) : [];
  return (
    <Dialog title="执行详情" onClose={onClose} error={error}>
      <div className="run-details">
        {loading ? <p role="status">正在核对当前权限与回执…</p> : null}
        {info ? (
          <>
            <p className="run-detail-state">
              {info.engine === "fixture" ? "演示执行" : "AI 执行"} ·{" "}
              {runStateLabels[info.state]}
            </p>
            {info.error ? (
              <p role="status">{runErrorText(info.error)}</p>
            ) : null}
            <h3>已取得的操作回执</h3>
            <p>回执记录操作发生时的结果；当前状态请到任务或成果中核对。</p>
            {receipts.length ? (
              <ul className="run-receipts">
                {receipts.map((receipt, index) => (
                  <li key={index}>
                    <strong>
                      {receiptLabel(receipt)}
                      {typeof receipt.title === "string"
                        ? " · " + receipt.title
                        : ""}
                    </strong>
                    {receipt.tool === "approval.manage"
                      ? approvalReceipt(receipt.approval)
                      : null}
                    {receipt.tool === "ocr.recognize" &&
                    typeof receipt.page === "number" &&
                    typeof receipt.revision === "number" ? (
                      <span>
                        第 {receipt.page} 页 · 草稿版本 {receipt.revision}
                      </span>
                    ) : null}

                    {receipt.tool === "calendar.manage" &&
                    receipt.operation === "availability" &&
                    typeof receipt.availability === "object" &&
                    receipt.availability !== null &&
                    "candidates" in receipt.availability ? (
                      <CalendarAvailabilityResults
                        result={
                          receipt.availability as CalendarAvailabilityResult
                        }
                      />
                    ) : null}
                    {receipt.tool === "calendar.manage" &&
                    Array.isArray(receipt.invitations) ? (
                      <CalendarInvitationFacts
                        invitations={
                          receipt.invitations as CalendarInvitationStatus[]
                        }
                      />
                    ) : null}
                    {receipt.tool === "calendar.manage" &&
                    receipt.meeting &&
                    typeof receipt.meeting === "object" ? (
                      <CalendarMeetingFacts
                        meeting={receipt.meeting as CalendarMeeting}
                      />
                    ) : null}
                    {typeof receipt.bookingCheckedAt === "string" ? (
                      <span>
                        写入前复核{" "}
                        {new Date(receipt.bookingCheckedAt).toLocaleString(
                          "zh-CN",
                        )}
                      </span>
                    ) : null}
                    {typeof receipt.version === "number" ? (
                      <span>保存版本：{receipt.version}</span>
                    ) : null}
                    {typeof receipt.assignee === "string" ? (
                      <span>负责人：{receipt.assignee}</span>
                    ) : null}
                    {typeof receipt.dueDate === "string" ? (
                      <span>截止日期：{receipt.dueDate}</span>
                    ) : null}
                    {typeof (receipt.status ?? receipt.state) === "string" ? (
                      <span>
                        状态：
                        {receiptStateLabels[
                          String(receipt.status ?? receipt.state)
                        ] ?? String(receipt.status ?? receipt.state)}
                      </span>
                    ) : null}
                    {receipt.changed === false ? (
                      <span>已回读现有结果，没有新增修改。</span>
                    ) : null}
                    {receipt.notify === false ? (
                      <span>本次保持静默，没有发送提醒。</span>
                    ) : null}
                    {typeof receipt.summary === "string" ? (
                      <span>{receipt.summary}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                尚未取得已完成操作的回执，这不代表一定没有发生操作。请核对过程记录和当前业务对象，避免重复提交。
              </p>
            )}
            {info.modelUsage ? (
              <p className="run-detail-usage">
                {info.engine === "fixture" ? (
                  "本次为演示执行，未调用真实模型。"
                ) : (
                  <>
                    模型请求 {info.modelUsage.requests} 次
                    {info.modelUsage.incomplete
                      ? `，其中 ${info.modelUsage.incomplete} 次用量不完整`
                      : ""}
                    。
                    {info.modelUsage.costStatus === "not-configured"
                      ? "费用未配置，不能视为免费。"
                      : "费用请在模型账目中核对。"}
                  </>
                )}
              </p>
            ) : null}
            <details className="run-detail-events">
              <summary>过程记录（{events.length} 条）</summary>
              <p>记录按本次读取展示；刷新详情可核对最新记录。</p>
              <ol>
                {events.map((event) => (
                  <li key={event.eventId}>
                    <time>
                      {new Date(event.occurredAt).toLocaleTimeString("zh-CN")}
                    </time>{" "}
                    {eventLabels[event.kind] ?? "执行状态已更新"}
                  </li>
                ))}
              </ol>
              {hasMore ? (
                <button
                  disabled={loading || loadingMore}
                  onClick={() => setLoadingMore(true)}
                >
                  {loadingMore ? "正在核对后续记录…" : "加载更多记录"}
                </button>
              ) : null}
              <p>执行编号：{info.id}</p>
            </details>
          </>
        ) : null}
        <button
          disabled={loading || loadingMore}
          onClick={() => setRevision((value) => value + 1)}
        >
          刷新详情
        </button>
      </div>
    </Dialog>
  );
}
