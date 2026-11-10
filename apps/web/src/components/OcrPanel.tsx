import { useEffect, useRef, useState } from "react";
import type { SourceFile } from "@hyper/contracts";
import type { OcrResult } from "@hyper/contracts/ocr";
import { api, ApiError, mutation } from "../api";
import { Dialog } from "./Dialog";

const kinds = { title: "标题", text: "正文", table: "表格", other: "其他" };

export function OcrPanel({
  file,
  onClose,
}: {
  file: SourceFile;
  onClose: () => void;
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
  const pending = useRef<{ key: string; fingerprint: string }>(null);
  const resultId = result?.id;
  const resultRevision = result?.revision;

  function show(next: OcrResult | null) {
    setResult(next);
    setPrevious(null);
    setTexts(next?.content.blocks.map((block) => block.text) ?? []);
    setSelectedBlock(0);
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    show(null);
    const selection = {
      path: file.path,
      expectedId: file.id,
      expectedEtag: file.etag,
      page,
    };
    void api<{ result: OcrResult | null }>("/ocr/lookup", {
      method: "POST",
      body: JSON.stringify(selection),
      signal: controller.signal,
    })
      .then(({ result: next }) => {
        if (!controller.signal.aborted) show(next);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [file, page, reload]);

  useEffect(() => {
    if (!resultId || !resultRevision) return;
    const controller = new AbortController();
    let checking = false;
    const timer = setInterval(() => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      void api("/ocr/documents/" + resultId + "?revision=" + resultRevision, {
        signal: controller.signal,
      })
        .catch((e) => {
          if (!controller.signal.aborted) {
            show(null);
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
  }, [resultId, resultRevision]);

  async function save(path: string, body: object) {
    const fingerprint = JSON.stringify([path, body]);
    if (pending.current?.fingerprint !== fingerprint)
      pending.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const next = await mutation<OcrResult>(path, {
        ...body,
        idempotencyKey: pending.current.key,
      });
      pending.current = null;
      show(next);
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
      <p className="muted">
        {file.name} · 第 {page} 页 · 私人资料
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
                disabled={busy}
                onChange={(event) => setPageNumber(event.target.value)}
              />
            </label>
            <button type="submit" disabled={busy || loading}>
              查看这一页
            </button>
          </form>
        ) : null}
        <button
          type="button"
          className="primary"
          disabled={busy || loading}
          onClick={() =>
            void save("/ocr/recognitions", {
              source: {
                path: file.path,
                expectedId: file.id,
                expectedEtag: file.etag,
                page,
              },
              expectedRevision: result?.revision ?? 0,
            })
          }
        >
          {result ? "重新识别这一页" : "识别这一页"}
        </button>
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => setReload((count) => count + 1)}
        >
          刷新已保存结果
        </button>
      </div>
      {loading || busy ? (
        <p role="status">
          {busy ? "正在核对操作回执…" : "正在核对文件与已保存版本…"}
        </p>
      ) : null}
      {shown ? (
        <>
          <p role="status">
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
                void save("/ocr/documents/" + result.id + "/confirm", {
                  expectedRevision: result.revision,
                  texts,
                })
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
