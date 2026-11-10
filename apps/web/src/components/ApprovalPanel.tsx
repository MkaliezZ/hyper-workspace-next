import { useEffect, useRef, useState } from "react";
import type { Subject } from "@hyper/contracts";
import {
  type ApprovalAction,
  type ApprovalDetail,
  type ApprovalFlow,
  type ApprovalForm,
  type ApprovalState,
  type ApprovalSummary,
} from "@hyper/contracts/approvals";
import { api, ApiError, mutation } from "../api";
import { Dialog } from "./Dialog";
import { ApprovalMemberLookup } from "./ApprovalMemberLookup";
import { ApprovalFlowEditor } from "./ApprovalFlowEditor";

const states: Record<ApprovalState, string> = {
  draft: "草稿",
  active: "审批中",
  returned: "已退回",
  approved: "已通过",
  rejected: "已拒绝",
  withdrawn: "已撤回",
};
const actions: Record<string, string> = {
  open: "创建草稿",
  submit: "确认提交",
  review: "记录审批",
  withdraw: "撤回申请",
  transfer: "转交审批",
  remind: "催办",
};
const decisions: Record<string, string> = {
  approve: "同意",
  reject: "拒绝",
  return: "退回",
};
type Summary = ApprovalSummary & { title: string };
type Reminder = { requestId: string; step: string; recordedAt: string };
type WithoutKey<T> = T extends unknown ? Omit<T, "idempotencyKey"> : never;
type Action = WithoutKey<ApprovalAction>;
type PendingAction = Exclude<
  Action,
  { operation: "submit" } | { operation: "remind" }
>;

