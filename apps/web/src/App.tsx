import { CalendarPanel } from "./components/CalendarPanel";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { OrganizationBudgetPanel } from "./components/OrganizationBudgetPanel";
import { OrganizationPanel } from "./components/OrganizationPanel";
import { DecisionPanel } from "./components/DecisionPanel";
import { WorkPlanPanel } from "./components/WorkPlanPanel";
import { ProjectMembers } from "./components/MemberPanels";
import { WorkBriefPanel } from "./components/WorkBriefPanel";
import type { BriefReference } from "@hyper/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Artifact,
  Task,
  Project,
  WorkspaceView,
  CommunicationRoom,
  ReplyDraft,
  ExecutionRules,
} from "@hyper/contracts";
import { Plus, ArrowRight, LoaderCircle, X } from "lucide-react";
import { api, mutation, ApiError } from "./api";
import { Navigation, MainHeader, type Section } from "./components/Shell";
import { Discussion } from "./components/Discussion";
import {
  ContextPanel,
  TasksPanel,
  ArtifactsPanel,
} from "./components/WorkPanels";
import { Dialog } from "./components/Dialog";
import { RunDetails, runErrorText } from "./components/RunDetails";
import { RunHistoryPanel } from "./components/RunHistoryPanel";
import { ModelSettings, type ModelSummary } from "./components/ModelSettings";
import { EnterpriseMessages } from "./components/EnterpriseMessages";
import { Login } from "./components/Login";
import { KnowledgePanel } from "./components/KnowledgePanel";
import { FollowUpPanel } from "./components/FollowUpPanel";
import { ArtifactReviewPanel } from "./components/ArtifactReviewPanel";
import { artifactStatusLabel } from "@hyper/contracts";
import { TaskEditor } from "./components/TaskEditor";
import { NotificationPolicyPanel } from "./components/NotificationPolicyPanel";
import { ExecutionPolicyPanel } from "./components/ExecutionPolicyPanel";
import { ModelUsagePanel } from "./components/ModelUsagePanel";
import { ModelSpendingPanel } from "./components/ModelSpendingPanel";
import { usePageTransition } from "./hooks/usePageTransition";
type Tab =
  | "discussion"
  | "tasks"
  | "artifacts"
  | "briefs"
  | "decisions"
  | "workplans"
  | "runs";
