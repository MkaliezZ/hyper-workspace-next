import { useEffect, useMemo, useRef, useState } from "react";
import type {
  OfficeLink,
  RunState,
  SourceFile,
  WorkspaceView,
} from "@hyper/contracts";
import type {
  OfficeInspectionResult,
  OfficeOperation,
  OfficeProposalResult,
} from "@hyper/contracts/office";
import type { ModelSummary } from "./ModelSettings";
import { api, ApiError, mutation } from "../api";
import { Dialog } from "./Dialog";
import { runStateLabels } from "./RunDetails";

type Run = { id: string; state: RunState };
type History = Run & { engine: string; workflow: string; createdAt: string };
type Target = { key: string; label: string; operation: OfficeOperation };
const stateLabels: Record<OfficeProposalResult["state"], string> = {
  prepared: "待确认",
  processing: "正在生成",
  applying: "正在保存",
  succeeded: "已保存副本",
  failed: "未完成",
  cancelled: "已取消",
  recovery_required: "保存结果待核对",
};
function positionLabel(key: string, inspected?: OfficeInspectionResult) {
  const paragraph = /^paragraph:(\d+)$/.exec(key);
  if (paragraph) return `段落 ${Number(paragraph[1]) + 1}`;
  const shape = /^slide:(\d+)\/shape:(\d+)$/.exec(key);
  if (shape)
    return `幻灯片 ${Number(shape[1]) + 1} · 文本框 ${Number(shape[2]) + 1}`;
  const cell = /^(sheet:\d+)\/(.+)$/.exec(key);
  if (cell && inspected && "sheets" in inspected.inspection)
    return `${inspected.inspection.sheets.find((s) => s.id === cell[1])?.name ?? "工作表"}!${cell[2]}`;
  return key;
}
function description(op: OfficeOperation, inspected?: OfficeInspectionResult) {
  return op.kind === "calc.set"
    ? positionLabel(`${op.sheet}/${op.cell}`, inspected)
    : op.kind === "writer.append"
      ? "文档末尾新增段落"
      : positionLabel(op.target, inspected);
}
function changedValue(op: OfficeOperation) {
  return op.kind === "calc.set"
    ? String(op.value.value ?? "（清空）")
    : op.text;
}

