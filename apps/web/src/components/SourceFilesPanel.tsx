import { useEffect, useRef, useState } from "react";
import { Folder, FileText, RefreshCw } from "lucide-react";
import { officeFormat, type RunState, type SourceFile } from "@hyper/contracts";
import { supportsOcr } from "@hyper/contracts/ocr";
import { OcrPanel } from "./OcrPanel";
import { OfficeFileDialog } from "./OfficeFileDialog";
import { OfficeToolsDialog } from "./OfficeToolsDialog";
import { FileReaderPanel } from "./FileReaderPanel";
import { api, mutation } from "../api";
interface Imported {
  id: string;
  title: string;
  state: "ready" | "needs_refresh" | "unavailable";
  sourceVersion?: string;
}
interface Preview {
  id: string;
  title: string;
  content: string;
  sourceVersion: string;
  parserVersion?: string;
  extraction?: { format?: string; warnings?: string[] };
}
export function SourceFilesPanel({
  enabled,
  officeEnabled,
  demo,
  busy,
  act,
  engines,
  run,
  onRun,
}: {
  engines: Record<string, import("@hyper/contracts").EngineCapabilities>;
  run: { id: string; state: RunState } | null;
  onRun: (run: { id: string; state: RunState }) => void;
  enabled: boolean;
  officeEnabled: boolean;
  demo: boolean;
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<boolean>;
}) {
  const [path, setPath] = useState<string[]>([]),
    [pathInput, setPathInput] = useState(""),
    [entries, setEntries] = useState<SourceFile[]>([]),
    [imports, setImports] = useState<Imported[]>([]),
    [preview, setPreview] = useState<Preview>(),
    [ocrFile, setOcrFile] = useState<SourceFile>(),
    [officeFile, setOfficeFile] = useState<SourceFile>(),
    [officeToolsFile, setOfficeToolsFile] = useState<SourceFile>(),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const browseVersion = useRef(0),
    previewVersion = useRef(0),
    libraryVersion = useRef(0),
    allowedVersions = useRef(new Map<string, string>()),
    alive = useRef(true),
    libraryRequest = useRef<Promise<void> | undefined>(undefined);
  async function loadFolder(next: string[]) {
    const version = ++browseVersion.current;
    setLoading(true);
    setError("");
    setEntries([]);
    try {
      const values = await mutation<SourceFile[]>("/files/list", {
        path: next,
      });
      if (!alive.current || version !== browseVersion.current) return;
      setEntries(values);
      setPath(next);
      setPathInput(next.join("/"));
    } catch (e) {
      if (alive.current && version === browseVersion.current)
        setError((e as Error).message);
    } finally {
      if (alive.current && version === browseVersion.current) setLoading(false);
    }
  }
  async function refreshImports() {
    const version = ++libraryVersion.current;
    try {
      const values = await api<Imported[]>("/files/imports");
      if (!alive.current || version !== libraryVersion.current) return;
      if (
        values.some(
          (row) =>
            row.state === "unavailable" && allowedVersions.current.has(row.id),
        )
      ) {
        browseVersion.current++;
        setEntries([]);
        setLoading(false);
      }
      allowedVersions.current = new Map(
        values
          .filter((row) => row.state === "ready" && row.sourceVersion)
          .map((row) => [row.id, row.sourceVersion!]),
      );
      setImports(values);
      setPreview((current) =>
        current &&
        values.some(
          (row) =>
            row.id === current.id &&
            row.state === "ready" &&
            row.sourceVersion === current.sourceVersion,
        )
          ? current
          : undefined,
      );
    } catch {
      if (alive.current && version === libraryVersion.current) {
        allowedVersions.current.clear();
        previewVersion.current++;
        setImports([]);
        setPreview(undefined);
      }
    }
  }
  async function loadImports(fresh = false): Promise<void> {
    if (libraryRequest.current) {
      await libraryRequest.current;
      if (fresh && alive.current) await loadImports();
      return;
    }
    const request = refreshImports();
    libraryRequest.current = request;
    try {
      await request;
    } finally {
      if (libraryRequest.current === request)
        libraryRequest.current = undefined;
    }
  }
  useEffect(() => {
    alive.current = true;
    if (enabled && !demo) {
      void loadFolder([]);
      void loadImports();
    }
    const timer = setInterval(() => {
      if (enabled && !demo && document.visibilityState === "visible")
        void loadImports();
    }, 8000);
    return () => {
      alive.current = false;
      browseVersion.current++;
      previewVersion.current++;
      libraryVersion.current++;
      allowedVersions.current.clear();
      clearInterval(timer);
    };
  }, [enabled, demo]);
  if (demo || !enabled)
    return (
      <div className="empty-state">
        {demo
          ? "使用企业账号登录后，可浏览并选择自己的文件。"
          : "企业文件尚未启用，请先完成来源配置。"}
      </div>
    );
  return (
    <section aria-label="企业文件导入" className="source-files-panel">
      <h3>选择文件，加入个人资料</h3>
      <p className="muted">
        从你有权限的文件中显式选择。支持短文本/Markdown（64 KiB），以及
        PDF、DOCX、XLSX、PPTX（8 MiB）。文本提取上限 180000 字符。图片和扫描 PDF
        可另选 OCR。副本仅你可见，不自动加入项目 AI 上下文。
      </p>
      <form
        className="source-folder-form"
        onSubmit={(e) => {
          e.preventDefault();
          const value = pathInput.replace(/^\/+|\/+$/g, "");
          void loadFolder(value ? value.split("/") : []);
        }}
      >
        <label>
          文件夹路径
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="例：项目资料/制度，留空为根目录"
          />
        </label>
        <button disabled={busy || loading}>打开文件夹</button>
        <button
          type="button"
          onClick={() => void loadFolder([])}
          disabled={busy || loading}
        >
          所有文件
        </button>
        {path.length ? (
          <button
            type="button"
            onClick={() => void loadFolder(path.slice(0, -1))}
            disabled={busy || loading}
          >
            上一级
          </button>
        ) : null}
      </form>
      {error ? (
        <p role="alert" className="error-text">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {loading ? (
        <p>正在读取文件夹…</p>
      ) : (
        <div className="source-file-list" role="list" aria-label="来源文件列表">
          {entries.map((file) => (
            <article role="listitem" key={file.id + JSON.stringify(file.path)}>
              {file.kind === "directory" ? (
                <Folder size={19} />
              ) : (
                <FileText size={19} />
              )}
              <div>
                <strong>{file.name}</strong>
                <small>
                  {file.kind === "directory"
                    ? "文件夹"
                    : `${file.mime || "未知类型"} · ${file.size} 字节`}
                </small>
              </div>
              {file.kind === "directory" ? (
                <button
                  onClick={() => void loadFolder(file.path)}
                  disabled={busy}
                >
                  打开
                </button>
              ) : (
                <button
                  disabled={busy || !file.importable}
                  onClick={() =>
                    void act(async () => {
                      setNotice("");
                      setPreview(undefined);
                      await mutation("/files/import", {
                        path: file.path,
                        expectedId: file.id,
                        expectedEtag: file.etag,
                      });
                      if (!alive.current) return;
                      setNotice(
                        "已加入个人资料。建立语义索引时才会调用所选向量模型。",
                      );
                      await loadImports(true);
                    })
                  }
                >
                  {file.importable ? "导入个人资料" : "暂不支持导入"}
                </button>
              )}
              {officeEnabled && officeFormat(file) ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setOfficeFile(file)}
                >
                  Office 协作
                </button>
              ) : null}
              {supportsOcr(file) ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setOcrFile(file)}
                >
                  图片与扫描件 OCR
                </button>
              ) : null}
              {officeEnabled && officeFormat(file) ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setOfficeToolsFile(file)}
                >
                  Office 助手
                </button>
              ) : null}
            </article>
          ))}
          {!entries.length ? (
            <p className="muted">此文件夹没有可列出的项目。</p>
          ) : null}
        </div>
      )}
      {ocrFile ? (
        <OcrPanel
          file={ocrFile}
          engines={engines}
          run={run}
          onRun={onRun}
          onClose={() => setOcrFile(undefined)}
        />
      ) : null}
      {officeFile ? (
        <OfficeFileDialog
          file={officeFile}
          onClose={() => setOfficeFile(undefined)}
        />
      ) : null}
      {officeToolsFile ? (
        <OfficeToolsDialog
          file={officeToolsFile}
          engines={engines}
          run={run}
          onRun={onRun}
          onClose={() => setOfficeToolsFile(undefined)}
        />
      ) : null}
      <header className="source-import-heading">
        <h3>已选择的个人文件</h3>
        <button
          aria-label="刷新文件权限"
          disabled={busy}
          onClick={() => void loadImports(true)}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      <p className="muted small">
        读取和检索时重新核验来源。文件变化后需要显式刷新，旧索引不会继续使用。每人最多保留
        50 个导入记录。
      </p>
      <div className="source-file-list">
        {imports.map((row) => (
          <article key={row.id}>
            <FileText size={19} />
            <div>
              <strong>{row.title}</strong>
              <small>
                {row.state === "ready"
                  ? "可读取 · 个人资料"
                  : row.state === "needs_refresh"
                    ? "来源已变化，需刷新"
                    : "来源不可用或已撤权"}
              </small>
            </div>
            <button
              disabled={busy || row.state !== "ready"}
              onClick={() =>
                void act(async () => {
                  const version = ++previewVersion.current;
                  setPreview(undefined);
                  const value = await api<Preview>("/files/imports/" + row.id);
                  if (
                    alive.current &&
                    version === previewVersion.current &&
                    allowedVersions.current.get(value.id) ===
                      value.sourceVersion
                  )
                    setPreview(value);
                })
              }
            >
              查看文本
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  previewVersion.current++;
                  setPreview(undefined);
                  await mutation("/files/imports/" + row.id + "/refresh", {});
                  if (alive.current) {
                    setNotice("已核验并刷新当前文件；如内容变化，请重建索引。");
                    await loadImports(true);
                  }
                })
              }
            >
              刷新来源
            </button>
          </article>
        ))}
      </div>
      {preview ? (
        <section className="source-file-preview" aria-label="文件文本预览">
          <h4>{preview.title}</h4>
          {preview.extraction?.format &&
          preview.extraction.format !== "text" ? (
            <div className="source-extraction-notice" role="status">
              <p className="muted small">
                当前显示提取文本，保留原始页码/块/单元格位置；不是原文件版式或在线编辑器。
              </p>
              {preview.extraction.warnings?.map((warning, index) => (
                <p className="muted small" key={index}>
                  {warning}
                </p>
              ))}
            </div>
          ) : null}
          <FileReaderPanel
            key={preview.id + preview.sourceVersion}
            file={preview}
            engines={engines}
            busy={busy}
            act={act}
          />
          <p>{preview.content}</p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const result = await mutation<{ indexed: string[] }>(
                  "/knowledge/index",
                  { assetIds: [preview.id] },
                );
                if (alive.current)
                  setNotice(
                    result.indexed.length
                      ? "已建立个人文件语义索引。"
                      : "文件已变化或无法核验，请重新读取。",
                  );
              })
            }
          >
            建立语义索引
          </button>
          <button
            onClick={() => {
              previewVersion.current++;
              setPreview(undefined);
            }}
          >
            关闭预览
          </button>
        </section>
      ) : null}
    </section>
  );
}