export function App() {
  const [view, setView] = useState<WorkspaceView | null>(null),
    [login, setLogin] = useState(false),
    [status, setStatus] = useState<{
      demoEnabled: boolean;
      nextcloudConfigured: boolean;
      filesEnabled?: boolean;
    }>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState("");
  const [detailsRunId, setDetailsRunId] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("messages"),
    [tab, setTab] = useState<Tab>("discussion"),
    [query, setQuery] = useState(""),
    [navOpen, setNavOpen] = useState(false),
    [contextOpen, setContextOpen] = useState(false);
  const [dialog, setDialog] = useState<
      "run" | "task" | "task_edit" | "artifact" | "project" | null
    >(null),
    [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null),
    [selectedTask, setSelectedTask] = useState<Task | null>(null),
    [title, setTitle] = useState(""),
    [assignee, setAssignee] = useState(""),
    [due, setDue] = useState(""),
    [goal, setGoal] = useState("");
  const [sourceRoom, setSourceRoom] = useState<{
    id: string;
    name: string;
    reply?: boolean;
  } | null>(null);
  const [initialRoomId, setInitialRoomId] = useState<string>();
  const [initialReplyDraft, setInitialReplyDraft] = useState<ReplyDraft>();
  const loadVersion = useRef(0);
  const loadedProject = useRef<string | undefined>(undefined);
  const artifactScope = useRef(0);
  const [instruction, setInstruction] = useState(
      "请把当前讨论整理成纪要，保留明确分工与时间。",
    ),
    [workflow, setWorkflow] = useState("discussion_to_minutes"),
    [engine, setEngine] = useState("dsh"),
    [run, setRun] = useState<any>(null);
  const [runModels, setRunModels] = useState<ModelSummary[]>([]),
    [modelProfileId, setModelProfileId] = useState("");
  const [settingsTab, setSettingsTab] = useState("models");
  const [briefRef, setBriefRef] = useState<BriefReference>();
  const [taskRules, setTaskRules] = useState<ExecutionRules>({});
  const [edit, setEdit] = useState(""),
    [feedback, setFeedback] = useState("");
  const pageSurface = usePageTransition<HTMLElement>(
    view
      ? `${view.user.id}:${view.project.id}:${section}:${tab}:${section === "settings" ? settingsTab : ""}`
      : undefined,
  );
  const load = useCallback(async (projectId?: string) => {
    const version = ++loadVersion.current;
    const clearPrivateDrafts = () => {
      artifactScope.current++;
      setDialog(null);
      setDetailsRunId(null);
      setSelectedArtifact(null);
      setSelectedTask(null);
      setEdit("");
      setFeedback("");
      setTitle("");
      setGoal("");
      setAssignee("");
      setDue("");
      setQuery("");
      setSourceRoom(null);
      setInitialReplyDraft(undefined);
      setRun(null);
      setInstruction("请把当前讨论整理成纪要，保留明确分工与时间。");
      setWorkflow("discussion_to_minutes");
      setRunModels([]);
      setModelProfileId("");
      setTaskRules({});
      setBriefRef(undefined);
    };
    try {
      const value = await api<WorkspaceView>(
        "/workspace" + (projectId ? "?projectId=" + projectId : ""),
      );
      if (version !== loadVersion.current) return value;
      if (loadedProject.current && loadedProject.current !== value.project.id)
        clearPrivateDrafts();
      loadedProject.current = value.project.id;
      setView(value);
      setLogin(false);
      setError("");
      return value;
    } catch (error) {
      if (version !== loadVersion.current) return;
      if (
        projectId &&
        !(error instanceof ApiError && [401, 403].includes(error.status))
      ) {
        clearPrivateDrafts();
        loadedProject.current = undefined;
        setView(null);
        setLogin(false);
        try {
          const fallback = await api<WorkspaceView>("/workspace");
          if (version !== loadVersion.current) return;
          loadedProject.current = fallback.project.id;
          setView(fallback);
          setLogin(false);
          setSection("messages");
          setError("当前项目不可访问或来源暂不可用，已切换到可访问的项目。");
          return;
        } catch {
          if (version !== loadVersion.current) return;
          setView(null);
          setLogin(true);
          setError((error as Error).message);
          return;
        }
      }
      if (version !== loadVersion.current) return;
      if (
        error instanceof ApiError &&
        [401, 403, 404, 503].includes(error.status)
      ) {
        clearPrivateDrafts();
        loadedProject.current = undefined;
        setView(null);
        setLogin(true);
        setError(error.status === 401 ? "" : error.message);
      } else setError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    if (!view?.project.source) return;
    let polling = false;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || polling) return;
      polling = true;
      void load(view.project.id).finally(() => {
        polling = false;
      });
    }, 10000);
    return () => clearInterval(timer);
  }, [view?.project.id, view?.project.source?.roomId, load]);
  useEffect(() => {
    void load();
    void api<typeof status>("/auth/status")
      .then(setStatus)
      .catch(() => {});
  }, [load]);
  useEffect(() => {
    if (dialog !== "run") return;
    setTaskRules({});
    let alive = true;
    void api<ModelSummary[]>("/models")
      .then((models) => {
        if (alive) {
          const chat = models.filter((model) => model.purpose === "chat");
          setRunModels(chat);
          setModelProfileId((current) =>
            chat.some((model) => model.id === current) ? current : "",
          );
        }
      })
      .catch((error) => {
        if (alive) setError(error.message);
      });
    return () => {
      alive = false;
    };
  }, [dialog, view?.user.id]);
  useEffect(() => {
    setRunError("");
    if (
      !run ||
      ["succeeded", "failed", "cancelled", "recovery_required"].includes(
        run.state,
      )
    )
      return;
    let alive = true,
      polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void api("/runs/" + run.id)
        .then((r) => {
          if (alive) {
            setRunError("");
            setRun(r);
            if (
              [
                "succeeded",
                "failed",
                "cancelled",
                "recovery_required",
              ].includes(r.state)
            )
              void load(view?.project.id);
          }
        })
        .catch((e) => {
          if (alive) setRunError(e.message);
        })
        .finally(() => {
          polling = false;
        });
    }, 700);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [run?.id, run?.state, load, view?.project.id]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    await load(view?.project.id);
  }
  function openTask(t = "") {
    setError("");
    setTitle(t);
    setAssignee("");
    setDue("");
    setDialog("task");
  }
  function openArtifact(a: Artifact) {
    artifactScope.current++;
    setError("");
    setSelectedArtifact(a);
    setEdit(a.content);
    setFeedback("");
    setDialog("artifact");
  }
  function selectProject(p: Project) {
    setSection("messages");
    setTab("discussion");
    setQuery("");
    setNavOpen(false);
    void load(p.id);
  }
  function openReplyRun() {
    setWorkflow("draft_reply");
    setInstruction("请根据当前会话起草一条简洁、准确的回复，供我检查后发送。");
    setEngine("dsh");
    setDialog("run");
  }
  async function openSourceProject(room: CommunicationRoom, reply = false) {
    const { project } = await api<{ project: Project | null }>(
      "/talk/rooms/" + room.id + "/project",
    );
    if (project) {
      setSection("messages");
      setTab("discussion");
      setNavOpen(false);
      await load(project.id);
      if (reply && loadedProject.current === project.id) openReplyRun();
    } else {
      setSourceRoom({ id: room.id, name: room.name, reply });
      setTitle(room.name);
      setGoal("");
      setError("");
      setDialog("project");
    }
  }
  function navigate(s: Section) {
    setSection(s);
    setQuery("");
    setNavOpen(false);
  }
  if (!view)
    return (
      <Login
        ready={login}
        status={status}
        error={error}
        onAuthenticated={async () => {
          await load();
        }}
      />
    );
  const projectTitle =
    section === "approvals"
      ? "审批工作台"
      : section === "calendar"
        ? "日历排期"
        : section === "organization"
          ? "通讯录"
          : section === "knowledge"
            ? "知识库"
            : section === "settings"
              ? "设置"
              : section === "enterprise"
                ? "企业消息"
                : view.project.name;
  const selectedRunModel = runModels.find(
    (model) => model.id === modelProfileId,
  );
  const replyReceipt = run?.result?.receipts?.find(
    (receipt: any) => receipt.tool === "communication.draft",
  );
  const incompatibleRunModel =
    engine !== "fixture" &&
    selectedRunModel &&
    view.engines[engine]?.modelProviders &&
    !view.engines[engine]!.modelProviders!.includes(selectedRunModel.provider);
  return (
    <div
      className={
        "app-shell" +
        (["enterprise", "organization", "calendar", "approvals"].includes(
          section,
        )
          ? " enterprise-view"
          : "")
      }
    >
      <Navigation
        view={view}
        section={section}
        onSection={navigate}
        onProject={selectProject}
        onRun={() => {
          setError("");
          if (section === "enterprise") setSection("messages");
          setDialog("run");
          setBriefRef(undefined);
          setEngine("dsh");
        }}
        onNewProject={() => {
          setError("");
          setTitle("");
          setGoal("");
          setSourceRoom(null);
          setDialog("project");
        }}
        open={navOpen}
        onLogout={() =>
          void act(async () => {
            await mutation("/auth/logout", {});
            window.location.reload();
          })
        }
      />
      <main className="main-pane" ref={pageSurface}>
        <MainHeader
          title={projectTitle}
          enterprise={section === "enterprise"}
          hideProjectTools={
            section === "organization" ||
            section === "calendar" ||
            section === "approvals"
          }
          subtitle={
            section === "approvals"
              ? "按已发布流程发起与处理申请"
              : section === "calendar"
                ? "来源日历与可核对的排期操作"
                : section === "organization"
                  ? "企业成员、组织部门与当前角色"
                  : section === "knowledge"
                    ? "有来源、可复用的工作资料"
                    : section === "settings"
                      ? "模型与执行服务"
                      : section === "enterprise"
                        ? "查看和回复你有权限访问的会话"
                        : "项目空间"
          }
          query={query}
          onQuery={setQuery}
          onMenu={() => setNavOpen((v) => !v)}
          onContext={() => setContextOpen((v) => !v)}
        />
        {(error || runError) && !dialog ? (
          <div role="alert" className="error-banner">
            <span>{error || runError}</span>
            <button
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={() => {
                setError("");
                setRunError("");
              }}
            >
              <X size={17} />
            </button>
          </div>
        ) : null}
        {view.project.source &&
        section !== "enterprise" &&
        section !== "settings" &&
        section !== "knowledge" &&
        section !== "approvals" &&
        section !== "calendar" ? (
          <div className="project-source-banner">
            <span>
              已关联「{view.project.source.name}
              」，项目访问范围随来源会话成员变化。
              <br />
              <small>
                本页工作记录留在项目，回复会话请使用“查看企业会话”。
              </small>
            </span>
            <button
              onClick={() => {
                setInitialRoomId(view.project.source!.roomId);
                setSection("enterprise");
              }}
            >
              查看企业会话
            </button>
          </div>
        ) : null}
        {run ? (
          <div className={"run-strip " + run.state}>
            <span>
              {run.engine === "fixture" ? "演示执行" : "AI 执行"} ·{" "}
              {(
                {
                  queued: "等待处理",
                  running: "正在推进",
                  waiting_input: "需要澄清",
                  waiting_confirmation: "等待确认",
                  succeeded: "已完成",
                  failed: "执行未完成",
                  cancelled: "已停止",
                  recovery_required: "需要核对已执行操作",
                } as any
              )[run.state] ?? run.state}
              {run.error ? "：" + runErrorText(run.error) : ""}
              {run.workflow === "follow_up" && run.result?.receipts?.[0] ? (
                <small className="follow-up-status" role="status">
                  {run.result.receipts[0].notify
                    ? "待办变化已合并为一条项目消息。"
                    : run.result.receipts[0].summary}
                </small>
              ) : null}
            </span>
            <button onClick={() => setDetailsRunId(run.id)}>
              查看执行详情
            </button>
            {replyReceipt ? (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const projectId = view.project.id;
                    const value = await api<ReplyDraft>(
                      "/talk/drafts/" + replyReceipt.id,
                    );
                    if (loadedProject.current !== projectId) return;
                    setInitialRoomId(value.roomId);
                    setInitialReplyDraft(value);
                    setSection("enterprise");
                  })
                }
              >
                查看回复草稿
              </button>
            ) : null}
            {![
              "succeeded",
              "failed",
              "cancelled",
              "recovery_required",
            ].includes(run.state) ? (
              <button
                onClick={() =>
                  void act(async () => {
                    const id = run.id;
                    const receipt = await mutation(
                      "/runs/" + id + "/cancel",
                      {},
                    );
                    setRun((current: any) =>
                      current?.id === id
                        ? { ...current, state: receipt.state }
                        : current,
                    );
                  })
                }
              >
                停止
              </button>
            ) : (
              <button onClick={() => setRun(null)}>收起</button>
            )}
          </div>
        ) : null}
        {run && detailsRunId === run.id ? (
          <RunDetails
            key={view.user.id + ":" + view.project.id + ":" + run.id}
            runId={run.id}
            onClose={() => setDetailsRunId(null)}
          />
        ) : null}
        {section === "messages" || section === "projects" ? (
          <>
            <div className="tabs" role="tablist">
              {(
                [
                  ["discussion", view.project.source ? "工作记录" : "讨论"],
                  ["briefs", "任务说明"],
                  ["workplans", "工作计划"],
                  ["decisions", "决定"],
                  ["tasks", "任务"],
                  ["artifacts", "成果"],
                  ["runs", "执行记录"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  className={tab === id ? "active" : ""}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === "discussion" ? (
              <Discussion
                key={view.project.conversationId}
                messages={view.messages}
                artifacts={view.artifacts}
                onArtifact={openArtifact}
                onTask={openTask}
                query={query}
                busy={busy}
                demo={view.user.demo}
                onSend={(text) =>
                  act(async () => {
                    await mutation(
                      "/conversations/" +
                        view.project.conversationId +
                        "/messages",
                      { content: text },
                    );
                    await refresh();
                  })
                }
              />
            ) : tab === "runs" ? (
              <RunHistoryPanel
                key={view.user.id + ":" + view.project.id}
                projectId={view.project.id}
                onOpen={(value) => {
                  if (loadedProject.current !== view.project.id) return;
                  setRun(value);
                  setDetailsRunId(value.id);
                }}
              />
            ) : tab === "workplans" ? (
              <WorkPlanPanel
                key={view.user.id + ":" + view.project.id}
                view={view}
                run={run}
                onRun={(value) => {
                  if (loadedProject.current === view.project.id) setRun(value);
                }}
                onStart={() => {
                  setWorkflow("plan_work");
                  setInstruction(
                    "请理解当前工作要求，整理可检查的步骤，必要时澄清负责人、目标和版本。",
                  );
                  setBriefRef(undefined);
                  setDialog("run");
                  setEngine("dsh");
                  setError("");
                }}
                onChanged={() => {
                  void refresh().catch((e) => setError(e.message));
                }}
              />
            ) : tab === "decisions" ? (
              <DecisionPanel
                key={view.user.id + ":" + view.project.id}
                view={view}
                run={run}
                onRun={(value) => {
                  if (loadedProject.current === view.project.id) setRun(value);
                }}
                onChanged={() => {
                  void refresh().catch((e) => setError(e.message));
                }}
              />
            ) : tab === "briefs" ? (
              <WorkBriefPanel
                key={view.user.id + ":" + view.project.id}
                view={view}
                run={run}
                onRun={(value) => {
                  if (loadedProject.current === view.project.id) setRun(value);
                }}
                onUse={(ref) => {
                  setBriefRef(ref);
                  setWorkflow("discussion_to_minutes");
                  setInstruction(
                    "按已确认任务说明和当前获准讨论制作成果，遵守范围与完成标准，未知事实明确标记。",
                  );
                  setEngine("dsh");
                  setError("");
                  setDialog("run");
                }}
              />
            ) : tab === "tasks" ? (
              <div className="task-workspace">
                <ProjectMembers
                  key={view.user.id + ":" + view.project.id}
                  view={view}
                  run={run}
                  onRun={(value) => {
                    if (loadedProject.current === view.project.id)
                      setRun(value);
                  }}
                />
                <TasksPanel
                  tasks={view.tasks}
                  query={query}
                  onNew={() => openTask()}
                  onEdit={(task) => {
                    setSelectedTask(task);
                    setDialog("task_edit");
                  }}
                  onToggle={(t) =>
                    void act(async () => {
                      await mutation(
                        "/tasks/" + t.id,
                        {
                          status: t.status === "done" ? "open" : "done",
                          expectedVersion: t.version,
                        },
                        "PATCH",
                      );
                      await refresh();
                    })
                  }
                />
                <FollowUpPanel
                  key={view.project.conversationId}
                  view={view}
                  run={run}
                  onRun={(value) => {
                    if (loadedProject.current === view.project.id)
                      setRun(value);
                  }}
                />
              </div>
            ) : (
              <ArtifactsPanel
                artifacts={view.artifacts}
                query={query}
                onArtifact={openArtifact}
              />
            )}
          </>
        ) : null}
        {section === "enterprise" ? (
          <EnterpriseMessages
            view={view}
            filesEnabled={!!status?.filesEnabled}
            demo={view.user.demo}
            query={query}
            initialRoomId={initialRoomId}
            initialReplyDraft={initialReplyDraft}
            onProject={(room) => openSourceProject(room)}
            onDraft={(room) => openSourceProject(room, true)}
            onLogout={() =>
              void act(async () => {
                await mutation("/auth/logout", {});
                window.location.reload();
              })
            }
          />
        ) : null}
        {section === "knowledge" ? (
          <KnowledgePanel
            view={view}
            run={run}
            onRun={(value) => {
              if (loadedProject.current === view.project.id) setRun(value);
            }}
            busy={busy}
            act={act}
            demo={view.user.demo}
            filesEnabled={!!status?.filesEnabled}
            engines={view.engines}
          />
        ) : null}
        {section === "calendar" ? (
          <CalendarPanel
            key={view.user.id + view.user.workspaceId}
            engines={view.engines}
            view={view}
            run={run}
            onRun={(value) => {
              setRun(value);
              setDetailsRunId(value.id);
            }}
          />
        ) : null}
        {section === "approvals" ? (
          <ApprovalPanel
            key={view.user.id + view.user.workspaceId}
            user={view.user}
            engines={view.engines}
            run={run}
            onRun={(value) => {
              setRun(value);
              setDetailsRunId(value.id);
            }}
          />
        ) : null}
        {section === "organization" ? (
          <OrganizationPanel
            key={view.user.id + view.user.workspaceId}
            view={view}
            run={run}
            onRun={(r) => {
              if (loadedProject.current === view.project.id) setRun(r);
            }}
          />
        ) : null}
        {section === "settings" ? (
          <>
            <div
              className="tabs settings-tabs"
              role="tablist"
              aria-label="设置分类"
            >
              <button
                role="tab"
                aria-selected={settingsTab === "models"}
                className={settingsTab === "models" ? "active" : ""}
                onClick={() => setSettingsTab("models")}
              >
                模型连接
              </button>
              <button
                role="tab"
                aria-selected={settingsTab === "policy"}
                className={settingsTab === "policy" ? "active" : ""}
                onClick={() => setSettingsTab("policy")}
              >
                执行规则
              </button>
              <button
                role="tab"
                aria-selected={settingsTab === "notifications"}
                className={settingsTab === "notifications" ? "active" : ""}
                onClick={() => setSettingsTab("notifications")}
              >
                跟进提醒
              </button>
              <button
                role="tab"
                aria-selected={settingsTab === "usage"}
                className={settingsTab === "usage" ? "active" : ""}
                onClick={() => setSettingsTab("usage")}
              >
                模型用量
              </button>
              <button
                role="tab"
                aria-selected={settingsTab === "spending"}
                className={settingsTab === "spending" ? "active" : ""}
                onClick={() => setSettingsTab("spending")}
              >
                价格与预算
              </button>
              <button
                role="tab"
                aria-selected={settingsTab === "budgets"}
                className={settingsTab === "budgets" ? "active" : ""}
                onClick={() => setSettingsTab("budgets")}
              >
                企业预算
              </button>
            </div>
            {settingsTab === "models" ? (
              <ModelSettings view={view} busy={busy} act={act} />
            ) : settingsTab === "notifications" ? (
              <NotificationPolicyPanel
                key={view.user.id + view.project.id}
                view={view}
                run={run}
                onRun={(r) => {
                  if (loadedProject.current === view.project.id) setRun(r);
                }}
              />
            ) : settingsTab === "budgets" ? (
              <OrganizationBudgetPanel
                key={view.user.id + view.project.id}
                view={view}
                run={run}
                onRun={(r) => {
                  if (loadedProject.current === view.project.id) setRun(r);
                }}
              />
            ) : settingsTab === "spending" ? (
              <ModelSpendingPanel
                key={view.user.id + view.project.id}
                view={view}
                run={run}
                onRun={(r) => {
                  if (loadedProject.current === view.project.id) setRun(r);
                }}
              />
            ) : settingsTab === "usage" ? (
              <ModelUsagePanel
                key={view.user.id + view.project.id}
                view={view}
                run={run}
                onRun={(r) => {
                  if (loadedProject.current === view.project.id) setRun(r);
                }}
              />
            ) : (
              <ExecutionPolicyPanel
                key={view.user.id + view.project.id}
                view={view}
                run={run}
                onRun={(r) => {
                  if (loadedProject.current === view.project.id) setRun(r);
                }}
              />
            )}
          </>
        ) : null}
      </main>
      {section !== "enterprise" &&
      section !== "organization" &&
      section !== "approvals" &&
      section !== "calendar" ? (
        <ContextPanel
          view={view}
          open={contextOpen}
          onDecisions={() => {
            setSection("messages");
            setTab("decisions");
          }}
          onTask={openTask}
          onArtifact={openArtifact}
          onToggle={(t) =>
            void act(async () => {
              await mutation(
                "/tasks/" + t.id,
                {
                  status: t.status === "done" ? "open" : "done",
                  expectedVersion: t.version,
                },
                "PATCH",
              );
              await refresh();
            })
          }
        />
      ) : null}
      {dialog === "task" ? (
        <Dialog title="新建待办" error={error} onClose={() => setDialog(null)}>
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await mutation(
                  "/conversations/" + view.project.conversationId + "/tasks",
                  {
                    title,
                    assignee: assignee || "待分配",
                    dueDate: due || null,
                  },
                );
                setDialog(null);
                await refresh();
              });
            }}
          >
            <label>
              待办事项
              <input
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              负责人
              <input
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="待分配"
              />
            </label>
            <label>
              截止日期
              <input
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy}>
              创建待办
            </button>
          </form>
        </Dialog>
      ) : null}
      {dialog === "project" ? (
        <Dialog
          title={sourceRoom ? "创建关联项目" : "新建项目空间"}
          error={error}
          onClose={() => setDialog(null)}
        >
          {sourceRoom ? (
            <p className="source-scope-note">
              关联「{sourceRoom.name}
              」。只有当前来源会话成员能访问这个新项目，原始消息仍保留在企业会话。
            </p>
          ) : null}
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const p = await mutation(
                  sourceRoom ? "/projects/from-talk" : "/projects",
                  {
                    name: title,
                    goal,
                    ...(sourceRoom ? { roomId: sourceRoom.id } : {}),
                  },
                );
                const reply = sourceRoom?.reply;
                setSourceRoom(null);
                setSection("messages");
                setTab("discussion");
                setDialog(null);
                await load(p.id);
                if (reply && loadedProject.current === p.id) openReplyRun();
              });
            }}
          >
            <label>
              项目名称
              <input
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              当前目标
              <textarea
                required
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy}>
              创建项目
            </button>
          </form>
        </Dialog>
      ) : null}
      {dialog === "run" ? (
        <Dialog
          title="让 AI 帮你推进工作"
          error={error}
          onClose={() => setDialog(null)}
        >
          {view.project.source && workflow !== "follow_up" ? (
            <p className="source-scope-note">
              此任务会读取「{view.project.source.name}」当前获准的最近至多 60
              条普通消息，并交给所选模型连接处理。
              {workflow === "draft_reply"
                ? "回复草稿仅你可见，检查后可放入企业会话发送框。"
                : "成果保存在当前项目。"}
              不会自动发布到企业会话。
            </p>
          ) : null}
          {workflow === "follow_up" ? (
            <p className="source-scope-note">
              只将「{view.project.name}
              」当前待办交给所选模型，不包含讨论正文；仍核验项目及来源访问权限。
              首次建立基线，无变化时不发消息；有变化时合并为一条项目消息。
              本次为单次检查；定时跟进请在任务页管理。
            </p>
          ) : null}
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const projectId = view.project.id;
                const started = await mutation("/runs", {
                  conversationId: view.project.conversationId,
                  workflow,
                  engine,
                  instruction,
                  taskRules,
                  ...(briefRef ? { briefRef } : {}),
                  ...(engine !== "fixture" && modelProfileId
                    ? { modelProfileId }
                    : {}),
                  idempotencyKey: crypto.randomUUID(),
                  ...(workflow === "revise_artifact" && selectedArtifact
                    ? { artifactId: selectedArtifact.id }
                    : {}),
                });
                if (loadedProject.current !== projectId) return;
                setRun({ ...started, engine });
                setDialog(null);
              });
            }}
          >
            <label>
              工作类型
              <select
                value={workflow}
                onChange={(e) => {
                  setWorkflow(e.target.value);
                  if (
                    ![
                      "discussion_to_minutes",
                      "project_report",
                      "revise_artifact",
                    ].includes(e.target.value)
                  )
                    setBriefRef(undefined);
                }}
              >
                <option value="discussion_to_minutes">讨论 → 纪要</option>
                <option value="plan_work">理解工作 → 澄清 → 确认执行</option>
                <option value="project_report">项目周报</option>
                <option value="follow_up">检查待办进展</option>
                {view.project.source ? (
                  <option value="draft_reply">起草会话回复</option>
                ) : null}
                {selectedArtifact ? (
                  <option value="revise_artifact">按反馈修改成果</option>
                ) : null}
              </select>
            </label>
            {briefRef ? (
              <div className="source-scope-note">
                本次绑定任务说明版本 v{briefRef.version}
                ；执行前及每次业务动作检查当前确认状态。
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setBriefRef(undefined)}
                >
                  移除说明引用
                </button>
              </div>
            ) : null}
            <label>
              工作要求
              <textarea
                required
                autoFocus
                rows={4}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </label>
            <label>
              执行服务
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value)}
              >
                <option value="dsh">
                  DSH{view.engines.dsh?.configured ? "" : " · 未配置"}
                </option>
                <option value="hermes">
                  Hermes{view.engines.hermes?.configured ? "" : " · 未配置"}
                </option>
                {view.user.demo ? (
                  <option value="fixture">演示流程 · 不调用真实模型</option>
                ) : null}
              </select>
            </label>
            {engine !== "fixture" ? (
              <label>
                模型连接
                <select
                  value={modelProfileId}
                  onChange={(e) => setModelProfileId(e.target.value)}
                >
                  <option value="">自动选择（优先个人连接）</option>
                  {runModels.map((model) => (
                    <option
                      key={model.id}
                      value={model.id}
                      disabled={
                        !!view.engines[engine]?.modelProviders &&
                        !view.engines[engine]!.modelProviders!.includes(
                          model.provider,
                        )
                      }
                    >
                      {model.name} ·{" "}
                      {model.scope === "personal" ? "个人" : "工作区"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <p className="muted small">
              {engine === "fixture"
                ? "验证保存成果与业务回执，不代表模型执行效果。"
                : "使用服务端配置的执行器；未连接时会明确报告。"}
            </p>
            <details>
              <summary>本次执行限制</summary>
              <p className="muted small">
                空白继承工作区、项目和个人规则；本次设置只能进一步收紧限制。
              </p>
              {(
                [
                  ["maxOutputTokens", "本次输出上限（token）", 64, 4096],
                  ["maxDurationSeconds", "本次时限（秒）", 5, 180],
                  ["maxActions", "本次动作上限", 0, 30],
                  ["maxContextBytes", "本次上下文上限（字节）", 1024, 100000],
                ] as const
              ).map(([key, label, min, max]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    value={taskRules[key] ?? ""}
                    onChange={(e) =>
                      setTaskRules({
                        ...taskRules,
                        [key]:
                          e.target.value === ""
                            ? undefined
                            : Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </details>
            {incompatibleRunModel ? (
              <p role="status" className="muted small">
                请选择与执行服务兼容的模型连接。
              </p>
            ) : null}
            <button
              className="primary"
              disabled={busy || !!incompatibleRunModel}
            >
              {busy ? "正在提交…" : "开始执行"}
            </button>
          </form>
        </Dialog>
      ) : null}
      {dialog === "task_edit" && selectedTask ? (
        <Dialog title="修改待办" wide onClose={() => setDialog(null)}>
          <TaskEditor
            key={selectedTask.id}
            task={selectedTask}
            view={view}
            run={run}
            onRun={(value) => {
              if (loadedProject.current === view.project.id) setRun(value);
            }}
            onUpdated={(task) => {
              if (loadedProject.current !== view.project.id) return;
              setSelectedTask((current) =>
                current?.id === task.id &&
                (current.version ?? 0) <= (task.version ?? 0)
                  ? task
                  : current,
              );
              setView((current) =>
                current?.project.id === view.project.id
                  ? {
                      ...current,
                      tasks: current.tasks.map((row) =>
                        row.id === task.id &&
                        (row.version ?? 0) <= (task.version ?? 0)
                          ? task
                          : row,
                      ),
                    }
                  : current,
              );
            }}
          />
        </Dialog>
      ) : null}
      {dialog === "artifact" && selectedArtifact ? (
        <Dialog
          title={selectedArtifact.title}
          error={error}
          wide
          onClose={() => {
            artifactScope.current++;
            setDialog(null);
          }}
        >
          <form
            className="dialog-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const scope = artifactScope.current,
                  projectId = view.project.id;
                await mutation(
                  "/artifacts/" + selectedArtifact.id + "/revisions",
                  {
                    content: edit,
                    feedback,
                    expectedVersion: selectedArtifact.version,
                  },
                );
                if (
                  scope !== artifactScope.current ||
                  loadedProject.current !== projectId
                )
                  return;
                const refreshed = await load(projectId);
                const saved = refreshed?.artifacts.find(
                  (a) => a.id === selectedArtifact.id,
                );
                if (
                  scope === artifactScope.current &&
                  loadedProject.current === projectId &&
                  saved
                ) {
                  // A newer background refresh may have superseded this read.
                  // Publish at least the saved version before allowing reopening,
                  // while preserving any newer artifact or unrelated project data.
                  setView((current) =>
                    current?.project.id === projectId
                      ? {
                          ...current,
                          artifacts: current.artifacts.map((item) =>
                            item.id === saved.id && item.version < saved.version
                              ? saved
                              : item,
                          ),
                        }
                      : current,
                  );
                  setDialog(null);
                }
              });
            }}
          >
            <div className="artifact-version-label">
              {artifactStatusLabel(selectedArtifact.status)} · v
              {selectedArtifact.version}（已保存） ·{" "}
              {edit !== selectedArtifact.content
                ? "当前编辑尚未保存"
                : "修改将保留历史版本"}
            </div>
            <label>
              成果内容
              <textarea
                className="artifact-editor"
                aria-label="成果内容"
                disabled={busy}
                value={edit}
                onChange={(e) => setEdit(e.target.value)}
              />
            </label>
            <label>
              修改说明
              <input
                disabled={busy}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="记录这次修改的原因"
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  artifactScope.current++;
                  setError("");
                  setWorkflow("revise_artifact");
                  setInstruction(
                    feedback || "请改进这份成果，保留原有事实与引用。",
                  );
                  setDialog("run");
                }}
              >
                让 AI 按反馈修改
              </button>
              <button className="primary" disabled={busy}>
                保存新版本
              </button>
            </div>
          </form>
          <ArtifactReviewPanel
            key={selectedArtifact.id + ":" + selectedArtifact.version}
            artifact={selectedArtifact}
            dirty={edit !== selectedArtifact.content}
            view={view}
            run={run}
            onRun={(value) => {
              if (loadedProject.current === view.project.id) setRun(value);
            }}
            onMetadata={(value) => {
              setSelectedArtifact((current) =>
                current?.id === value.id && current.version === value.version
                  ? {
                      ...current,
                      status: value.status,
                      reviewRevision: value.reviewRevision,
                      acceptedVersion: value.acceptedVersion,
                    }
                  : current,
              );
              setView((current) =>
                current
                  ? {
                      ...current,
                      artifacts: current.artifacts.map((item) =>
                        item.id === value.id && item.version === value.version
                          ? {
                              ...item,
                              status: value.status,
                              reviewRevision: value.reviewRevision,
                              acceptedVersion: value.acceptedVersion,
                            }
                          : item,
                      ),
                    }
                  : current,
              );
            }}
            onReload={(value) => {
              if (loadedProject.current !== view.project.id) return;
              setSelectedArtifact(value);
              setEdit(value.content);
              setFeedback("");
            }}
          />
        </Dialog>
      ) : null}
    </div>
  );
}
