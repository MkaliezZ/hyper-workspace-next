import { useEffect, useRef, useState } from "react";
import type { WorkspaceView } from "@hyper/contracts";
import type {
  CalendarLink,
  CalendarLinkChange,
  CalendarLinkReceipt,
  CalendarLinkTarget,
  CalendarOccurrence,
} from "@hyper/contracts/calendar";
import { api, ApiError, mutation } from "../api";
import { Dialog } from "./Dialog";

export function CalendarLinkDialog({
  event,
  view,
  onClose,
  onUnavailable,
  onAi,
  aiUnavailable,
}: {
  event: CalendarOccurrence;
  view: WorkspaceView;
  onClose: () => void;
  onUnavailable: (error: unknown) => void;
  onAi?: (change: CalendarLinkChange) => Promise<void>;
  aiUnavailable: boolean;
}) {
  const { calendarId, objectId, etag } = event;
  const [projectId, setProjectId] = useState(view.project.id);
  const [taskId, setTaskId] = useState("");
  const [otherTasks, setOtherTasks] = useState<WorkspaceView["tasks"]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [links, setLinks] = useState<CalendarLink[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [taskError, setTaskError] = useState("");
  const [receipt, setReceipt] = useState<CalendarLinkReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const tasks = projectId === view.project.id ? view.tasks : otherTasks;

  useEffect(() => {
    const controller = new AbortController();
    setLinks(null);
    void api<CalendarLink[]>("/calendar/links/query", {
      method: "POST",
      body: JSON.stringify({ calendarId, objectId, etag }),
      signal: controller.signal,
    })
      .then(setLinks)
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status))
          onUnavailable(e);
        else setError(e.message);
      });
    return () => controller.abort();
  }, [calendarId, objectId, etag, revision, onUnavailable]);

  useEffect(() => {
    if (!projectId || projectId === view.project.id) return;
    const controller = new AbortController();
    setLoadingTasks(true);
    void api<WorkspaceView>(
      "/workspace?projectId=" + encodeURIComponent(projectId),
      {
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (result.project.id === projectId) setOtherTasks(result.tasks);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setTaskError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingTasks(false);
      });
    return () => controller.abort();
  }, [projectId, view.project.id]);

  async function change(target: CalendarLinkTarget, linked: boolean) {
    const base = {
      event: { calendarId, objectId, etag },
      target,
      linked,
      confirmed: true as const,
    };
    const fingerprint = JSON.stringify(base);
    if (pending.current?.fingerprint !== fingerprint)
      pending.current = { fingerprint, key: crypto.randomUUID() };
    const input = { ...base, idempotencyKey: pending.current.key };
    setBusy(true);
    setError("");
    setReceipt(null);
    try {
      if (onAi) {
        await onAi(input);
        onClose();
      } else {
        setReceipt(
          await mutation<CalendarLinkReceipt>("/calendar/links/change", input),
        );
        setRevision((value) => value + 1);
      }
      pending.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法保存日程关联。");
      if (e instanceof ApiError && [401, 403, 404].includes(e.status))
        setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  const task = tasks.find((item) => item.id === taskId);
  const ready = links !== null && !busy && !aiUnavailable;
  return (
    <Dialog
      title="关联项目与待办"
      error={error}
      onClose={onClose}
      dismissible={!busy}
    >
      <div className="calendar-form">
        <p>{event.title || "未命名日程"}</p>
        <p className="muted">
          此关联仅本人可见。重复日程的关联适用于整个系列。
        </p>
        <label>
          项目
          <select
            aria-label="关联项目"
            value={projectId}
            disabled={busy}
            onChange={(e) => {
              setProjectId(e.target.value);
              setTaskId("");
              setOtherTasks([]);
              setLoadingTasks(false);
              setTaskError("");
            }}
          >
            {view.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          待办
          <select
            aria-label="关联待办"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            disabled={busy || loadingTasks}
          >
            <option value="">仅关联项目</option>
            {tasks
              .filter((item) => item.version)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </label>
        {taskError ? <p role="status">{taskError}</p> : null}
        <button
          type="button"
          className="primary"
          disabled={!ready || !projectId || (!!taskId && !task?.version)}
          onClick={() =>
            void change(
              task?.version
                ? {
                    kind: "task",
                    projectId,
                    taskId: task.id,
                    taskVersion: task.version,
                  }
                : { kind: "project", projectId },
              true,
            )
          }
        >
          {onAi ? "确认由 AI 保存关联" : "确认保存关联"}
        </button>
        {aiUnavailable ? (
          <p className="muted">请选择可用的执行器和模型连接。</p>
        ) : null}
        {receipt ? (
          <p role="status">{receipt.linked ? "关联已保存" : "关联已移除"}</p>
        ) : null}
        <h3>当前关联</h3>
        {links?.length ? (
          links.map(({ target, label }) => (
            <div
              className="calendar-receipt"
              key={target.kind === "task" ? target.taskId : target.projectId}
            >
              <span>
                {target.kind === "task" ? "待办" : "项目"} · {label}
              </span>
              <button
                type="button"
                disabled={!ready}
                onClick={() => void change(target, false)}
              >
                {onAi ? "确认由 AI 移除" : "确认移除"}
              </button>
            </div>
          ))
        ) : (
          <p className="muted">
            {links ? "暂无可访问的关联。" : "正在核对关联权限。"}
          </p>
        )}
      </div>
    </Dialog>
  );
}
