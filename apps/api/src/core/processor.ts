import { ApprovalRunService } from "./approval-runs.js";
import { isOrganizationBudgetPlan } from "@hyper/contracts";
import { OrganizationBudgetService } from "./organization-budgets.js";
import { CalendarRunService } from "./calendar-runs.js";
import {
  NotificationPolicyService,
  effectiveNotifications,
} from "./notification-policy.js";
import { RoomManagementService } from "./room-management.js";
import { OrganizationService } from "./organization.js";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { KnowledgeContextService } from "./knowledge-context.js";
import { WorkPlanService } from "./work-plans.js";
import { DecisionService } from "./decisions.js";
import { DecisionDraft } from "@hyper/contracts";
import { TaskAssignmentService } from "./task-assignments.js";
import { DirectoryService } from "./directory.js";
import { AttachmentSendService } from "./attachment-sends.js";
import { WorkBriefService } from "./work-briefs.js";
import { WorkBriefContent } from "@hyper/contracts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { PgBoss } from "pg-boss";
import { workerRunConcurrency } from "./worker-options.js";
import {
  TaskInput,
  TaskRewrite,
  toolsForWorkflow,
  isFileWorkflow,
  type EngineId,
  type Subject,
  type PlannedAction,
} from "@hyper/contracts";
import { Database } from "../db/database.js";
import { WorkspaceService, appendEvent } from "./workspace.js";
import { assertMember } from "./security.js";
import { stableDigest } from "./credentials.js";
import {
  createProjectArtifact,
  reviseArtifactVersion,
  lockArtifact,
} from "./artifacts.js";
import { ArtifactReviewService } from "./artifact-reviews.js";
import { createProjectTask, patchProjectTask, lockTask } from "./tasks.js";
import { MethodsService } from "./methods.js";
import { ModelService } from "./models.js";
import { RunModelGateway } from "./model-gateway.js";
import { ModelUsageService } from "./model-usage.js";
import { ModelSpendingService, SpendLimitError } from "./model-spending.js";
import {
  ExecutionPolicyService,
  ExecutionLimitError,
} from "./execution-policy.js";
import { assertRunScope, loadRunContext } from "./run-context.js";
import { FollowUpService } from "./follow-up.js";
import {
  FollowUpScheduleService,
  assertScheduledRun,
  type PreparedFollowUp,
} from "./follow-up-schedules.js";
import {
  FileReadingService,
  ReadingVersionConflict,
  ReadingInputLimit,
} from "./file-readings.js";
async function purgeFileRuntime(db: Database, id: string) {
  await rm(resolve(process.env.RUNTIME_DIR ?? ".runtime/runs", id), {
    recursive: true,
    force: true,
  });
  await db.pool.query(
    "UPDATE cw_runs SET runtime_cleaned_at=clock_timestamp() WHERE id=$1 AND (source_file_asset_id IS NOT NULL OR workflow IN ('query_knowledge','plan_work','manage_communication','manage_notifications','manage_calendar','manage_approval'))",
    [id],
  );
}
export class RunProcessor {
  readonly boss: PgBoss;
  private sweep?: NodeJS.Timeout;
  private consumeSchedules = false;
  private scheduling = false;
  constructor(readonly service: WorkspaceService) {
    this.boss = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema: "hyper_jobs",
      createSchema: process.env.QUEUE_SCHEMA_PRECREATED !== "true",
    });
    this.boss.on("error", () =>
      console.error("Background queue error; inspect service health."),
    );
  }
  async start(consume = false) {
    await this.boss.start();
    await this.boss.createQueue("hyper-run", { retryLimit: 0 });
    if (consume) {
      this.consumeSchedules = true;
      await this.boss.work<{ runId: string }>(
        "hyper-run",
        {
          pollingIntervalSeconds: 1,
          localConcurrency: workerRunConcurrency(),
        },
        async (jobs) => {
          for (const job of jobs) await this.process(job.data.runId);
        },
      );
      await this.reconcile();
      this.sweep = setInterval(
        () => void this.reconcile().catch(() => {}),
        15000,
      );
    }
  }
  async enqueue(runId: string) {
    await this.boss.send("hyper-run", { runId }, { singletonKey: runId });
  }
  async stop() {
    this.consumeSchedules = false;
    if (this.sweep) clearInterval(this.sweep);
    await this.boss.stop({ graceful: true, timeout: 3000 });
  }
  async reconcile() {
    const db = this.service.db;
    await db.tx(async (c) => {
      const expired = await c.query(
        "UPDATE cw_runs SET state='recovery_required',error='执行租约已过期，需要核对已完成操作。',updated_at=now() WHERE state='running' AND lease_expires_at<now() RETURNING id",
      );
      for (const run of expired.rows)
        await appendEvent(c, run.id, "run.recovery_required", {
          message: "执行中断，未自动重试业务动作。",
        });
    });
    for (const r of (
      await db.pool.query(
        "SELECT id FROM cw_runs WHERE state='queued' AND created_at<now()-interval '2 seconds' LIMIT 100",
      )
    ).rows)
      await this.enqueue(r.id);
    for (const r of (
      await db.pool.query(
        "SELECT id FROM cw_runs WHERE (source_file_asset_id IS NOT NULL OR workflow IN ('query_knowledge','plan_work','manage_communication','manage_notifications','manage_calendar','manage_approval')) AND runtime_cleaned_at IS NULL AND state NOT IN ('queued','running') ORDER BY updated_at LIMIT 100",
      )
    ).rows)
      await purgeFileRuntime(db, r.id);
    // Source validation must not delay queue recovery or worker health startup.
    void this.dispatchSchedules().catch(() =>
      console.error(
        "Scheduled follow-up dispatch failed; inspect database and worker health.",
      ),
    );
  }
  private async dispatchSchedules() {
    if (!this.consumeSchedules || this.scheduling) return;
    this.scheduling = true;
    try {
      for (const id of await new FollowUpScheduleService(
        this.service,
      ).dispatchDue()) {
        if (!this.consumeSchedules) return;
        await this.enqueue(id);
      }
    } finally {
      this.scheduling = false;
    }
  }
  async process(runId: string) {
    const db = this.service.db,
      lease = randomUUID();
    const run = (
      await db.pool.query(
        "UPDATE cw_runs SET state='running',lease_owner=$2,lease_expires_at=now()+interval '45 seconds',runtime_cleaned_at=CASE WHEN workflow='plan_work' THEN NULL ELSE runtime_cleaned_at END,updated_at=now() WHERE id=$1 AND state='queued' RETURNING *",
        [runId, lease],
      )
    ).rows[0];
    if (!run) return;
    const abort = new AbortController();
    const timer = setTimeout(
      () =>
        abort.abort(
          new Error(
            "本次执行超过时间限制。请核对已完成操作和当前业务状态，再决定是否续做。",
          ),
        ),
      180000,
    );
    const heartbeat = setInterval(() => {
      void db.pool
        .query(
          "UPDATE cw_runs SET lease_expires_at=now()+interval '45 seconds' WHERE id=$1 AND lease_owner=$2 AND state='running' RETURNING id",
          [runId, lease],
        )
        .then((r) => {
          if (!r.rowCount)
            abort.abort(
              new Error(
                "执行已停止或运行租约失效。请先核对已完成操作，不要直接重复提交。",
              ),
            );
        })
        .catch(() =>
          abort.abort(
            new Error("暂时无法续期运行租约。请先核对当前执行和已完成操作。"),
          ),
        );
    }, 1000);
    let scopeTimer: ReturnType<typeof setInterval> | undefined;
    let scopeChecking = false;
    let lastSourceCheck = Date.now();
    const executionPolicy = new ExecutionPolicyService(db);
    let contextBytes: number | undefined;
    let modelGateway: RunModelGateway | undefined;
    const event = (kind: any, data: Record<string, unknown>) =>
      db.tx((c) => appendEvent(c, runId, kind, data));
    try {
      const actor = (
        await db.pool.query(
          "SELECT u.id,u.name,m.role FROM cw_users u JOIN cw_members m ON m.user_id=u.id WHERE u.id=$1 AND m.workspace_id=$2",
          [run.actor_id, run.workspace_id],
        )
      ).rows[0];
      if (!actor) throw new Error("工作区权限已撤销。");
      const subject: Subject = {
        ...actor,
        workspaceId: run.workspace_id,
        demo: run.demo,
        identityCredentialId: run.identity_credential_id ?? undefined,
      };
      await assertMember(db, subject);
      if (run.workflow === "plan_work")
        await db.pool.query(
          "UPDATE cw_run_wait_periods SET ended_at=clock_timestamp() WHERE run_id=$1 AND ended_at IS NULL",
          [run.id],
        );
      run.execution_policy_snapshot = await executionPolicy.admit(subject, run);
      await event("run.started", {
        engine: run.engine,
        evidence: run.engine === "fixture" ? "fixture" : "runtime-unverified",
        policyVersion: run.policy_version,
        modelProfileId: run.model_profile_id,
        executionPolicy: run.execution_policy_snapshot,
      });
      await event("usage.updated", {
        kind: "execution-admission",
        count: 1,
        dayBoundary: "UTC",
        note: "计数是获准执行次数，不是供应商请求数、token 或费用。",
      });
      const scope = await loadRunContext(this.service, subject, run);
      const { context, sourceIds, contextRefs } = scope;
      if (run.execution_policy_snapshot)
        scopeTimer = setInterval(() => {
          if (scopeChecking) return;
          scopeChecking = true;
          const checkSource =
            scope.live && Date.now() - lastSourceCheck >= 15000;
          if (checkSource) lastSourceCheck = Date.now();
          void Promise.all([
            executionPolicy.check(db.pool, subject, run, contextBytes),
            ...(checkSource
              ? [assertRunScope(this.service, subject, run)]
              : []),
          ])
            .catch((error) =>
              abort.abort(
                error instanceof ExecutionLimitError
                  ? error
                  : new Error(
                      error instanceof ServiceUnavailableException
                        ? "企业来源暂时不可用，无法继续确认权限与资料版本。请核对已完成操作后重试。"
                        : "来源权限、版本或有效执行规则已变化。",
                    ),
              ),
            )
            .finally(() => {
              scopeChecking = false;
            });
        }, 1000);
      const snapshot = await db.pool.query(
        "UPDATE cw_runs SET context_refs=$2 WHERE id=$1 AND lease_owner=$3 AND state='running' RETURNING id",
        [runId, JSON.stringify(contextRefs), lease],
      );
      if (!snapshot.rowCount) throw new Error("Task stopped.");
      const policy = JSON.parse(
        await readFile(
          new URL(
            "../../../../docs/handoff-v1/AI-IM基线/product-baseline.v1.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const workdir = resolve(
        process.env.RUNTIME_DIR ?? ".runtime/runs",
        runId,
      );
      await mkdir(workdir, { recursive: true, mode: 0o700 });
      const adapter = this.service.engines.get(run.engine as EngineId);
      if (!adapter) throw new Error("Unknown engine.");
      const modelConnection =
        run.engine === "fixture"
          ? undefined
          : await new ModelService(db).resolve(
              subject,
              "chat",
              run.model_profile_id,
            );
      await assertRunScope(this.service, subject, run);
      abort.signal.throwIfAborted();
      contextBytes = Buffer.byteLength(context + run.instruction, "utf8");
      const limits = await executionPolicy.check(
        db.pool,
        subject,
        run,
        contextBytes,
      );
      await new MethodsService(db).recordPrepared(subject, run);
      await assertRunScope(this.service, subject, run);
      const engineModel = modelConnection
        ? await (modelGateway = new RunModelGateway(
            modelConnection,
            runId,
            abort.signal,
            async () => {
              await assertRunScope(this.service, subject, run);
              return executionPolicy.check(db.pool, subject, run, contextBytes);
            },
            (error) => abort.abort(error),
          )).start()
        : undefined;
      const result = await adapter.execute({
        runId,
        subject,
        instruction: run.instruction,
        workflow: run.workflow,
        context,
        policy:
          policy.product_principle +
          "\n" +
          policy.policies.map((p: any) => p.id + " " + p.principle).join("\n") +
          "\nEmployee expression preference: " +
          limits.expression +
          ". This changes presentation only; preserve required facts, uncertainty and action receipts.",
        limits,
        workdir,
        model: engineModel,
        signal: abort.signal,
        onProgress: (text) =>
          event("progress.updated", {
            text:
              run.workflow === "manage_approval"
                ? "正在核对审批权限与员工确认的操作。"
                : run.workflow === "manage_calendar"
                  ? "正在核对私人日历范围与来源操作回执。"
                  : run.workflow === "manage_notifications"
                    ? "正在核对提醒范围和员工确认的设置。"
                    : run.workflow === "manage_communication"
                      ? "正在核对员工确认的通信操作和来源回执。"
                      : run.workflow === "manage_organization"
                        ? "正在核对当前组织范围和员工确认的操作。"
                        : run.workflow === "plan_work"
                          ? "正在核对工作范围并整理待确认计划。"
                          : run.workflow === "query_knowledge"
                            ? "正在核对已选资料并生成私人回答。"
                            : isFileWorkflow(run.workflow)
                              ? "正在阅读所选个人文件。"
                              : text,
          }),
      });
      abort.signal.throwIfAborted();
      await executionPolicy.check(
        db.pool,
        subject,
        run,
        contextBytes,
        result.actions.length,
      );
      const allowed = toolsForWorkflow(run.workflow);
      if (result.actions.some((action) => !allowed.includes(action.tool)))
        throw new Error("本次工作类型未授权该业务动作。");
      if (run.workflow === "plan_work") {
        if (
          result.actions.length !== 1 ||
          result.actions[0]?.tool !== "work.plan"
        )
          throw new BadRequestException("一次工作理解只能保存一个待确认计划。");
        await assertRunScope(this.service, subject, run);
        abort.signal.throwIfAborted();
        await new WorkPlanService(db).propose(
          subject,
          run,
          result.actions[0].args,
          sourceIds,
          contextRefs,
          contextBytes,
          result.evidence,
          lease,
        );
        return;
      }
      const required =
        run.workflow === "manage_approval"
          ? ["approval.manage"]
          : run.workflow === "manage_calendar"
            ? ["calendar.manage"]
            : run.workflow === "manage_notifications"
              ? ["notifications.manage"]
              : run.workflow === "manage_communication"
                ? ["communication.manage"]
                : run.workflow === "manage_organization"
                  ? ["organization.manage"]
                  : run.workflow === "query_knowledge"
                    ? ["knowledge.answer"]
                    : run.workflow === "manage_decision"
                      ? [
                          ["create", "revise"].includes(
                            run.decision_plan.operation,
                          )
                            ? "decision.write"
                            : "decision.manage",
                        ]
                      : run.workflow === "share_attachment"
                        ? ["attachment.share"]
                        : run.workflow === "discussion_to_minutes" ||
                            run.workflow === "project_report"
                          ? ["artifact.create", "project.report"]
                          : run.workflow === "assign_task"
                            ? ["task.assign"]
                            : run.workflow === "directory_report"
                              ? ["directory.read"]
                              : run.workflow === "manage_brief"
                                ? [
                                    ["create", "revise"].includes(
                                      run.brief_plan.operation,
                                    )
                                      ? "brief.write"
                                      : "brief.manage",
                                  ]
                                : run.workflow === "manage_spending"
                                  ? ["spending.manage"]
                                  : run.workflow === "usage_report"
                                    ? ["usage.report"]
                                    : run.workflow === "configure_policy"
                                      ? ["policy.configure"]
                                      : run.workflow === "manage_method"
                                        ? [
                                            ["create", "revise"].includes(
                                              run.method_plan.operation,
                                            )
                                              ? "method.write"
                                              : "method.manage",
                                          ]
                                        : run.workflow === "revise_artifact"
                                          ? ["artifact.revise"]
                                          : run.workflow === "revise_task"
                                            ? ["task.update"]
                                            : run.workflow === "review_artifact"
                                              ? ["artifact.review"]
                                              : run.workflow === "follow_up"
                                                ? ["follow_up.check"]
                                                : run.workflow ===
                                                    "configure_follow_up"
                                                  ? ["follow_up.configure"]
                                                  : run.workflow ===
                                                      "draft_reply"
                                                    ? ["communication.draft"]
                                                    : isFileWorkflow(
                                                          run.workflow,
                                                        )
                                                      ? ["file.reading.save"]
                                                      : [];
      if (
        required.length &&
        !result.actions.some((action) => required.includes(action.tool))
      )
        throw new Error("执行器没有提出本次工作要求的成果操作，不能报告完成。");
      if (run.workflow === "revise_artifact" && result.actions.length !== 1)
        throw new Error("一次修订必须对应一个明确的成果版本。");
      if (run.workflow === "manage_method" && result.actions.length !== 1)
        throw new Error("一次方法管理只接受一个明确操作。");
      if (run.workflow === "configure_policy" && result.actions.length !== 1)
        throw new Error("一次执行规则配置只接受一个明确操作。");
      if (run.workflow === "usage_report" && result.actions.length !== 1)
        throw new Error("一次用量查询只接受一个实际回读操作。");
      if (
        [
          "assign_task",
          "directory_report",
          "share_attachment",
          "manage_organization",
          "manage_communication",
          "manage_notifications",
          "manage_calendar",
          "manage_approval",
        ].includes(run.workflow) &&
        result.actions.length !== 1
      )
        throw new Error("一次成员操作只接受一个明确动作。");
      if (run.workflow === "query_knowledge" && result.actions.length !== 1)
        throw new Error("一次资料问答只接受一个带来源的回答。");
      if (run.workflow === "manage_decision" && result.actions.length !== 1)
        throw new Error("一次决定操作只接受一个动作。");
      if (run.workflow === "manage_brief" && result.actions.length !== 1)
        throw new Error("一次任务说明操作只接受一个明确动作。");
      if (run.workflow === "manage_spending" && result.actions.length !== 1)
        throw new Error("一次费用管理只接受一个员工确认的操作。");
      if (run.workflow === "revise_task" && result.actions.length !== 1)
        throw new Error("一次待办修改必须只对应一个明确版本。");
      if (run.workflow === "review_artifact" && result.actions.length !== 1)
        throw new Error("一次验收必须只记录一个明确决定。");
      if (isFileWorkflow(run.workflow) && result.actions.length !== 1)
        throw new Error("一次文件阅读必须只保存一条个人解读。");
      if (run.workflow === "draft_reply" && result.actions.length !== 1)
        throw new Error("一次起草必须只准备一条会话回复。");
      if (run.workflow === "follow_up" && result.actions.length !== 1)
        throw new Error("一次待办检查必须只执行一次状态比较。");
      if (run.workflow === "configure_follow_up" && result.actions.length !== 1)
        throw new Error("一次跟进配置必须只执行一个明确操作。");
      const receipts: Record<string, unknown>[] = [];
      for (const [index, action] of result.actions.entries()) {
        await assertRunScope(this.service, subject, run);
        abort.signal.throwIfAborted();
        receipts.push(
          await this.applyAction(
            subject,
            run,
            lease,
            action,
            index,
            sourceIds,
            result.evidence,
            "configuration" in scope ? scope.configuration : undefined,
            contextBytes,
            result.actions.length,
            abort.signal,
          ),
        );
      }
      await assertRunScope(this.service, subject, run);
      await db.tx(async (c) => {
        await ExecutionPolicyService.lock(c, subject.workspaceId);
        // A confirmed policy change may disable its own workflow; its committed receipt still completes.
        if (run.workflow !== "configure_policy")
          await executionPolicy.check(
            c,
            subject,
            run,
            contextBytes,
            result.actions.length,
          );
        await assertScheduledRun(c, run, true);
        if (run.brief_ref) {
          await WorkBriefService.lock(c, run.brief_ref.id);
          const scope = (
            await c.query(
              "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
              [run.conversation_id, subject.workspaceId],
            )
          ).rows[0];
          await new WorkBriefService(db).reference(
            c,
            subject,
            scope.project_id,
            run.brief_ref,
          );
        }
        const member = await c.query(
          "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [subject.workspaceId, subject.id],
        );
        if (!member.rowCount)
          throw new Error("工作区权限已撤销，不能发布执行结果。");
        if (isFileWorkflow(run.workflow))
          await FileReadingService.lockSource(
            c,
            subject,
            run.source_file_asset_id,
            run.expected_file_version,
          );
        const current = await c.query(
          "SELECT state FROM cw_runs WHERE id=$1 AND lease_owner=$2 FOR UPDATE",
          [runId, lease],
        );
        if (current.rows[0]?.state !== "running") return;
        if (
          run.workflow !== "draft_reply" &&
          run.workflow !== "follow_up" &&
          run.workflow !== "configure_follow_up" &&
          run.workflow !== "manage_notifications" &&
          run.workflow !== "manage_calendar" &&
          run.workflow !== "manage_approval" &&
          run.workflow !== "configure_policy" &&
          run.workflow !== "usage_report" &&
          run.workflow !== "manage_spending" &&
          run.workflow !== "manage_brief" &&
          run.workflow !== "manage_decision" &&
          run.workflow !== "query_knowledge" &&
          run.workflow !== "assign_task" &&
          run.workflow !== "directory_report" &&
          run.workflow !== "manage_communication" &&
          run.workflow !== "manage_organization" &&
          run.workflow !== "share_attachment" &&
          run.workflow !== "review_artifact" &&
          run.workflow !== "revise_task" &&
          run.workflow !== "manage_method" &&
          !isFileWorkflow(run.workflow)
        )
          await c.query(
            "INSERT INTO cw_messages(id,workspace_id,conversation_id,author,role,content,metadata) VALUES($1,$2,$3,'协作助手','assistant',$4,$5)",
            [
              randomUUID(),
              run.workspace_id,
              run.conversation_id,
              result.text,
              { runId, evidence: result.evidence, receipts },
            ],
          );
        await c.query(
          "UPDATE cw_runs SET state='succeeded',result=$2,updated_at=now(),lease_expires_at=NULL WHERE id=$1",
          [
            runId,
            {
              text:
                run.workflow === "manage_approval"
                  ? "已按员工选择核对审批状态或操作回执。"
                  : run.workflow === "manage_calendar"
                    ? "日历操作已按实际来源回执核对；读取结果与写入效果分别记录。"
                    : run.workflow === "manage_notifications"
                      ? run.notification_plan.operation === "read"
                        ? "已读取当前提醒规则与本人的偏好。"
                        : "提醒设置已按确认方案保存，后续获准检查按当前规则处理。"
                      : run.workflow === "manage_communication"
                        ? "通信操作已按来源回执核对；请查看当前会话与实际步骤。"
                        : run.workflow === "manage_organization"
                          ? "组织操作已按实际回执核对；请打开通讯录读取当前状态。"
                          : run.workflow === "query_knowledge"
                            ? "私人资料回答已保存，请核对引用和片段覆盖范围。"
                            : run.workflow === "manage_decision"
                              ? "决定对象已按实际回执保存；待确认提议不表示团队已采纳。"
                              : run.workflow === "draft_reply"
                                ? "回复草稿已保存，尚未发送。"
                                : run.workflow === "follow_up"
                                  ? receipts[0]!.summary
                                  : run.workflow === "configure_follow_up"
                                    ? "定时跟进配置已保存。"
                                    : run.workflow === "configure_policy"
                                      ? "已保存员工确认的执行规则，后续执行按有效限制检查。"
                                      : run.workflow === "share_attachment"
                                        ? "附件分享消息已在来源回读；分享的是活文件引用，不表示收件人已阅读。"
                                        : run.workflow === "assign_task"
                                          ? "已按明确员工身份保存分配记录；不表示已通知该员工或扩大权限。"
                                          : run.workflow === "directory_report"
                                            ? "已回读当前项目成员目录；未自动建号或授予权限。"
                                            : run.workflow === "manage_brief"
                                              ? "任务说明操作已保存；仍需完成必要澄清并确认当前版本后才能按说明执行。"
                                              : run.workflow === "usage_report"
                                                ? "已回读本人的模型请求与费用记录；估算、员工声明和未知项分别标记。"
                                                : run.workflow ===
                                                    "manage_spending"
                                                  ? "已保存员工确认的费用操作；价格和核对金额为员工声明，不代表供应商账单验证。"
                                                  : run.workflow ===
                                                      "review_artifact"
                                                    ? "已记录员工对指定成果版本的验收决定。"
                                                    : run.workflow ===
                                                        "manage_method"
                                                      ? "方法操作已保存，请核对实际状态和版本；不代表模型独立验证了方法。"
                                                      : run.workflow ===
                                                          "revise_task"
                                                        ? "待办记录已核对并保存；不代表实际工作已独立验收。"
                                                        : isFileWorkflow(
                                                              run.workflow,
                                                            )
                                                          ? "个人文件解读已保存。"
                                                          : result.text,
              receipts,
              evidence: result.evidence,
            },
          ],
        );
        await appendEvent(c, runId, "run.completed", {
          receipts,
          evidence: result.evidence,
        });
      });
    } catch (error) {
      await db.tx(async (c) => {
        const current = (
          await c.query("SELECT state FROM cw_runs WHERE id=$1 FOR UPDATE", [
            runId,
          ])
        ).rows[0];
        if (!current || current.state !== "running") return;
        const actions = await c.query(
          "SELECT id FROM cw_actions WHERE run_id=$1 AND state='completed'",
          [runId],
        );
        const external =
          run.workflow === "share_attachment"
            ? await c.query(
                "SELECT id FROM cw_attachment_sends WHERE source_run_id=$1 AND state<>'failed' LIMIT 1",
                [runId],
              )
            : run.workflow === "manage_approval"
              ? await c.query(
                  "SELECT id FROM cw_approval_operations WHERE source_run_id=$1 LIMIT 1",
                  [runId],
                )
              : run.workflow === "manage_calendar"
                ? await c.query(
                    `SELECT id FROM cw_calendar_commands WHERE source_run_id=$1 AND state IN ('applying','succeeded','recovery_required')
                   UNION ALL SELECT id FROM cw_calendar_link_operations WHERE source_run_id=$1 LIMIT 1`,
                    [runId],
                  )
                : run.workflow === "manage_communication"
                  ? await c.query(
                      "SELECT id FROM cw_room_commands WHERE source_run_id=$1 AND state<>'failed' LIMIT 1",
                      [runId],
                    )
                  : { rowCount: 0 };
        const state =
          actions.rowCount || external.rowCount
            ? "recovery_required"
            : "failed";
        // Closing the RPC child is a consequence of a host abort. Keep the
        // controlled host reason instead of replacing it with a closed-pipe error.
        const failure =
          modelGateway?.denial ??
          (abort.signal.aborted && abort.signal.reason instanceof Error
            ? abort.signal.reason
            : error);
        const message = [
          "query_knowledge",
          "plan_work",
          "manage_organization",
          "manage_communication",
          "manage_notifications",
          "manage_calendar",
          "manage_approval",
        ].includes(run.workflow)
          ? failure instanceof ExecutionLimitError ||
            failure instanceof SpendLimitError ||
            failure instanceof BadRequestException
            ? failure.message
            : run.workflow === "manage_approval"
              ? "审批执行未完成，请核对当前申请状态与操作回执。"
              : run.workflow === "manage_calendar"
                ? "日历执行未完成，请核对当前权限与操作回执；未知结果不会自动重发。"
                : run.workflow === "manage_communication"
                  ? "通信操作未完成，请核对当前权限与通信管理回执；未知步骤不会自动重发。"
                  : run.workflow === "manage_notifications"
                    ? "提醒设置未完成，请核对当前范围、权限和规则版本。"
                    : run.workflow === "manage_organization"
                      ? "组织操作未完成，请核对当前权限、组织版本和实际回执。"
                      : run.workflow === "plan_work"
                        ? "工作计划未完成，请核对来源、模型和当前权限。"
                        : "资料问答未完成，请核对来源、模型和实际引用。"
          : isFileWorkflow(run.workflow)
            ? failure instanceof ReadingVersionConflict ||
              failure instanceof ReadingInputLimit ||
              failure instanceof ExecutionLimitError ||
              failure instanceof SpendLimitError
              ? failure.message
              : "文件阅读未完成，请检查来源、模型或重新发起。"
            : failure instanceof Error
              ? failure.message
              : "执行失败。";
        await c.query(
          "UPDATE cw_runs SET state=$2,error=$3,updated_at=now(),lease_expires_at=NULL WHERE id=$1",
          [runId, state, message],
        );
        await appendEvent(
          c,
          runId,
          state === "failed" ? "run.failed" : "run.recovery_required",
          { message },
        );
      });
    } finally {
      await modelGateway?.close();
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (scopeTimer) clearInterval(scopeTimer);
      if (
        isFileWorkflow(run.workflow) ||
        [
          "query_knowledge",
          "plan_work",
          "manage_communication",
          "manage_notifications",
          "manage_calendar",
          "manage_approval",
        ].includes(run.workflow)
      )
        await purgeFileRuntime(db, runId).catch(() =>
          console.error(
            "Private runtime cleanup failed; inspect runtime storage.",
          ),
        );
    }
  }
  private async applyAction(
    s: Subject,
    run: any,
    lease: string,
    action: PlannedAction,
    index: number,
    sourceIds: string[],
    evidence: "fixture" | "runtime",
    configuration?: PreparedFollowUp,
    contextBytes?: number,
    actionCount?: number,
    signal?: AbortSignal,
  ) {
    if (!toolsForWorkflow(run.workflow).includes(action.tool))
      throw new Error("本次工作类型未授权该业务动作。");
    if (
      action.tool === "attachment.share" ||
      action.tool === "communication.manage" ||
      action.tool === "calendar.manage" ||
      action.tool === "approval.manage"
    ) {
      z.object({}).strict().parse(action.args);
      const result =
        action.tool === "approval.manage"
          ? await new ApprovalRunService(this.service.db).execute(s, run, {
              lease,
              contextBytes: contextBytes ?? 0,
              actionCount: actionCount ?? 1,
              signal,
            })
          : action.tool === "calendar.manage"
            ? await new CalendarRunService(this.service.db).execute(s, run, {
                lease,
                contextBytes: contextBytes ?? 0,
                actionCount: actionCount ?? 1,
                signal,
              })
            : action.tool === "communication.manage"
              ? await new RoomManagementService(this.service.db).execute(
                  s,
                  run.room_management_plan,
                  run.id + ":" + index,
                  {
                    row: run,
                    lease,
                    contextBytes: contextBytes ?? 0,
                    actionCount: actionCount ?? 1,
                    signal,
                  },
                )
              : await new AttachmentSendService(this.service.db).send(
                  s,
                  run.attachment_plan,
                  run.id + ":" + index,
                  { row: run, lease, contextBytes, actionCount },
                );
      if (result.state === "failed")
        throw new Error("来源在实际操作前拒绝了请求，请查看对应回执。");
      const actual = { ...result, tool: action.tool };
      // Capture the external fact even if cancellation happened after the dispatched POST.
      // No external network request is made inside this transaction.
      await this.service.db.tx(async (c) => {
        const prior = (
          await c.query(
            "SELECT params_hash FROM cw_actions WHERE idempotency_key=$1",
            [run.id + ":" + index],
          )
        ).rows[0];
        if (prior) {
          if (prior.params_hash !== stableDigest(action))
            throw new Error("Action idempotency conflict.");
          return;
        }
        await c.query(
          "INSERT INTO cw_actions(id,workspace_id,actor_id,run_id,tool,params_hash,idempotency_key,state,result) VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8)",
          [
            randomUUID(),
            s.workspaceId,
            s.id,
            run.id,
            action.tool,
            stableDigest(action),
            run.id + ":" + index,
            actual,
          ],
        );
        await appendEvent(c, run.id, "action.completed", actual);
      });
      if (result.state !== "succeeded")
        throw new Error("来源操作结果待核对；请查看实际回执，未自动重发。");
      return actual;
    }
    const budgetProof =
      action.tool === "spending.manage" &&
      isOrganizationBudgetPlan(run.spending_plan)
        ? (
            await new OrganizationBudgetService(this.service.db).prepare(
              s,
              run.spending_plan,
              false,
            )
          ).proof
        : undefined;
    const notificationService =
      action.tool === "notifications.manage"
        ? new NotificationPolicyService(this.service.db)
        : undefined;
    if (notificationService) {
      z.object({}).strict().parse(action.args);
      const scope = await this.service.conversation(s, run.conversation_id);
      await notificationService.prepare(
        s,
        scope.project_id,
        run.notification_plan,
      );
    }
    const organizationService =
      action.tool === "organization.manage"
        ? new OrganizationService(this.service.db)
        : undefined;
    if (organizationService) z.object({}).strict().parse(action.args);
    const organizationProof = organizationService
      ? await organizationService.prepare(s, run.organization_plan)
      : undefined;
    const organizationRead =
      organizationProof?.plan.operation === "read"
        ? await organizationService!.read(s, organizationProof.plan.query)
        : undefined;
    const memberScope = ["task.assign", "directory.read"].includes(action.tool)
      ? await this.service.conversation(s, run.conversation_id)
      : undefined;
    const assignment =
      action.tool === "task.assign"
        ? await new TaskAssignmentService(this.service.db).prepare(
            s,
            memberScope.project_id,
            run.task_assignment_plan,
          )
        : undefined;
    const directory =
      action.tool === "directory.read"
        ? await new DirectoryService(this.service.db).read(
            s,
            memberScope.project_id,
          )
        : undefined;
    const decisionService = action.tool.startsWith("decision.")
      ? new DecisionService(this.service.db)
      : undefined;
    const decisionScope = decisionService
      ? await this.service.conversation(s, run.conversation_id)
      : undefined;
    const decisionProof = decisionService
      ? await decisionService.prepare(
          s,
          decisionScope.project_id,
          run.decision_plan,
          sourceIds,
        )
      : undefined;
    const knowledgeService =
      action.tool === "knowledge.answer"
        ? new KnowledgeContextService(this.service.db)
        : undefined;
    const knowledgeProof = knowledgeService
      ? await knowledgeService.prepare(s, run.knowledge_plan)
      : undefined;
    const methodTransfer =
      action.tool === "method.manage" &&
      run.method_plan?.operation === "transfer"
        ? await new MethodsService(this.service.db).prepare(
            s,
            run.method_plan,
            (await this.service.conversation(s, run.conversation_id))
              .project_id,
          )
        : undefined;
    return this.service.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      await new ExecutionPolicyService(this.service.db).check(
        c,
        s,
        run,
        contextBytes,
        actionCount,
      );
      await assertScheduledRun(c, run, true);
      if (organizationService) await OrganizationService.lock(c, s.workspaceId);
      if (notificationService || action.tool === "follow_up.check")
        await NotificationPolicyService.lock(c, s.workspaceId);
      if (
        run.brief_ref ||
        (run.brief_plan && run.brief_plan.operation !== "create")
      ) {
        const briefId = run.brief_ref?.id ?? run.brief_plan.briefId;
        await WorkBriefService.lock(c, briefId);
        if (run.brief_ref) {
          const scope = (
            await c.query(
              "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
              [run.conversation_id, s.workspaceId],
            )
          ).rows[0];
          await new WorkBriefService(this.service.db).reference(
            c,
            s,
            scope.project_id,
            run.brief_ref,
          );
        }
      }

      if (assignment)
        await lockTask(c, s, assignment.plan.taskId, memberScope.project_id);
      // Match scheduled checks: target schedule before Run/member locks.
      if (configuration)
        await FollowUpScheduleService.lockTarget(c, s, configuration);
      if (run.workflow === "manage_spending")
        await new ModelSpendingService(this.service.db).lockPlan(
          c,
          s,
          run.spending_plan,
        );
      if (run.method_refs?.length || run.workflow === "manage_method") {
        const scope = (
          await c.query(
            "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
            [run.conversation_id, s.workspaceId],
          )
        ).rows[0];
        if (!scope) throw new Error("方法项目范围不可用。");
        if (run.method_refs?.length)
          await MethodsService.lockReferences(
            c,
            s,
            scope.project_id,
            run.method_refs,
          );
        if (run.workflow === "manage_method")
          await MethodsService.lockTarget(
            c,
            s,
            run.method_plan,
            scope.project_id,
          );
      }
      if (run.workflow === "revise_task") {
        const target = (
          await c.query(
            "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
            [run.conversation_id, s.workspaceId],
          )
        ).rows[0];
        if (!target) throw new Error("待办项目范围不可用。");
        await lockTask(c, s, run.task_id, target.project_id);
      }
      if (["revise_artifact", "review_artifact"].includes(run.workflow)) {
        const scope = (
          await c.query(
            "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
            [run.conversation_id, s.workspaceId],
          )
        ).rows[0];
        if (!scope) throw new Error("成果项目范围不可用。");
        await lockArtifact(c, s, run.artifact_id, scope.project_id);
      }
      if (isFileWorkflow(run.workflow))
        await FileReadingService.lockSource(
          c,
          s,
          run.source_file_asset_id,
          run.expected_file_version,
        );
      if (knowledgeService)
        await knowledgeService.lockSources(
          c,
          s,
          run.knowledge_plan,
          knowledgeProof!,
        );
      const current = (
        await c.query(
          "SELECT state,lease_owner FROM cw_runs WHERE id=$1 FOR UPDATE",
          [run.id],
        )
      ).rows[0];
      if (current?.state !== "running" || current.lease_owner !== lease)
        throw new Error("Task stopped.");
      const member = await c.query(
        "SELECT role FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      );
      if (!member.rowCount) throw new Error("Workspace access revoked.");
      const key = run.id + ":" + index;
      const prior = (
        await c.query(
          "SELECT result,params_hash FROM cw_actions WHERE idempotency_key=$1",
          [key],
        )
      ).rows[0];
      const hash = stableDigest(action);
      if (prior) {
        if (prior.params_hash !== hash)
          throw new Error("Action idempotency conflict.");
        return prior.result;
      }
      const conv = (
        await c.query(
          "SELECT project_id FROM cw_conversations WHERE id=$1 AND workspace_id=$2",
          [run.conversation_id, s.workspaceId],
        )
      ).rows[0];
      if (!conv && !isFileWorkflow(run.workflow))
        throw new Error("Conversation unavailable.");
      let receipt: Record<string, unknown>;
      if (action.tool === "notifications.manage") {
        if (run.notification_plan.operation === "read") {
          const layers = await NotificationPolicyService.layers(
            c,
            s,
            conv.project_id,
          );
          receipt = {
            tool: action.tool,
            operation: "read",
            layers,
            effective: effectiveNotifications(layers),
          };
        } else
          receipt = await notificationService!.apply(
            c,
            s,
            conv.project_id,
            run.notification_plan,
            "notifications:" + run.id,
            run.id,
          );
      } else if (action.tool === "organization.manage") {
        if (organizationRead) {
          receipt = {
            tool: "organization.manage",
            operation: "read",
            checkedAt: organizationRead.checkedAt,
            count: organizationRead.rows.length,
            total: organizationRead.total,
            partial: organizationRead.partial,
            revision: organizationRead.revision,
          };
        } else
          receipt = await organizationService!.apply(
            c,
            s,
            run.organization_plan,
            organizationProof!.scope,
            "organization:" + run.id,
            run.id,
          );
      } else if (action.tool === "knowledge.answer") {
        const answer = z
          .object({ content: z.string().trim().min(1).max(20000) })
          .strict()
          .parse(action.args);
        receipt = await knowledgeService!.save(
          c,
          s,
          run,
          answer.content,
          sourceIds,
        );
      } else if (
        action.tool === "decision.write" ||
        action.tool === "decision.manage"
      ) {
        const writing = ["create", "revise"].includes(
          run.decision_plan.operation,
        );
        if ((action.tool === "decision.write") !== writing)
          throw new Error("决定工具与员工选定操作不符。");
        if (!writing) z.object({}).strict().parse(action.args);
        receipt = {
          ...(await decisionService!.apply(
            c,
            s,
            conv.project_id,
            run.decision_plan,
            writing ? DecisionDraft.parse(action.args) : undefined,
            decisionProof!,
            "decision:" + run.id,
            run.id,
          )),
        };
        await appendEvent(c, run.id, "decision.updated", receipt);
      } else if (action.tool === "task.assign") {
        z.object({}).strict().parse(action.args);
        receipt = await new TaskAssignmentService(this.service.db).apply(
          c,
          s,
          conv.project_id,
          run.task_assignment_plan,
          assignment?.proof,
          "assignment:" + run.id,
          run.id,
        );
        await appendEvent(c, run.id, "task.updated", receipt);
      } else if (action.tool === "directory.read") {
        z.object({}).strict().parse(action.args);
        const binding = (
          await c.query(
            "SELECT * FROM cw_project_sources WHERE project_id=$1 AND workspace_id=$2",
            [conv.project_id, s.workspaceId],
          )
        ).rows[0];
        if (stableDigest(binding ?? null) !== directory!.bindingHash)
          throw new Error("成员来源已变化，请重新读取。");
        receipt = {
          tool: "directory.read",
          projectId: conv.project_id,
          checkedAt: directory!.checkedAt,
          scope: directory!.scope,
          rows: directory!.rows,
        };
      } else if (
        action.tool === "brief.write" ||
        action.tool === "brief.manage"
      ) {
        const writing = ["create", "revise"].includes(run.brief_plan.operation);
        if (writing !== (action.tool === "brief.write"))
          throw new Error("任务说明操作不匹配。");
        if (!writing) z.object({}).strict().parse(action.args);
        receipt = await new WorkBriefService(this.service.db).apply(
          c,
          s,
          conv.project_id,
          run.brief_plan,
          writing ? WorkBriefContent.parse(action.args) : undefined,
          "brief:" + run.id,
          run.id,
        );
      } else if (action.tool === "spending.manage") {
        z.object({}).strict().parse(action.args);
        receipt = await new ModelSpendingService(this.service.db).apply(
          c,
          s,
          run.spending_plan,
          "spending:" + run.id,
          run.id,
          budgetProof,
        );
      } else if (action.tool === "usage.report") {
        z.object({}).strict().parse(action.args);
        const usage = await new ModelUsageService(this.service.db).view(s);
        receipt = {
          tool: "usage.report",
          summary: usage.summary,
          costs: usage.costs,
          costStatus: usage.costStatus,
          note: usage.note,
        };
      } else if (action.tool === "policy.configure") {
        z.object({}).strict().parse(action.args);
        receipt = await new ExecutionPolicyService(this.service.db).apply(
          c,
          s,
          conv.project_id,
          run.policy_plan,
          "configure-policy:" + run.id,
          run.id,
        );
      } else if (action.tool === "file.reading.save") {
        const input = z
          .object({ content: z.string().trim().min(1).max(20000) })
          .strict()
          .parse(action.args);
        receipt = await FileReadingService.save(c, s, run, input.content);
      } else if (
        action.tool === "method.write" ||
        action.tool === "method.manage"
      ) {
        const writing = ["create", "revise"].includes(
          run.method_plan.operation,
        );
        if ((action.tool === "method.write") !== writing)
          throw new Error("方法操作与员工指定计划不符。");
        if (!writing) z.object({}).strict().parse(action.args);
        receipt = await MethodsService.apply(
          c,
          s,
          conv.project_id,
          run.method_plan,
          writing ? action.args : undefined,
          run.id + ":" + index,
          run.id,
          methodTransfer?.transferProof,
        );
        await appendEvent(c, run.id, "method.updated", receipt);
      } else if (action.tool === "task.update") {
        const input = TaskRewrite.parse(action.args);
        receipt = {
          tool: action.tool,
          ...(await patchProjectTask(
            c,
            s,
            run.task_id,
            { ...input, expectedVersion: run.expected_task_version },
            conv.project_id,
            run.id,
          )),
        };
        await appendEvent(c, run.id, "task.updated", receipt);
      } else if (action.tool === "task.create") {
        const input = TaskInput.parse(action.args);
        receipt = {
          tool: action.tool,
          ...(await createProjectTask(c, s, conv.project_id, input, run.id)),
        };
      } else if (
        action.tool === "artifact.create" ||
        action.tool === "project.report"
      ) {
        const title = String(action.args.title ?? "项目成果").slice(0, 300),
          content = action.args.content;
        if (
          typeof content !== "string" ||
          !content.trim() ||
          content.length > 100000
        )
          throw new Error("成果内容无效。");
        receipt = {
          tool: action.tool,
          ...(await createProjectArtifact(
            c,
            s,
            conv.project_id,
            { title, content },
            sourceIds,
          )),
        };
        await appendEvent(c, run.id, "artifact.updated", receipt);
      } else if (action.tool === "artifact.review") {
        z.object({}).strict().parse(action.args);
        receipt = await ArtifactReviewService.apply(
          c,
          s,
          run.artifact_id,
          run.artifact_review_plan,
          conv.project_id,
          "review:" + run.id,
          run.id,
        );
        await appendEvent(c, run.id, "artifact.updated", {
          id: run.artifact_id,
          version: receipt.version,
          status: receipt.status,
          reviewId: receipt.id,
          reviewRevision: receipt.reviewRevision,
        });
      } else if (action.tool === "artifact.revise") {
        const id = run.artifact_id;
        if (!id) throw new Error("No artifact was authorized for revision.");
        if (
          action.args.artifactId !== undefined &&
          action.args.artifactId !== id
        )
          throw new Error("修改目标不属于本次授权成果。");
        const content = action.args.content;
        if (
          typeof content !== "string" ||
          !content.trim() ||
          content.length > 100000
        )
          throw new Error("修订内容无效。");
        const revision = await reviseArtifactVersion(
          c,
          s,
          id,
          {
            content,
            feedback: run.instruction,
            expectedVersion: run.expected_artifact_version,
          },
          conv.project_id,
          sourceIds,
        );
        receipt = { tool: action.tool, ...revision };
        await appendEvent(c, run.id, "artifact.updated", receipt);
      } else if (action.tool === "communication.draft") {
        const input = z
          .object({ content: z.string().trim().min(1).max(20000) })
          .strict()
          .parse(action.args);
        const scope = (
          await c.query(
            "SELECT conversation_ref FROM cw_project_sources WHERE project_id=$1 AND workspace_id=$2",
            [conv.project_id, s.workspaceId],
          )
        ).rows[0];
        if (!scope) throw new Error("回复草稿必须绑定企业会话来源。");
        const id = randomUUID();
        await c.query(
          "INSERT INTO cw_communication_drafts(id,workspace_id,project_id,actor_id,source_run_id,content,source_message_ids) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            s.workspaceId,
            conv.project_id,
            s.id,
            run.id,
            input.content,
            JSON.stringify(sourceIds),
          ],
        );
        receipt = {
          tool: action.tool,
          id,
          roomId: scope.conversation_ref,
          state: "draft",
        };
      } else if (action.tool === "follow_up.configure") {
        z.object({}).strict().parse(action.args);
        if (!configuration) throw new Error("跟进配置范围缺失。");
        receipt = await FollowUpScheduleService.apply(
          c,
          s,
          configuration,
          "configure:" + run.id,
          stableDigest(configuration),
          run.id,
        );
      } else if (action.tool === "follow_up.check") {
        z.object({}).strict().parse(action.args);
        receipt = {
          ...(await FollowUpService.check(
            c,
            s,
            run,
            conv.project_id,
            evidence,
          )),
        };
      } else throw new Error("Tool is not allowed.");
      if (
        ["artifact.create", "project.report", "artifact.revise"].includes(
          action.tool,
        )
      )
        for (const ref of run.method_refs ?? [])
          await c.query(
            `INSERT INTO cw_asset_links(id,workspace_id,from_id,to_id,relation,source_version) VALUES($1,$2,$3,$4,'reused_method',$5) ON CONFLICT(workspace_id,from_id,to_id,relation) DO UPDATE SET source_version=EXCLUDED.source_version`,
            [
              randomUUID(),
              s.workspaceId,
              receipt.id,
              ref.id,
              ref.version + ":" + ref.revision,
            ],
          );
      await c.query(
        "INSERT INTO cw_actions(id,workspace_id,actor_id,run_id,tool,params_hash,idempotency_key,state,result) VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8)",
        [
          randomUUID(),
          s.workspaceId,
          s.id,
          run.id,
          action.tool,
          hash,
          key,
          receipt,
        ],
      );
      await appendEvent(c, run.id, "action.completed", receipt);
      return receipt;
    });
  }
}
