import { useEffect, useRef, useState } from "react";
import type { RunState, SourceFile, WorkspaceView } from "@hyper/contracts";
import type { ModelSummary } from "./ModelSettings";
import type { OcrResult } from "@hyper/contracts/ocr";
import { api, ApiError, mutation } from "../api";
import { Dialog } from "./Dialog";
import { runStateLabels } from "./RunDetails";

const kinds = { title: "标题", text: "正文", table: "表格", other: "其他" };

type OcrRun = { id: string; state: RunState };
type OcrHistory = OcrRun & { engine: "dsh" | "hermes"; createdAt: string };

export function OcrPanel({
  file,
  onClose,
  engines,
  run,
  onRun,
}: {
  file: SourceFile;
  onClose: () => void;
  engines: WorkspaceView["engines"];
  run: OcrRun | null;
  onRun: (run: OcrRun) => void;
}) {
  const [page, setPage] = useState(1);
  const [pageNumber, setPageNumber] = useState("1");
  const [result, setResult] = useState<OcrResult | null>(null);
  const [previous, setPrevious] = useState<OcrResult | null>(null);
  const [texts, setTexts] = useState<string[]>([]);
  const [selectedBlock, setSelectedBlock] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [executor, setExecutor] = useState<"manual" | "dsh" | "hermes">(
    "manual",
  );
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelId, setModelId] = useState("");
  const [runId, setRunId] = useState("");
  const [history, setHistory] = useState<OcrHistory[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const previewRequest = useRef<AbortController>(null);
  const runState = run?.id === runId ? run.state : undefined;
  const running = runState === "queued" || runState === "running";
  const engine = executor === "manual" ? undefined : engines[executor];
  const compatible = models.filter(
    (model) =>
      model.purpose === "chat" &&
      (!engine?.modelProviders ||
        engine.modelProviders.includes(model.provider)),
  );
  const aiReady =
    !!engine?.configured && compatible.some((model) => model.id === modelId);
  const pending = useRef<{ key: string; fingerprint: string }>(null);
  const resultId = result?.id;
  const resultRevision = result?.revision;

  function show(next: OcrResult | null) {
    setResult(next);
    if (!next) {
      if (previewRequest.current) {
        previewRequest.current.abort();
        previewRequest.current = null;
        setBusy(false);
      }
      setPreview(null);
    }
    setPrevious(null);
    setTexts(next?.content.blocks.map((block) => block.text) ?? []);
    setSelectedBlock(0);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    show(null);
    setHistory([]);
    const selection = {
      path: file.path,
      expectedId: file.id,
      expectedEtag: file.etag,
      page,
    };
    void api<{ result: OcrResult | null; history: OcrHistory[] }>(
      "/ocr/lookup",
      {
        method: "POST",
        body: JSON.stringify(selection),
        signal: controller.signal,
      },
    )
      .then(({ result: next, history: runs }) => {
        if (!controller.signal.aborted) {
          show(next);
          setHistory(runs);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      previewRequest.current?.abort();
    };
  }, [file, page, reload]);

  useEffect(() => {
    if ((!resultId || !resultRevision) && !preview) return;
    const controller = new AbortController();
    let checking = false;
    const timer = setInterval(() => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      const current =
        resultId && resultRevision
          ? api("/ocr/documents/" + resultId + "?revision=" + resultRevision, {
              signal: controller.signal,
            })
          : api("/ocr/lookup", {
              method: "POST",
              body: JSON.stringify({
                path: file.path,
                expectedId: file.id,
                expectedEtag: file.etag,
                page,
              }),
              signal: controller.signal,
            });
      void current
        .catch((e) => {
          if (!controller.signal.aborted) {
            show(null);
            setHistory([]);
            setError(e.message);
          }
        })
        .finally(() => {
          checking = false;
        });
    }, 8000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [resultId, resultRevision, preview, file, page]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  useEffect(() => {
    if (executor === "manual") return;
    const controller = new AbortController();
    void api<ModelSummary[]>("/models", { signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) setModels(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [executor]);

  useEffect(() => {
    if (runState && runState !== "queued" && runState !== "running")
      setReload((value) => value + 1);
  }, [runState, runId]);

  async function save<T>(
    path: string,
    body: object,
    success: (value: T) => void,
  ) {
    const fingerprint = JSON.stringify([path, body]);
    if (pending.current?.fingerprint !== fingerprint)
      pending.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const next = await mutation<T>(path, {
        ...body,
        idempotencyKey: pending.current.key,
      });
      pending.current = null;
      success(next);
    } catch (e) {
      if (
        e instanceof ApiError &&
        [401, 403, 404, 409, 410, 412].includes(e.status)
      )
        show(null);
      setError(e instanceof Error ? e.message : "暂时无法核对识别结果。");
    } finally {
      setBusy(false);
    }
  }

  async function previewOriginal() {
    const controller = new AbortController();
    previewRequest.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/ocr/source-preview", {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: file.path,
          expectedId: file.id,
          expectedEtag: file.etag,
          page,
        }),
      });
      if (!response.ok) {
        if ([401, 403, 404, 409, 410, 412].includes(response.status))
          show(null);
        setError("原件暂不可查看，请刷新并核对来源权限。");
        return;
      }
      if (response.headers.get("content-type")?.split(";")[0] !== file.mime)
        throw new Error("原件类型与来源声明不一致。");
      const original = await response.blob();
      if (!controller.signal.aborted) setPreview(URL.createObjectURL(original));
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "暂时无法读取原件。");
    } finally {
      if (previewRequest.current === controller) {
        previewRequest.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  async function stopRun() {
    setBusy(true);
    setError("");
    try {
      onRun(await mutation<OcrRun>("/runs/" + runId + "/cancel", {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : "请先核对执行详情。");
    } finally {
      setBusy(false);
    }
  }

  function recognize() {
    const selected = {
      source: {
        path: file.path,
        expectedId: file.id,
        expectedEtag: file.etag,
        page,
      },
      expectedRevision: result?.revision ?? 0,
    };
    if (executor === "manual") {
      void save<OcrResult>("/ocr/recognitions", selected, show);
      return;
    }
    void save<OcrRun>(
      "/ocr/runs",
      {
        plan: { ...selected, confirmed: true },
        engine: executor,
        modelProfileId: modelId,
      },
      (queued) => {
        setRunId(queued.id);
        onRun(queued);
      },
    );
  }

  const shown = previous ?? result;
  const activeBlock = shown?.content.blocks[selectedBlock];
  const activeText = activeBlock
    ? previous
      ? activeBlock.text
      : (texts[selectedBlock] ?? "")
    : "";
  const tableRows =
    activeBlock?.kind === "table" && activeText.includes("\t")
      ? activeText
          .split("\n")
          .slice(0, 60)
          .map((line) => line.split("\t").slice(0, 30))
      : [];
  return (
    <Dialog
      title="图片与扫描件 OCR"
      error={error}
      wide
      onClose={onClose}
      dismissible={!busy}
    >
      <p className="muted ocr-source">
        {file.name} · 第 {page} 页 · 私人资料
      </p>
      <p className="muted">
        确认版本可在个人知识库检索，语义索引由你另行选择建立。
      </p>
      <div className="ocr-actions">
        {file.mime === "application/pdf" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setPage(Number(pageNumber));
            }}
          >
            <label>
              PDF 页码
              <input
                type="number"
                min={1}
                max={50}
                required
                value={pageNumber}
                disabled={busy || running}
                onChange={(event) => setPageNumber(event.target.value)}
              />
            </label>
            <button type="submit" disabled={busy || loading || running}>
              查看这一页
            </button>
          </form>
        ) : null}
        <label>
          OCR 操作方式
          <select
            aria-label="OCR 操作方式"
            disabled={busy || running}
            value={executor}
            onChange={(event) => {
              setExecutor(event.target.value as typeof executor);
              setModelId("");
            }}
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
          <label>
            OCR 模型连接
            <select
              aria-label="OCR 模型连接"
              value={modelId}
              disabled={busy || running}
              onChange={(event) => setModelId(event.target.value)}
            >
              <option value="">选择 chat 连接</option>
              {compatible.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} · {model.model}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          className="primary"
          disabled={
            busy || loading || running || (executor !== "manual" && !aiReady)
          }
          onClick={recognize}
        >
          {executor === "manual"
            ? result
              ? "重新识别这一页"
              : "识别这一页"
            : "确认并交给助手识别"}
        </button>
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => setReload((count) => count + 1)}
        >
          刷新已保存结果
        </button>
      </div>
      <div className="ocr-original">
        <button
          type="button"
          disabled={busy || loading || running}
          onClick={() => (preview ? setPreview(null) : void previewOriginal())}
        >
          {preview ? "收起原件" : "读取原件核对"}
        </button>
        {preview && file.mime === "application/pdf" ? (
          <a
            href={preview + "#page=" + page}
            target="_blank"
            rel="noopener noreferrer"
          >
            在新标签页打开原件第 {page} 页
          </a>
        ) : null}
        {preview && file.mime !== "application/pdf" ? (
          <img src={preview} alt="来源原图" />
        ) : null}
      </div>
      {history.length ? (
        <details className="approval-audit">
          <summary>本页 OCR 执行记录（{history.length}）</summary>
          <ul>
            {history.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={busy || running}
                  onClick={() => {
                    void api<OcrRun>("/runs/" + item.id)
                      .then((saved) => {
                        onRun(saved);
                        onClose();
                      })
                      .catch((e) => setError(e.message));
                  }}
                >
                  {item.engine === "dsh" ? "DSH" : "Hermes"} ·{" "}
                  {runStateLabels[item.state]} ·{" "}
                  {new Date(item.createdAt).toLocaleString("zh-CN")}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {running ? (
        <button type="button" disabled={busy} onClick={() => void stopRun()}>
          停止这次执行
        </button>
      ) : null}
      {runState ? (
        <p role="status">
          {running
            ? "OCR 助手正在处理所选页。"
            : runState === "succeeded"
              ? "助手已取得识别草稿回执。"
              : "助手执行已结束，请核对已保存版本和执行详情。"}
        </p>
      ) : null}
      {loading || busy ? (
        <p role="status">
          {busy ? "正在核对操作回执…" : "正在核对文件与已保存版本…"}
        </p>
      ) : null}
      {shown ? (
        <>
          <p role="status" className="ocr-source">
            版本 {shown.revision} ·{" "}
            {shown.state === "confirmed" ? "已确认" : "待校对"} · {shown.engine}
          </p>
          {result?.confirmedRevision &&
          result.confirmedRevision !== result.revision ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (previous) {
                  setPrevious(null);
                  setSelectedBlock(0);
                  return;
                }
                void api<OcrResult>(
                  "/ocr/documents/" +
                    result.id +
                    "?revision=" +
                    result.confirmedRevision,
                )
                  .then((version) => {
                    setPrevious(version);
                    setSelectedBlock(0);
                  })
                  .catch((e) => setError(e.message));
              }}
            >
              {previous ? "返回当前草稿" : "查看上次确认版本"}
            </button>
          ) : null}
          <div className="ocr-layout">
            <div
              aria-label="识别位置"
              className="ocr-map"
              style={{
                aspectRatio: shown.content.width + " / " + shown.content.height,
              }}
            >
              {shown.content.blocks.map(
                ({ bounds: [left, top, right, bottom] }, index) => (
                  <button
                    key={index}
                    type="button"
                    aria-label={"定位版面块 " + (index + 1)}
                    aria-pressed={index === selectedBlock}
                    onClick={() => setSelectedBlock(index)}
                    style={{
                      left: (100 * left) / shown.content.width + "%",
                      top: (100 * top) / shown.content.height + "%",
                      width: (100 * (right - left)) / shown.content.width + "%",
                      height:
                        (100 * (bottom - top)) / shown.content.height + "%",
                    }}
                  >
                    {index + 1}
                  </button>
                ),
              )}
            </div>
            <div className="ocr-block">
              <label>
                版面块
                <select
                  aria-label="版面块"
                  value={selectedBlock}
                  onChange={(event) =>
                    setSelectedBlock(Number(event.target.value))
                  }
                >
                  {shown.content.blocks.map((block, index) => (
                    <option key={index} value={index}>
                      {index + 1} · {kinds[block.kind]}
                    </option>
                  ))}
                </select>
              </label>
              {activeBlock ? (
                <>
                  <p className="muted">
                    {activeBlock.confidence === null
                      ? "服务未提供置信度，请核对原件"
                      : "置信度 " +
                        Math.round(activeBlock.confidence * 100) +
                        "%" +
                        (activeBlock.confidence < 0.75
                          ? " · 建议优先核对"
                          : "")}
                  </p>
                  {tableRows.length ? (
                    <div className="ocr-table">
                      <table aria-label="识别表格预览">
                        <tbody>
                          {tableRows.map((row, index) => (
                            <tr key={index}>
                              {row.map((cell, column) => (
                                <td key={column}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  <label>
                    校对内容
                    <textarea
                      aria-label="校对内容"
                      rows={8}
                      maxLength={12000}
                      readOnly={!!previous || busy}
                      value={
                        previous
                          ? activeBlock.text
                          : (texts[selectedBlock] ?? "")
                      }
                      onChange={(event) =>
                        setTexts((current) =>
                          current.map((text, index) =>
                            index === selectedBlock ? event.target.value : text,
                          ),
                        )
                      }
                    />
                  </label>
                </>
              ) : null}
            </div>
          </div>
          {!previous && result ? (
            <button
              type="button"
              disabled={busy || loading}
              onClick={() =>
                void save<OcrResult>(
                  "/ocr/documents/" + result.id + "/confirm",
                  {
                    expectedRevision: result.revision,
                    texts,
                  },
                  show,
                )
              }
            >
              确认校对并保存版本
            </button>
          ) : null}
        </>
      ) : null}
    </Dialog>
  );
}
