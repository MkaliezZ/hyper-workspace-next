import { useEffect, useRef, useState } from "react";
import type { RunState, Workflow } from "@hyper/contracts";
import { api } from "../api";
import { runStateLabels } from "./RunDetails";

const workflowLabels: Record<Workflow, string> = {
  plan_work: "工作计划",
  discussion_to_minutes: "讨论纪要",
  project_report: "项目周报",
  revise_artifact: "修改成果",
  revise_task: "修改待办",
  manage_method: "方法管理",
  review_artifact: "成果验收",
  follow_up: "项目跟进",
  configure_follow_up: "定时跟进",
  configure_policy: "执行规则",
  manage_notifications: "提醒偏好",
  usage_report: "模型用量",
  manage_spending: "价格与预算",
  manage_brief: "任务说明",
  assign_task: "分配负责人",
  directory_report: "通讯录",
  manage_organization: "组织管理",
  manage_communication: "会话管理",
  manage_approval: "审批助手",
  recognize_ocr: "OCR 助手",
  draft_office: "Office 修改方案",
  apply_office: "Office 生成副本",
  manage_calendar: "日历操作",
  share_attachment: "分享附件",
  manage_decision: "项目决定",
  query_knowledge: "资料问答",
  chat: "项目讨论",
  draft_reply: "回复草稿",
  read_file: "文档解读",
  revise_file_reading: "修改文档解读",
};
interface Entry {
  id: string;
  engine: string;
  state: RunState;
  workflow: Workflow;
  createdAt: string;
}
interface Page {
  items: Entry[];
  before: string | null;
  hasMore: boolean;
}

export function RunHistoryPanel({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (run: any) => void;
}) {
  const [items, setItems] = useState<Entry[]>([]),
    [before, setBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef<AbortController | null>(null),
    generation = useRef(0);
  async function load(cursor?: string) {
    request.current?.abort();
    const controller = new AbortController(),
      version = ++generation.current;
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const page = await api<Page>(
        "/projects/" +
          projectId +
          "/runs" +
          (cursor ? "?before=" + cursor : ""),
        { signal: controller.signal },
      );
      if (version !== generation.current) return;
      setItems((current) =>
        cursor ? [...current, ...page.items] : page.items,
      );
      setBefore(page.before);
      setHasMore(page.hasMore);
    } catch (e) {
      if (version !== generation.current) return;
      setItems([]);
      setBefore(null);
      setHasMore(false);
      setError((e as Error).message);
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      request.current?.abort();
    };
  }, [projectId]);
  async function open(id: string) {
    if (busy) return;
    const controller = new AbortController(),
      version = ++generation.current;
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const actual = await api("/runs/" + id, { signal: controller.signal });
      if (version === generation.current) onOpen(actual);
    } catch (e) {
      if (version === generation.current) {
        setItems([]);
        setBefore(null);
        setHasMore(false);
        setError((e as Error).message);
      }
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }
  return (
    <section className="run-history" aria-label="本人执行记录">
      <h3>本人执行记录</h3>
      <p>
        仅展示你在当前项目发起的执行。打开时重新核对来源与私人资料权限；记录不表示操作已回滚。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <button className="secondary" disabled={busy} onClick={() => void load()}>
        刷新执行记录
      </button>
      {busy ? <p role="status">正在核对执行记录…</p> : null}
      {!busy && !error && !items.length ? (
        <p>当前项目还没有你的执行记录。</p>
      ) : null}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button
              disabled={busy}
              title={item.id}
              onClick={() => void open(item.id)}
            >
              <strong>
                {workflowLabels[item.workflow] ?? "执行"} ·{" "}
                {runStateLabels[item.state] ?? "状态待核对"}
              </strong>
              <span>
                {item.engine === "fixture"
                  ? "演示执行"
                  : item.engine.toUpperCase()}{" "}
                · {new Date(item.createdAt).toLocaleString("zh-CN")} ·{" "}
                {item.id.slice(0, 8)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && before ? (
        <button disabled={busy} onClick={() => void load(before)}>
          加载更早的执行
        </button>
      ) : null}
    </section>
  );
}