export function OfficeToolsDialog({
  file,
  engines,
  run,
  onRun,
  onClose,
}: {
  file: SourceFile;
  engines: WorkspaceView["engines"];
  run: Run | null;
  onRun: (value: Run) => void;
  onClose: () => void;
}) {
  const [inspection, setInspection] = useState<OfficeInspectionResult>();
  const [proposals, setProposals] = useState<OfficeProposalResult[]>([]);
  const [proposal, setProposal] = useState<OfficeProposalResult>();
  const [operations, setOperations] = useState<OfficeOperation[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [destination, setDestination] = useState(
    file.path.slice(0, -1).join("/"),
  );
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [cellType, setCellType] = useState<
    "string" | "number" | "formula" | "empty"
  >("string");
  const [editIndex, setEditIndex] = useState<number>();
  const [editorDirty, setEditorDirty] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [executor, setExecutor] = useState<"manual" | "dsh" | "hermes">(
    "manual",
  );
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelId, setModelId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [runId, setRunId] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [outputLink, setOutputLink] = useState<OfficeLink>();
  const alive = useRef(true);
  const pending = useRef<{ fingerprint: string; key: string } | undefined>(
    undefined,
  );
  const source = useMemo(
    () => ({ path: file.path, expectedId: file.id, expectedEtag: file.etag }),
    [file],
  );
  const selectedRun = run?.id === runId ? run : undefined;
  const running =
    selectedRun?.state === "queued" || selectedRun?.state === "running";
  const engine = executor === "manual" ? undefined : engines[executor];
  const compatible = models.filter(
    (m) =>
      m.purpose === "chat" &&
      (!engine?.modelProviders || engine.modelProviders.includes(m.provider)),
  );
  const aiReady =
    !!engine?.configured && compatible.some((m) => m.id === modelId);
  const dirty =
    !!proposal &&
    JSON.stringify(operations) !== JSON.stringify(proposal.operations);
  const editable =
    !proposal ||
    proposal.state === "prepared" ||
    (proposal.state === "failed" && proposal.retryable);

  const targets = useMemo<Target[]>(() => {
    const value = inspection?.inspection;
    if (!value) return [];
    if ("paragraphs" in value)
      return [
        {
          key: "document:end",
          label: "在文档末尾新增段落",
          operation: {
            kind: "writer.append",
            target: "document:end",
            text: "",
          },
        },
        ...value.paragraphs
          .filter((p) => p.editable)
          .map((p) => ({
            key: p.id,
            label: `段落 ${Number(p.id.split(":")[1]) + 1} · ${p.text.slice(0, 70) || "空段落"}`,
            operation: {
              kind: "writer.replace" as const,
              target: p.id,
              expectedText: p.text,
              text: p.text,
            },
          })),
      ];
    if ("sheets" in value)
      return value.sheets.flatMap((s) =>
        s.cells
          .filter((c) => c.editable)
          .map((c) => ({
            key: s.id + "/" + c.address,
            label: `${s.name}!${c.address} · ${c.display.slice(0, 70) || "空单元格"}`,
            operation: {
              kind: "calc.set",
              sheet: s.id,
              cell: c.address,
              expected: { type: c.type, value: c.value },
              value: { type: c.type, value: c.value },
            } as OfficeOperation,
          })),
      );
    return value.slides.flatMap((s) =>
      s.shapes
        .filter((p) => p.editable)
        .map((p) => ({
          key: p.id,
          label: `幻灯片 ${Number(s.id.split(":")[1]) + 1} · ${p.text.slice(0, 70) || "空文本框"}`,
          operation: {
            kind: "impress.replace" as const,
            target: p.id,
            expectedText: p.text,
            text: p.text,
          },
        })),
    );
  }, [inspection]);

  function clearPrivate() {
    setInspection(undefined);
    setProposal(undefined);
    setProposals([]);
    setOperations([]);
    setText("");
    setEditorDirty(false);
    setInstruction("");
    setHistory([]);
    setOutputLink(undefined);
    setConfirmed(false);
  }
  function selectProposal(value?: OfficeProposalResult) {
    if (value?.sourceStatus === "invalidated") {
      clearPrivate();
      setError("来源权限或版本已变化，请刷新文件夹后重新选择。");
      return;
    }
    setProposal(value);
    setOperations(value?.operations ?? []);
    setEditIndex(undefined);
    setTarget("");
    setText("");
    setEditorDirty(false);
    setConfirmed(false);
    setOutputLink(undefined);
    setNotice("");
    if (value?.destination) setDestination(value.destination.join("/"));
  }
  async function refreshProposals(preferRun?: string) {
    const rows = await api<OfficeProposalResult[]>("/office/proposals");
    if (!alive.current) return;
    const selected = rows.filter(
      (p) =>
        p.source?.expectedId === source.expectedId &&
        p.source.expectedEtag === source.expectedEtag,
    );
    setProposals(selected);
    const found = preferRun
      ? selected.find(
          (p) => p.sourceRunId === preferRun || p.applyRunId === preferRun,
        )
      : undefined;
    if (found) selectProposal(found);
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    clearPrivate();
    setLoading(true);
    setError("");
    void Promise.all([
      api<OfficeInspectionResult>("/office/inspect", {
        method: "POST",
        body: JSON.stringify(source),
        signal: controller.signal,
      }),
      api<History[]>("/office/lookup", {
        method: "POST",
        body: JSON.stringify(source),
        signal: controller.signal,
      }),
      api<ModelSummary[]>("/models", { signal: controller.signal }),
    ])
      .then(async ([observed, runs, available]) => {
        if (controller.signal.aborted) return;
        setInspection(observed);
        setHistory(runs);
        setModels(available);
        await refreshProposals();
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          clearPrivate();
          setError(e.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [source]);
  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    const check = () => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      void api<History[]>("/office/lookup", {
        method: "POST",
        body: JSON.stringify(source),
        signal: controller.signal,
      })
        .then((rows) => {
          if (!controller.signal.aborted) setHistory(rows);
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            clearPrivate();
            setError(e.message);
          }
        })
        .finally(() => {
          checking = false;
        });
    };
    const timer = setInterval(check, 8000);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [source]);
  useEffect(() => {
    if (selectedRun && !["queued", "running"].includes(selectedRun.state))
      void refreshProposals(runId).catch((e) => {
        if (alive.current) setError(e.message);
      });
  }, [selectedRun?.state, runId]);
  useEffect(() => {
    setConfirmed(false);
  }, [operations, proposal?.revision, editorDirty]);

  async function save<T>(
    path: string,
    body: object,
    receive: (value: T) => void,
  ) {
    const fingerprint = JSON.stringify([path, body]);
    if (pending.current?.fingerprint !== fingerprint)
      pending.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await mutation<T>(path, {
        ...body,
        idempotencyKey: pending.current.key,
      });
      if (!alive.current) return;
      pending.current = undefined;
      receive(value);
      await refreshProposals();
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && [401, 403, 404, 410, 412].includes(e.status))
        clearPrivate();
      setError(e instanceof Error ? e.message : "操作未完成，请核对当前回执。");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function chooseTarget(key: string, op?: OfficeOperation, index?: number) {
    const value = op ?? targets.find((t) => t.key === key)?.operation;
    setTarget(key);
    setEditIndex(index);
    setEditorDirty(false);
    if (!value) return;
    setText(
      value.kind === "calc.set" ? String(value.value.value ?? "") : value.text,
    );
    if (value.kind === "calc.set")
      setCellType(value.value.type === "empty" ? "string" : value.value.type);
  }
  function addOperation() {
    const selected = targets.find((t) => t.key === target);
    if (!selected) return;
    const base = selected.operation;
    let op: OfficeOperation;
    if (base.kind === "calc.set") {
      if (
        cellType === "number" &&
        (!text.trim() || !Number.isFinite(Number(text)))
      ) {
        setError("请输入有效数字。");
        return;
      }
      op = {
        ...base,
        value:
          cellType === "empty" || (cellType === "string" && text === "")
            ? { type: "empty", value: null }
            : cellType === "number"
              ? { type: "number", value: Number(text) }
              : { type: cellType, value: text },
      };
    } else op = { ...base, text };
    const key = (o: OfficeOperation) =>
      o.kind === "calc.set" ? o.sheet + "/" + o.cell : o.target;
    if (operations.some((o, i) => i !== editIndex && key(o) === key(op))) {
      setError("该位置已有修改，请编辑已有条目。");
      return;
    }
    setOperations(
      editIndex === undefined
        ? [...operations, op]
        : operations.map((o, i) => (i === editIndex ? op : o)),
    );
    setEditIndex(undefined);
    setEditorDirty(false);
    setError("");
  }
  function publish() {
    if (!proposal || !confirmed || dirty || editorDirty) return;
    const body = { confirmed: true, expectedRevision: proposal.revision };
    if (executor === "manual")
      void save<OfficeProposalResult>(
        `/office/proposals/${proposal.id}/apply`,
        body,
        selectProposal,
      );
    else
      void save<Run>(
        "/office/runs",
        {
          plan: { operation: "apply", proposalId: proposal.id, ...body },
          engine: executor,
          modelProfileId: modelId,
        },
        (r) => {
          setRunId(r.id);
          onRun(r);
        },
      );
  }

  return (
    <Dialog title="Office 助手" wide onClose={onClose} error={error}>
      <div className="dialog-form office-tools">
        <strong>{file.name}</strong>
        <p className="muted">
          先选择修改位置或让助手起草方案。核对修改前后的内容，再确认生成可编辑副本；原文件继续保留。
        </p>
        {loading ? <p role="status">正在读取文档结构…</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {inspection ? (
          <>
            <div className="office-tools-controls">
              <label>
                执行方式
                <select
                  value={executor}
                  disabled={busy || running}
                  onChange={(e) => {
                    setExecutor(e.target.value as typeof executor);
                    setModelId("");
                  }}
                >
                  <option value="manual">人工操作</option>
                  <option value="dsh">DSH 助手</option>
                  <option value="hermes">Hermes 助手</option>
                </select>
              </label>
              {executor !== "manual" ? (
                <label>
                  模型
                  <select
                    value={modelId}
                    disabled={busy || running}
                    onChange={(e) => setModelId(e.target.value)}
                  >
                    <option value="">选择已配置的模型</option>
                    {compatible.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {executor !== "manual" && !engine?.configured ? (
                <p className="muted">此执行器尚未配置。</p>
              ) : null}
            </div>
            <label>
              副本保存目录
              <input
                value={destination}
                disabled={!!proposal || busy || running}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="留空为个人文件根目录"
              />
            </label>
            {proposal ? (
              <div className="office-tools-controls">
                <strong>
                  方案版本 {proposal.revision} · {stateLabels[proposal.state]}
                </strong>
                <button
                  disabled={busy || running}
                  onClick={() => selectProposal()}
                >
                  另建方案
                </button>
              </div>
            ) : null}
            {!proposal && executor !== "manual" ? (
              <section aria-label="Office 起草要求">
                <label>
                  希望如何修改
                  <textarea
                    value={instruction}
                    maxLength={4000}
                    onChange={(e) => setInstruction(e.target.value)}
                    disabled={busy || running}
                    placeholder="例如：把第二段整理成更清晰的项目说明，保留原有事实。"
                  />
                </label>
                <button
                  className="primary"
                  disabled={!aiReady || !instruction.trim() || busy || running}
                  onClick={() =>
                    void save<Run>(
                      "/office/runs",
                      {
                        plan: {
                          operation: "draft",
                          source,
                          expectedSha256: inspection.sourceSha256,
                          destination: destination
                            ? destination.split("/")
                            : [],
                          instruction,
                        },
                        engine: executor,
                        modelProfileId: modelId,
                      },
                      (r) => {
                        setRunId(r.id);
                        onRun(r);
                      },
                    )
                  }
                >
                  起草修改方案
                </button>
              </section>
            ) : null}
            {editable ? (
              <section aria-label="编辑 Office 修改方案">
                <label>
                  修改位置
                  <select
                    value={target}
                    disabled={busy || running}
                    onChange={(e) => chooseTarget(e.target.value)}
                  >
                    <option value="">选择可编辑的位置</option>
                    {targets.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                {targets.find((t) => t.key === target)?.operation.kind ===
                "calc.set" ? (
                  <label>
                    内容类型
                    <select
                      value={cellType}
                      onChange={(e) => {
                        setCellType(e.target.value as typeof cellType);
                        setEditorDirty(true);
                      }}
                    >
                      <option value="string">文字</option>
                      <option value="number">数字</option>
                      <option value="formula">公式</option>
                      <option value="empty">清空</option>
                    </select>
                  </label>
                ) : null}
                <label>
                  修改后内容
                  <textarea
                    value={text}
                    maxLength={4000}
                    onChange={(e) => {
                      setText(e.target.value);
                      setEditorDirty(true);
                    }}
                    disabled={busy || running || !target}
                  />
                </label>
                <p className="muted small">
                  段落和文本框按纯文本替换，所选位置的字内格式可能变化。表格公式支持常用求和、平均值和现有工作表引用。
                </p>
                <button
                  disabled={
                    !target ||
                    busy ||
                    running ||
                    (editIndex === undefined && operations.length >= 32)
                  }
                  onClick={addOperation}
                >
                  {editIndex === undefined ? "加入修改方案" : "更新此条修改"}
                </button>
                {editorDirty || editIndex !== undefined ? (
                  <button
                    disabled={busy || running}
                    onClick={() => {
                      setTarget("");
                      setText("");
                      setEditIndex(undefined);
                      setEditorDirty(false);
                    }}
                  >
                    放弃输入
                  </button>
                ) : null}
                {editorDirty ? (
                  <p role="status">
                    输入尚未加入修改方案，请先更新条目或放弃输入。
                  </p>
                ) : null}
              </section>
            ) : null}
            {operations.length ? (
              <section aria-label="待保存的修改">
                <h3>修改条目</h3>
                <ol>
                  {operations.map((op, i) => (
                    <li key={i}>
                      <strong>{description(op, inspection)}</strong>
                      <p>{changedValue(op)}</p>
                      {editable ? (
                        <div className="office-tools-controls">
                          <button
                            disabled={busy || running}
                            onClick={() =>
                              chooseTarget(
                                op.kind === "calc.set"
                                  ? op.sheet + "/" + op.cell
                                  : op.target,
                                op,
                                i,
                              )
                            }
                          >
                            编辑条目 {i + 1}
                          </button>
                          <button
                            disabled={busy || running}
                            onClick={() => {
                              setOperations(
                                operations.filter((_, j) => j !== i),
                              );
                              setEditIndex(undefined);
                            }}
                          >
                            移除条目 {i + 1}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
            {editable ? (
              <button
                className="primary"
                disabled={
                  busy ||
                  running ||
                  !operations.length ||
                  editorDirty ||
                  (!!proposal && !dirty && !proposal.retryable)
                }
                onClick={() => {
                  const body = proposal
                    ? { expectedRevision: proposal.revision, operations }
                    : {
                        source,
                        expectedSha256: inspection.sourceSha256,
                        operations,
                        destination: destination ? destination.split("/") : [],
                      };
                  void save<OfficeProposalResult>(
                    proposal
                      ? `/office/proposals/${proposal.id}/edit`
                      : "/office/proposals",
                    body,
                    selectProposal,
                  );
                }}
              >
                校验并保存方案
              </button>
            ) : null}
            {proposal?.preview ? (
              <section aria-label="Office 修改前后对照">
                <h3>已保存方案 · 版本 {proposal.revision}</h3>
                <div className="office-preview-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>位置</th>
                        <th>修改前</th>
                        <th>修改后</th>
                      </tr>
                    </thead>
                    <tbody>
                      {proposal.preview.operations.map((op, i) => (
                        <tr key={i}>
                          <th>{positionLabel(op.target, inspection)}</th>
                          <td>
                            {typeof op.before === "object"
                              ? String(op.before?.value ?? "")
                              : op.before}
                          </td>
                          <td>
                            {typeof op.after === "object"
                              ? String(op.after.value ?? "")
                              : op.after}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted small">
                  已生成测试副本并重新打开核对。
                  {proposal.preview.recalculated ? "工作簿已重新计算。" : ""}
                  {proposal.preview.formulaErrors.length
                    ? `现有公式中有 ${proposal.preview.formulaErrors.length} 个错误，请核对。`
                    : ""}
                </p>
                {proposal.preview.formulaErrors.length ? (
                  <ul>
                    {proposal.preview.formulaErrors.map((e, i) => (
                      <li key={i}>
                        {e.sheet} · {e.cell} · 错误 {e.error}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
            {proposal?.state === "prepared" ? (
              <>
                {dirty ? (
                  <p role="status">修改条目尚未保存，请先校验并保存方案。</p>
                ) : null}
                <label className="office-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={dirty || editorDirty || busy || running}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我已核对版本 {proposal.revision}{" "}
                  的修改及保存目录，确认生成新副本。
                </label>
                <button
                  className="primary"
                  disabled={
                    !confirmed ||
                    dirty ||
                    editorDirty ||
                    busy ||
                    running ||
                    (executor !== "manual" && !aiReady)
                  }
                  onClick={publish}
                >
                  确认生成可编辑副本
                </button>
              </>
            ) : null}
            {proposal &&
            [
              "prepared",
              "processing",
              "applying",
              "recovery_required",
            ].includes(proposal.state) ? (
              <button
                disabled={busy}
                onClick={() =>
                  void save<OfficeProposalResult>(
                    `/office/proposals/${proposal.id}/cancel`,
                    { expectedRevision: proposal.revision },
                    selectProposal,
                  )
                }
              >
                停止后续处理
              </button>
            ) : null}
            {proposal &&
            [
              "applying",
              "processing",
              "recovery_required",
              "succeeded",
            ].includes(proposal.state) ? (
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void mutation<OfficeProposalResult>(
                    `/office/proposals/${proposal.id}/reconcile`,
                    {},
                  )
                    .then((value) => {
                      if (alive.current) selectProposal(value);
                    })
                    .catch((e) => {
                      if (alive.current) setError(e.message);
                    })
                    .finally(() => {
                      if (alive.current) setBusy(false);
                    });
                }}
              >
                核对实际保存结果
              </button>
            ) : null}
            {proposal?.state === "recovery_required" ? (
              <p role="status">
                保存结果尚未确认。核对操作只读取已生成副本，不会再次上传。
              </p>
            ) : null}
            {proposal?.state === "succeeded" ? (
              <p role="status">
                副本已保存并回读校验。
                {proposal.file
                  ? "可继续打开编辑。"
                  : "副本当前已变化或不可读取，请在文件列表核对。"}
              </p>
            ) : null}
            {proposal?.file ? (
              <button
                disabled={busy}
                onClick={() => {
                  const f = proposal.file!;
                  setBusy(true);
                  void mutation<OfficeLink>("/files/office-link", {
                    path: f.path,
                    expectedId: f.id,
                    expectedEtag: f.etag,
                  })
                    .then((value) => {
                      if (alive.current) setOutputLink(value);
                    })
                    .catch((e) => {
                      if (alive.current) {
                        setOutputLink(undefined);
                        setError(e.message);
                      }
                    })
                    .finally(() => {
                      if (alive.current) setBusy(false);
                    });
                }}
              >
                准备打开已保存副本
              </button>
            ) : null}
            {outputLink ? (
              <a
                href={outputLink.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                在新标签页编辑副本
              </a>
            ) : null}
          </>
        ) : null}
        {running ? (
          <div role="status">
            <p>助手正在处理，完成后可查看方案或副本回执。</p>
            <button
              disabled={busy}
              onClick={() =>
                void mutation<Run>(`/runs/${runId}/cancel`, {})
                  .then(onRun)
                  .catch((e) => setError(e.message))
              }
            >
              停止助手
            </button>
          </div>
        ) : null}
        {proposals.length ? (
          <section aria-label="Office 方案记录">
            <h3>此版本的方案</h3>
            {proposals.map((p) => (
              <button
                key={p.id}
                disabled={busy || running}
                onClick={() =>
                  void api<OfficeProposalResult>(`/office/proposals/${p.id}`)
                    .then((value) => {
                      if (alive.current) selectProposal(value);
                    })
                    .catch((e) => {
                      if (alive.current) setError(e.message);
                    })
                }
              >
                {new Date(p.createdAt).toLocaleString()} · 版本 {p.revision} ·{" "}
                {stateLabels[p.state]}
              </button>
            ))}
          </section>
        ) : null}
        {history.length ? (
          <section aria-label="Office 助手记录">
            <h3>助手记录</h3>
            {history.map((h) => (
              <button
                key={h.id}
                disabled={busy}
                onClick={() =>
                  void api<Run>(`/runs/${h.id}`)
                    .then((value) => {
                      if (alive.current) {
                        setRunId(h.id);
                        onRun(value);
                      }
                    })
                    .catch((e) => {
                      if (alive.current) setError(e.message);
                    })
                }
              >
                {h.engine.toUpperCase()} ·{" "}
                {h.workflow === "draft_office" ? "起草方案" : "生成副本"} ·{" "}
                {runStateLabels[h.state]}
              </button>
            ))}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
