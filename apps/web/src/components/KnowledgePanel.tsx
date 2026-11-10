import {
  KnowledgeQuestion,
  type KnowledgeSelection,
} from "./KnowledgeQuestion";
import { useEffect, useRef, useState } from "react";
import { FileText, Search } from "lucide-react";
import { api, mutation, ApiError } from "../api";
import { SourceFilesPanel } from "./SourceFilesPanel";
import { MethodsPanel } from "./MethodsPanel";
import type { WorkspaceView } from "@hyper/contracts";
import { usePageTransition } from "../hooks/usePageTransition";
interface KnowledgeResult {
  id: string;
  title: string;
  content: string;
  sourceRef?: string;
  sourceVersion: string;
  type?: string;
  chunks?: {
    ordinal: number;
    start: number;
    end: number;
    content: string;
    reference: string;
  }[];
}
const sourceBound = (row: { type?: string }) =>
  row.type === "source_file" || row.type === "ocr";

export function KnowledgePanel({
  busy,
  act,
  demo,
  filesEnabled,
  engines,
  view,
  run,
  onRun,
}: {
  busy: boolean;
  act: (fn: () => Promise<void>) => Promise<boolean>;
  demo: boolean;
  filesEnabled: boolean;
  engines: Record<string, import("@hyper/contracts").EngineCapabilities>;
  view: WorkspaceView;
  run: any;
  onRun: (run: any) => void;
}) {
  const [query, setQuery] = useState(""),
    [mode, setMode] = useState("keyword");
  const [tab, setTab] = useState<"search" | "files" | "methods">("search");
  const [results, setResults] = useState<KnowledgeResult[]>([]),
    [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<KnowledgeSelection[]>([]),
    [questionLocked, setQuestionLocked] = useState(false);
  const generation = useRef(0);
  const latestResults = useRef(results);
  latestResults.current = results;
  useEffect(() => {
    generation.current++;
    setResults([]);
    setSelected([]);
    setNotice("");
    return () => {
      generation.current++;
    };
  }, [view.user.id, view.project.id]);
  const surface = usePageTransition<HTMLDivElement>(tab);
  const hasFileResults = results.some(sourceBound);
  useEffect(() => {
    if (!hasFileResults) return;
    let alive = true,
      inFlight = false;
    const refresh = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      const ids = latestResults.current
        .filter(sourceBound)
        .map((row) => row.id);
      if (!ids.length) return;
      const started = generation.current;
      inFlight = true;
      try {
        const { versions } = await mutation<{
          versions: Record<string, string>;
        }>("/knowledge/source-access", { ids });
        if (alive && started === generation.current) {
          const invalid = new Set(
            latestResults.current
              .filter(
                (row) =>
                  sourceBound(row) && versions[row.id] !== row.sourceVersion,
              )
              .map((row) => row.id),
          );
          if (invalid.size) {
            generation.current++;
            setResults((rows) => rows.filter((row) => !invalid.has(row.id)));
            setSelected((rows) => rows.filter((row) => !invalid.has(row.id)));
          }
        }
      } catch {
        if (alive && started === generation.current) {
          generation.current++;
          setResults((rows) => rows.filter((row) => !sourceBound(row)));
          setSelected((rows) => rows.filter((row) => !sourceBound(row)));
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void refresh(), 8000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [hasFileResults]);
  return (
    <div className="work-panel" ref={surface}>
      <div className="tabs" role="tablist" aria-label="资料操作">
        <button
          role="tab"
          className={tab === "search" ? "active" : ""}
          aria-selected={tab === "search"}
          onClick={() => setTab("search")}
        >
          知识检索
        </button>
        <button
          role="tab"
          className={tab === "files" ? "active" : ""}
          aria-selected={tab === "files"}
          onClick={() => {
            generation.current++;
            setResults([]);
            setSelected([]);
            setTab("files");
          }}
        >
          企业文件
        </button>
        <button
          role="tab"
          className={tab === "methods" ? "active" : ""}
          aria-selected={tab === "methods"}
          onClick={() => {
            generation.current++;
            setResults([]);
            setSelected([]);
            setTab("methods");
          }}
        >
          方法与模板
        </button>
      </div>
      {tab === "methods" ? (
        <MethodsPanel
          key={view.user.id + ":" + view.project.id}
          view={view}
          run={run}
          onRun={onRun}
        />
      ) : tab === "files" ? (
        <SourceFilesPanel
          enabled={filesEnabled}
          demo={demo}
          busy={busy}
          act={act}
          engines={engines}
        />
      ) : (
        <>
          <h3>从企业资料中找到依据</h3>
          <p className="muted">
            文字检索直接查询可见资料；按含义查找需要在设置中配置向量模型，并为资料建立索引。
          </p>
          <form
            className="knowledge-search"
            onSubmit={(e) => {
              e.preventDefault();
              const g = ++generation.current;
              setResults([]);
              setSelected([]);
              void act(async () => {
                setNotice("");
                try {
                  const rows =
                    mode === "keyword"
                      ? await api<KnowledgeResult[]>(
                          "/knowledge?q=" + encodeURIComponent(query),
                        )
                      : await mutation<KnowledgeResult[]>(
                          "/knowledge/semantic",
                          { query },
                        );
                  if (g === generation.current) setResults(rows);
                } catch (e) {
                  if (g === generation.current) {
                    setResults([]);
                    setSelected([]);
                  }
                  throw e;
                }
              });
            }}
          >
            <input
              required
              disabled={questionLocked}
              maxLength={500}
              aria-label="检索资料"
              placeholder="输入问题或关键词"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="检索方式"
              disabled={questionLocked}
              value={mode}
              onChange={(e) => {
                generation.current++;
                setMode(e.target.value);
                setResults([]);
                setSelected([]);
              }}
            >
              <option value="keyword">文字匹配</option>
              <option value="semantic">按含义查找</option>
            </select>
            <button className="primary" disabled={busy || questionLocked}>
              <Search size={17} />
              检索
            </button>
          </form>
          {notice ? <p role="status">{notice}</p> : null}
          <KnowledgeQuestion
            key={view.user.id + ":" + view.project.id}
            view={view}
            run={run}
            onRun={onRun}
            selected={selected}
            defaultQuery={query}
            mode={mode}
            onLock={setQuestionLocked}
            onDenied={() => {
              generation.current++;
              setResults([]);
              setSelected([]);
              setQuery("");
            }}
          />
          {results.map((a) => (
            <article className="knowledge-result" key={a.id}>
              <h4>
                <FileText size={20} />
                {a.title}
              </h4>
              {a.chunks?.length ? (
                <div>
                  {a.chunks.map((chunk) => (
                    <details key={chunk.ordinal}>
                      <summary>
                        匹配片段 · 字符 {chunk.start}–{chunk.end}
                      </summary>
                      <p>{chunk.content}</p>
                      <small>{chunk.reference}</small>
                    </details>
                  ))}
                </div>
              ) : (
                <p>
                  {a.content.slice(0, 1500)}
                  {a.content.length > 1500
                    ? "…（仅显示开头，可检索片段后提问）"
                    : ""}
                </p>
              )}
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={selected.some((row) => row.id === a.id)}
                  disabled={
                    questionLocked ||
                    (!selected.some((row) => row.id === a.id) &&
                      selected.length >= 10)
                  }
                  onChange={(e) =>
                    setSelected((rows) =>
                      e.target.checked
                        ? [
                            ...rows,
                            {
                              id: a.id,
                              title: a.title,
                              sourceVersion: a.sourceVersion,
                              type: a.type,
                            },
                          ]
                        : rows.filter((row) => row.id !== a.id),
                    )
                  }
                />
                加入本次资料问答
              </label>
              <small>
                来源：{a.sourceRef ?? "产品资产"} · 版本 {a.sourceVersion}
              </small>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    try {
                      const result = await mutation<{ indexed: string[] }>(
                        "/knowledge/index",
                        { assetIds: [a.id] },
                      );
                      setNotice(
                        result.indexed.length
                          ? "资料已分段建立语义索引。"
                          : "资料已变化，请刷新后重建索引。",
                      );
                    } catch (e) {
                      if (
                        e instanceof ApiError &&
                        [401, 403, 404].includes(e.status)
                      ) {
                        generation.current++;
                        setResults((rows) =>
                          rows.filter((row) => row.id !== a.id),
                        );
                        setSelected((rows) =>
                          rows.filter((row) => row.id !== a.id),
                        );
                      }
                      throw e;
                    }
                  })
                }
              >
                建立语义索引
              </button>
            </article>
          ))}
          {!results.length ? (
            <div className="empty-state">
              检索结果会显示在这里。语义索引和检索会调用已配置的向量模型。
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