function ApprovalCase({
  entry,
  user,
  busy,
  error,
  send,
}: {
  entry: ApprovalDetail;
  user: Subject;
  busy: boolean;
  error: string;
  send: (action: Action) => Promise<boolean>;
}) {
  const applicant = user.id === entry.applicantId;
  const editing = applicant && ["draft", "returned"].includes(entry.state);
  const [form, setForm] = useState(entry.form);
  const [confirmation, setConfirmation] = useState<PendingAction | null>(null);
  function setField(key: string, value: ApprovalForm[string] | undefined) {
    setForm((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }
  const name = (id: string) => entry.people[id] ?? id.slice(0, 8);
  return (
    <article className="approval-case" aria-label="审批详情">
      <header className="approval-heading">
        <div>
          <h3>{entry.definition.title}</h3>
          <span className="muted">
            流程 v{entry.flowVersion} · 申请版本 {entry.revision} · 申请人{" "}
            {name(entry.applicantId)}
          </span>
        </div>
        <strong>{states[entry.state]}</strong>
      </header>
      {editing ? (
        <form
          className="approval-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send({
              operation: "submit",
              expectedRevision: entry.revision,
              form,
              confirmed: true,
            });
          }}
        >
          {entry.definition.fields.map((field) => (
            <label key={field.key}>
              {field.label}
              {field.required ? "（必填）" : ""}
              {field.kind === "choice" || field.kind === "boolean" ? (
                <select
                  aria-label={field.label}
                  required={field.required}
                  value={String(form[field.key] ?? "")}
                  onChange={(e) =>
                    setField(
                      field.key,
                      e.target.value === ""
                        ? undefined
                        : field.kind === "boolean"
                          ? e.target.value === "true"
                          : e.target.value,
                    )
                  }
                >
                  <option value="">请选择</option>
                  {field.kind === "boolean" ? (
                    <>
                      <option value="true">是</option>
                      <option value="false">否</option>
                    </>
                  ) : (
                    field.options.map((option) => (
                      <option key={option}>{option}</option>
                    ))
                  )}
                </select>
              ) : field.kind === "integer" ? (
                <input
                  aria-label={field.label}
                  required={field.required}
                  type="number"
                  step="1"
                  value={
                    form[field.key] === undefined ? "" : String(form[field.key])
                  }
                  onChange={(e) =>
                    setField(
                      field.key,
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
                    )
                  }
                />
              ) : (
                <textarea
                  aria-label={field.label}
                  required={field.required}
                  maxLength={4000}
                  value={String(form[field.key] ?? "")}
                  onChange={(e) =>
                    setField(field.key, e.target.value || undefined)
                  }
                />
              )}
            </label>
          ))}
          <button type="submit" className="primary" disabled={busy}>
            确认提交申请
          </button>
        </form>
      ) : (
        <dl className="approval-fields">
          {entry.definition.fields.map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd>
                {typeof entry.form[field.key] === "boolean"
                  ? entry.form[field.key]
                    ? "是"
                    : "否"
                  : (entry.form[field.key] ?? "未填写")}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {entry.stages.map((stage, index) => (
        <section key={index} className="approval-stage">
          <h4>
            {index + 1}. {stage.label}
            {entry.state === "active" && entry.stage === index
              ? " · 当前阶段"
              : ""}
          </h4>
          {stage.steps.map((step) => (
            <div className="approval-step" key={step.key}>
              <strong>
                {step.label} · {step.requiredApprovals} 人同意
              </strong>
              <ul>
                {step.assignments.map((item) => {
                  const active =
                    entry.state === "active" &&
                    entry.stage === index &&
                    step.state === "active" &&
                    !item.decision;
                  const target = {
                    step: step.key,
                    attempt: entry.attempt,
                    assignmentVersion: item.version,
                    confirmed: true as const,
                  };
                  return (
                    <li key={item.reviewerId}>
                      <span>
                        {name(item.reviewerId)} ·{" "}
                        {item.decision
                          ? decisions[item.decision]
                          : active
                            ? "待处理"
                            : "未处理"}
                      </span>
                      {active && item.reviewerId === user.id ? (
                        <div className="approval-actions">
                          {(["approve", "return", "reject"] as const).map(
                            (decision) => (
                              <button
                                key={decision}
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  setConfirmation({
                                    ...target,
                                    operation: "review",
                                    decision,
                                    comment: "",
                                  })
                                }
                              >
                                {decisions[decision]}
                              </button>
                            ),
                          )}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              setConfirmation({
                                ...target,
                                operation: "transfer",
                                recipientId: "",
                                comment: "",
                              })
                            }
                          >
                            转交
                          </button>
                        </div>
                      ) : null}
                      {active && applicant ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void send({
                              ...target,
                              operation: "remind",
                              recipientId: item.reviewerId,
                            })
                          }
                        >
                          催办 {name(item.reviewerId)}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      ))}
      {applicant && ["draft", "returned", "active"].includes(entry.state) ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            setConfirmation({
              operation: "withdraw",
              expectedRevision: entry.revision,
              comment: "",
              confirmed: true,
            })
          }
        >
          撤回申请
        </button>
      ) : null}
      <details className="approval-audit">
        <summary>审批记录（{entry.audit.length}）</summary>
        <ul>
          {entry.audit.map((event) => (
            <li key={event.id}>
              {new Date(event.recordedAt).toLocaleString("zh-CN")} ·{" "}
              {name(event.actorId)} · {actions[event.action] ?? event.action}
              {event.audit.decision
                ? " · " + decisions[event.audit.decision]
                : ""}
              {event.audit.comment ? <p>{event.audit.comment}</p> : null}
            </li>
          ))}
        </ul>
      </details>
      {confirmation ? (
        <Dialog
          title={
            confirmation.operation === "review"
              ? "确认" + decisions[confirmation.decision]
              : actions[confirmation.operation]!
          }
          onClose={() => setConfirmation(null)}
          error={error}
          dismissible={!busy}
        >
          <form
            className="approval-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send(confirmation).then((ok) => {
                if (ok) setConfirmation(null);
              });
            }}
          >
            {confirmation.operation === "transfer" ? (
              <>
                <ApprovalMemberLookup
                  onSelect={(recipientId) =>
                    setConfirmation({ ...confirmation, recipientId })
                  }
                />
                <label>
                  接收员工 ID
                  <input
                    required
                    value={confirmation.recipientId}
                    onChange={(e) =>
                      setConfirmation({
                        ...confirmation,
                        recipientId: e.target.value,
                      })
                    }
                  />
                </label>
              </>
            ) : null}
            <label>
              处理说明
              <textarea
                aria-label="处理说明"
                maxLength={2000}
                required={
                  confirmation.operation !== "review" ||
                  confirmation.decision !== "approve"
                }
                value={confirmation.comment}
                onChange={(e) =>
                  setConfirmation({ ...confirmation, comment: e.target.value })
                }
              />
            </label>
            <button type="submit" className="primary" disabled={busy}>
              确认操作
            </button>
          </form>
        </Dialog>
      ) : null}
    </article>
  );
}

export function ApprovalPanel({ user }: { user: Subject }) {
  const [flows, setFlows] = useState<ApprovalFlow[]>([]);
  const [items, setItems] = useState<Summary[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [flowId, setFlowId] = useState("");
  const [selected, setSelected] = useState("");
  const [entry, setEntry] = useState<ApprovalDetail | null>(null);
  const [editor, setEditor] = useState<{ previous?: ApprovalFlow } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    void Promise.all([
      api<ApprovalFlow[]>("/approvals/flows", options),
      api<Summary[]>("/approvals/requests", options),
      api<Reminder[]>("/approvals/reminders", options),
    ])
      .then(([nextFlows, nextItems, nextReminders]) => {
        if (controller.signal.aborted) return;
        setFlows(nextFlows);
        setItems(nextItems);
        setReminders(nextReminders);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setFlows([]);
        setItems([]);
        setReminders([]);
        setEntry(null);
        setError(e.message);
      });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void api<ApprovalDetail>("/approvals/requests/" + selected, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setEntry(result);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setEntry(null);
          setError(e.message);
        }
      });
    return () => controller.abort();
  }, [selected, reload]);

  function select(id: string) {
    if (selected !== id) setEntry(null);
    setSelected(id);
    setError("");
    setNotice("");
  }

  async function save<T>(
    path: string,
    body: object,
    success: string,
  ): Promise<T | undefined> {
    const fingerprint = JSON.stringify([path, body]);
    if (pending.current?.fingerprint !== fingerprint)
      pending.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await mutation<T>(path, {
        ...body,
        idempotencyKey: pending.current.key,
      });
      pending.current = null;
      setReload((version) => version + 1);
      setNotice(success);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "审批操作暂时不可用。");
      if (e instanceof ApiError && [401, 403, 404, 409].includes(e.status)) {
        setEntry(null);
        setReload((version) => version + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  const flow = flows.find((item) => item.id === flowId);
  return (
    <section className="approval-panel" aria-label="企业审批">
      <header className="approval-heading">
        <div>
          <h2>企业审批</h2>
          <p>发起申请、处理当前分派并核对审批记录。</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setError("");
            setReload((value) => value + 1);
          }}
        >
          刷新
        </button>
      </header>
      {error ? (
        <p role="alert" className="error-banner">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="approval-intake">
        <label>
          审批流程
          <select
            aria-label="审批流程"
            value={flowId}
            onChange={(e) => setFlowId(e.target.value)}
          >
            <option value="">选择流程</option>
            {flows.map((item) => (
              <option key={item.id} value={item.id}>
                {item.definition.title} · v{item.version}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          disabled={!flow || busy}
          onClick={() => {
            if (flow)
              void save<ApprovalSummary>(
                "/approvals/requests",
                { flowId: flow.id, version: flow.version },
                "申请草稿已创建。",
              ).then((result) => {
                if (result) select(result.id);
              });
          }}
        >
          发起申请
        </button>
        {user.role === "admin" ? (
          <>
            <button type="button" onClick={() => setEditor({})}>
              发布新流程
            </button>
            <button
              type="button"
              disabled={!flow}
              onClick={() => {
                if (flow) setEditor({ previous: flow });
              }}
            >
              编辑并发布新版本
            </button>
          </>
        ) : null}
      </div>
      {reminders.length ? (
        <section className="approval-reminders" aria-label="待处理催办">
          <h3>待处理催办</h3>
          <ul>
            {reminders.map((item) => (
              <li key={item.requestId + item.step + item.recordedAt}>
                <button type="button" onClick={() => select(item.requestId)}>
                  {items.find((request) => request.id === item.requestId)
                    ?.title ?? "审批申请"}{" "}
                  · {new Date(item.recordedAt).toLocaleString("zh-CN")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="approval-workspace">
        <nav aria-label="我的审批申请" className="approval-list">
          <h3>我的申请与待审</h3>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={selected === item.id ? "true" : undefined}
              onClick={() => select(item.id)}
            >
              <strong>{item.title}</strong>
              <span>
                {states[item.state]} · v{item.flowVersion}
              </span>
            </button>
          ))}
          {!items.length ? <p className="muted">暂无可访问的申请。</p> : null}
        </nav>
        {entry?.id === selected ? (
          <ApprovalCase
            key={entry.id + ":" + entry.revision}
            entry={entry}
            user={user}
            busy={busy}
            error={error}
            send={async (body) =>
              !!(await save(
                "/approvals/requests/" + entry.id + "/actions",
                body,
                body.operation === "remind"
                  ? "催办已记录。"
                  : "审批操作已保存。",
              ))
            }
          />
        ) : (
          <p className="muted">选择申请查看详情。</p>
        )}
      </div>
      {editor ? (
        <ApprovalFlowEditor
          previous={editor.previous}
          busy={busy}
          error={error}
          onClose={() => {
            setEditor(null);
            setError("");
          }}
          onSave={async (definition) => {
            const previous = editor.previous;
            const result = await save<ApprovalFlow>(
              "/approvals/flows",
              {
                definition,
                ...(previous
                  ? { previous: { id: previous.id, version: previous.version } }
                  : {}),
              },
              "审批流程版本已发布。",
            );
            if (result) {
              setFlowId(result.id);
              setEditor(null);
            }
          }}
        />
      ) : null}
    </section>
  );
}
