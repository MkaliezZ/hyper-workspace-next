import { OfficeRunInput, isOfficeWorkflow } from "@hyper/contracts/office-runs";
import { OfficeRunService } from "./office-runs.js";
import { OcrRunInput } from "@hyper/contracts/ocr";
import { OcrRunService } from "./ocr-runs.js";
import { verifyKnowledgeSources } from "./knowledge-sources.js";
import { ApprovalRunInput } from "@hyper/contracts/approvals";
import { ApprovalRunService } from "./approval-runs.js";
import { NotificationPolicyService } from "./notification-policy.js";
import { CalendarRunService } from "./calendar-runs.js";
import { CalendarRunInput } from "@hyper/contracts/calendar";
import { RoomManagementService } from "./room-management.js";
import type { RoomManagementRunInput } from "@hyper/contracts/room-management";
import { OrganizationService } from "./organization.js";
import { selectTextChunks, MAX_INDEX_TEXT } from "./text-chunks.js";
import { KnowledgeContextService } from "./knowledge-context.js";
import { DecisionService } from "./decisions.js";
import { TaskAssignmentService } from "./task-assignments.js";
import { AttachmentSendService } from "./attachment-sends.js";
import { WorkBriefService } from "./work-briefs.js";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  Subject,
  FileReadingInput,
  FileReadingRevisionInput,
  RunInput,
  EngineId,
  EngineAdapter,
  EventKind,
  ArtifactRevision,
  TaskInput,
  TaskPatch,
} from "@hyper/contracts";
import { isFileWorkflow } from "@hyper/contracts";
import { Database } from "../db/database.js";
import { assertMember } from "./security.js";
import { maskKey, stableDigest, Vault } from "./credentials.js";
import { reviseArtifactVersion } from "./artifacts.js";
import { ProjectAccess } from "./project-access.js";
import { SourceFileService } from "./source-files.js";
import { FileReadingService } from "./file-readings.js";
import { ModelService } from "./models.js";
import { FollowUpScheduleService } from "./follow-up-schedules.js";
import { ArtifactReviewService } from "./artifact-reviews.js";
import { createProjectTask, patchProjectTask } from "./tasks.js";
import { MethodsService } from "./methods.js";
import { ExecutionPolicyService } from "./execution-policy.js";
import { ModelSpendingService, units } from "./model-spending.js";

export class WorkspaceService {
  constructor(
    readonly db: Database,
    readonly engines: Map<EngineId, EngineAdapter>,
  ) {
    this.access = new ProjectAccess(db);
  }
  readonly access: ProjectAccess;
  async conversation(s: Subject, id: string) {
    await assertMember(this.db, s);
    const r = await this.db.pool.query(
      "SELECT c.*,p.name,p.goal FROM cw_conversations c JOIN cw_projects p ON p.id=c.project_id WHERE c.id=$1 AND c.workspace_id=$2",
      [id, s.workspaceId],
    );
    if (!r.rowCount) throw new NotFoundException("会话不存在或无权访问。");
    await this.access.assert(s, r.rows[0].project_id);
    return r.rows[0];
  }
  async view(s: Subject, projectId?: string) {
    await assertMember(this.db, s);
    if (projectId) await this.access.assert(s, projectId);
    const projects = await this.access.list(s);
    const project = projectId
      ? projects.find((p) => p.id === projectId)
      : (projects.find((p) => p.name === "产品共创") ?? projects[0]);
    if (!project) throw new NotFoundException("工作区尚无可访问项目。");
    const [messages, tasks, artifacts, decisions] = await Promise.all([
      this.db.pool.query(
        'SELECT id,author,role,content,metadata,created_at AS "createdAt" FROM cw_messages WHERE conversation_id=$1 AND workspace_id=$2 ORDER BY position',
        [project.conversationId, s.workspaceId],
      ),
      this.db.pool.query(
        'SELECT id,title,assignee,assignee_id AS "assigneeId",status,to_char(due_date,\'YYYY-MM-DD\') AS "dueDate",version FROM cw_tasks WHERE project_id=$1 AND workspace_id=$2 ORDER BY created_at,id',
        [project.id, s.workspaceId],
      ),
      this.db.pool.query(
        'SELECT a.id,a.title,a.current_version AS version,a.status,a.review_revision AS "reviewRevision",a.accepted_version AS "acceptedVersion",v.content,v.created_at AS "createdAt" FROM cw_artifacts a JOIN cw_artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version WHERE a.project_id=$1 AND a.workspace_id=$2 ORDER BY a.created_at DESC',
        [project.id, s.workspaceId],
      ),
      this.db.pool.query(
        "SELECT d.id,v.snapshot->>'title' AS title,d.current_version AS version,d.confirmed_by AS \"confirmedBy\" FROM cw_decisions d JOIN cw_decision_versions v ON v.decision_id=d.id AND v.version=d.current_version WHERE d.workspace_id=$1 AND d.project_id=$2 AND d.state='confirmed' ORDER BY d.updated_at DESC LIMIT 20",
        [s.workspaceId, project.id],
      ),
    ]);
    await this.access.assert(s, project.id);
    return {
      user: {
        id: s.id,
        name: s.name,
        workspaceId: s.workspaceId,
        role: await assertMember(this.db, s),
        demo: s.demo,
      },
      projects,
      project,
      messages: messages.rows,
      tasks: tasks.rows,
      artifacts: artifacts.rows,
      decisions: decisions.rows,
      engines: Object.fromEntries(
        [...this.engines].map(([k, e]) => [k, e.describeCapabilities()]),
      ),
    };
  }
  async createProject(s: Subject, name: string, goal: string) {
    await assertMember(this.db, s);
    return this.db.tx(async (c) => {
      const id = randomUUID(),
        conversationId = randomUUID();
      await c.query(
        "INSERT INTO cw_projects(id,workspace_id,name,goal) VALUES($1,$2,$3,$4)",
        [id, s.workspaceId, name, goal],
      );
      await c.query(
        "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES($1,$2,$3)",
        [conversationId, s.workspaceId, id],
      );
      return { id, name, goal, conversationId };
    });
  }
  async talkProject(s: Subject, roomId: string) {
    const scope = await this.access.room(s, roomId);
    return (
      (
        await this.db.pool.query(
          'SELECT p.id,p.name,p.goal,c.id AS "conversationId" FROM cw_project_sources x JOIN cw_projects p ON p.id=x.project_id JOIN cw_conversations c ON c.project_id=p.id WHERE x.workspace_id=$1 AND x.provider_key=$2 AND x.conversation_ref=$3',
          [s.workspaceId, scope.providerKey, roomId],
        )
      ).rows[0] ?? null
    );
  }
  async createTalkProject(
    s: Subject,
    roomId: string,
    name: string,
    goal: string,
  ) {
    const scope = await this.access.room(s, roomId);
    return this.db.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        s.workspaceId + scope.providerKey + roomId,
      ]);
      const existing = (
        await c.query(
          'SELECT p.id,p.name,p.goal,c.id AS "conversationId" FROM cw_project_sources x JOIN cw_projects p ON p.id=x.project_id JOIN cw_conversations c ON c.project_id=p.id WHERE x.workspace_id=$1 AND x.provider_key=$2 AND x.conversation_ref=$3',
          [s.workspaceId, scope.providerKey, roomId],
        )
      ).rows[0];
      if (existing) {
        if (existing.name !== name || existing.goal !== goal)
          throw new ConflictException(
            "此会话已有关联项目，请返回后打开现有项目。",
          );
        return existing;
      }
      const id = randomUUID(),
        conversationId = randomUUID();
      await c.query(
        "INSERT INTO cw_projects(id,workspace_id,name,goal) VALUES($1,$2,$3,$4)",
        [id, s.workspaceId, name, goal],
      );
      await c.query(
        "INSERT INTO cw_conversations(id,workspace_id,project_id) VALUES($1,$2,$3)",
        [conversationId, s.workspaceId, id],
      );
      await c.query(
        "INSERT INTO cw_project_sources(project_id,workspace_id,provider_key,source_kind,conversation_ref,created_by) VALUES($1,$2,$3,'nextcloud-talk',$4,$5)",
        [id, s.workspaceId, scope.providerKey, roomId, s.id],
      );
      return { id, name, goal, conversationId };
    });
  }
  async message(s: Subject, conversationId: string, content: string) {
    await this.conversation(s, conversationId);
    const id = randomUUID();
    await this.db.pool.query(
      "INSERT INTO cw_messages(id,workspace_id,conversation_id,author_id,author,role,content) VALUES($1,$2,$3,$4,$5,'user',$6)",
      [id, s.workspaceId, conversationId, s.id, s.name, content],
    );
    return { id };
  }
  async createTask(s: Subject, conversationId: string, input: TaskInput) {
    const conversation = await this.conversation(s, conversationId);
    return this.db.tx((c) =>
      createProjectTask(c, s, conversation.project_id, input),
    );
  }
  async task(s: Subject, id: string, projectId?: string) {
    await assertMember(this.db, s);
    const target = (
      await this.db.pool.query(
        `SELECT id,project_id AS "projectId",title,assignee,assignee_id AS "assigneeId",status,to_char(due_date,'YYYY-MM-DD') AS "dueDate",version
      FROM cw_tasks WHERE id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR project_id=$3)`,
        [id, s.workspaceId, projectId ?? null],
      )
    ).rows[0];
    if (!target) throw new NotFoundException("待办不存在。");
    await this.access.assert(s, target.projectId);
    const history = await this.db.pool.query(
      `SELECT v.version,v.snapshot,v.actor_id AS "actorId",u.name AS "actorName",v.channel,v.policy_version AS "policyVersion",v.source_run_id AS "sourceRunId",v.created_at AS "createdAt"
      FROM cw_task_versions v LEFT JOIN cw_users u ON u.id=v.actor_id WHERE task_id=$1 AND workspace_id=$2 AND version<=$3 ORDER BY version DESC LIMIT 20`,
      [id, s.workspaceId, target.version],
    );
    await this.access.assert(s, target.projectId);
    return { current: target, history: history.rows };
  }
  async patchTask(s: Subject, id: string, patch: TaskPatch) {
    const { current } = await this.task(s, id);
    return this.db.tx((c) =>
      patchProjectTask(c, s, id, patch, current.projectId),
    );
  }
  async artifact(s: Subject, id: string) {
    const role = await assertMember(this.db, s);
    const projectId = await this.artifactProject(s, id);
    const r = await this.db.pool.query(
      `SELECT a.id,a.title,v.version,a.created_by,
      CASE WHEN v.version=a.current_version THEN a.status ELSE coalesce(r.status_after,'draft') END AS status,
      CASE WHEN v.version=a.current_version THEN a.review_revision ELSE coalesce(r.review_revision,0) END AS "reviewRevision",
      CASE WHEN v.version=a.current_version THEN a.accepted_version WHEN r.status_after='accepted' THEN v.version END AS "acceptedVersion",
      v.content,v.feedback,v.source_message_ids AS "sourceMessageIds",v.created_at AS "createdAt"
      FROM cw_artifacts a JOIN cw_artifact_versions v ON v.artifact_id=a.id
      LEFT JOIN LATERAL(SELECT status_after,review_revision FROM cw_artifact_reviews
        WHERE artifact_id=a.id AND artifact_version=v.version ORDER BY review_revision DESC LIMIT 1) r ON true
      WHERE a.id=$1 AND a.workspace_id=$2 ORDER BY v.version DESC`,
      [id, s.workspaceId],
    );
    if (!r.rowCount) throw new NotFoundException("成果不存在。");
    const reviews = await this.db.pool.query(
      `SELECT r.id,r.artifact_version AS version,r.review_revision AS "reviewRevision",
      r.reviewer_id AS "reviewerId",u.name AS "reviewerName",r.reviewer_authority AS "reviewerAuthority",r.policy_version AS "policyVersion",r.decision,r.status_before AS "statusBefore",r.status_after AS status,
      r.feedback,r.confirmed,r.channel,r.source_run_id AS "sourceRunId",r.created_at AS "createdAt"
      FROM cw_artifact_reviews r JOIN cw_users u ON u.id=r.reviewer_id WHERE r.artifact_id=$1 AND r.workspace_id=$2
      ORDER BY r.artifact_version DESC,r.review_revision DESC LIMIT 50`,
      [id, s.workspaceId],
    );
    await this.access.assert(s, projectId);
    return {
      current: r.rows[0],
      versions: r.rows,
      history: r.rows,
      canReview: role === "admin" || r.rows[0].created_by === s.id,
      reviews: reviews.rows,
    };
  }
  async revise(s: Subject, id: string, input: ArtifactRevision) {
    await assertMember(this.db, s);
    const projectId = await this.artifactProject(s, id);
    return this.db.tx((c) => reviseArtifactVersion(c, s, id, input, projectId));
  }
  private async artifactProject(s: Subject, id: string) {
    const target = (
      await this.db.pool.query(
        "SELECT project_id FROM cw_artifacts WHERE id=$1 AND workspace_id=$2",
        [id, s.workspaceId],
      )
    ).rows[0];
    if (!target) throw new NotFoundException("成果不存在。");
    await this.access.assert(s, target.project_id);
    return target.project_id as string;
  }
  async search(s: Subject, query: string) {
    await assertMember(this.db, s);
    if (!query.trim()) return [];
    const projectIds = await this.access.visibleIds(s);
    const fileAccess = await verifyKnowledgeSources(this.db, s);
    const r = await this.db.pool.query(
      'SELECT id,title,content,type,project_id,updated_at::text AS "assetUpdatedAt",EXISTS(SELECT 1 FROM cw_source_bound_assets f WHERE f.asset_id=cw_assets.id) AS "fileSource",source_ref AS "sourceRef",source_version AS "sourceVersion" FROM cw_assets WHERE workspace_id=$1 AND deleted_at IS NULL AND validity=\'active\' AND (visibility=\'workspace\' OR owner_id=$2) AND (project_id IS NULL OR project_id=ANY($4::uuid[])) AND (NOT EXISTS(SELECT 1 FROM cw_source_bound_assets f WHERE f.asset_id=cw_assets.id) OR id=ANY($5::uuid[])) AND (title ILIKE $3 OR content ILIKE $3) ORDER BY created_at DESC LIMIT 30',
      [
        s.workspaceId,
        s.id,
        "%" + query.replace(/[\\%_]/g, "\\$&") + "%",
        projectIds,
        [...fileAccess.keys()],
      ],
    );
    const current = new Set(await this.access.visibleIds(s));
    const finalFiles = await verifyKnowledgeSources(
      this.db,
      s,
      r.rows.filter((row) => row.fileSource).map((row) => row.id),
    );
    const latest = (
      await this.db.pool.query(
        "SELECT id,source_version,updated_at::text AS updated_at FROM cw_assets WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND validity='active' AND deleted_at IS NULL",
        [s.workspaceId, r.rows.map((row) => row.id)],
      )
    ).rows;
    return (await MethodsService.filterAssets(this.db, r.rows))
      .filter((row) => !row.project_id || current.has(row.project_id))
      .filter(
        (row) =>
          !row.fileSource || finalFiles.get(row.id) === row.sourceVersion,
      )
      .filter((row) =>
        latest.some(
          (value) =>
            value.id === row.id &&
            value.source_version === row.sourceVersion &&
            value.updated_at === row.assetUpdatedAt,
        ),
      )
      .map(({ project_id, fileSource, assetUpdatedAt, ...row }) => {
        if (row.content.length > MAX_INDEX_TEXT)
          return {
            ...row,
            content: "资料超过当前片段处理限制，请在来源中查看。",
            chunks: [],
          };
        const selected = selectTextChunks(row.content, query, 3);
        const chunks = selected.chunks.map((chunk) => ({
          ...chunk,
          sourceVersion: row.sourceVersion,
          reference:
            "asset:" +
            row.id +
            "@" +
            encodeURIComponent(row.sourceVersion) +
            "#chars=" +
            chunk.start +
            "-" +
            chunk.end,
        }));
        return {
          ...row,
          content: chunks.map((chunk) => chunk.content).join("\n\n"),
          chunks,
        };
      });
  }
  async models(s: Subject) {
    await assertMember(this.db, s);
    return (
      await this.db.pool.query(
        'SELECT id,name,provider,endpoint,model,purpose,embedding_input_chars AS "embeddingInputChars",CASE WHEN owner_id IS NULL THEN \'workspace\' ELSE \'personal\' END AS scope,key_hint AS "keyHint",verified_at AS "verifiedAt" FROM cw_model_profiles WHERE workspace_id=$1 AND (owner_id IS NULL OR owner_id=$2) ORDER BY created_at',
        [s.workspaceId, s.id],
      )
    ).rows;
  }
  async saveModel(s: Subject, input: any) {
    const role = await assertMember(this.db, s);
    const embeddingInputChars = input.embeddingInputChars ?? 4000;
    if (
      !Number.isInteger(embeddingInputChars) ||
      embeddingInputChars < 200 ||
      embeddingInputChars > 4000 ||
      (input.purpose !== "embedding" && input.embeddingInputChars !== undefined)
    )
      throw new BadRequestException(
        "向量模型输入长度须为 200 至 4000 字符，且仅适用于向量用途。",
      );
    if (input.scope === "workspace" && role !== "admin")
      throw new ForbiddenException("工作区模型由管理员配置。");
    const endpoint = new URL(input.endpoint);
    if (!["https:", "http:"].includes(endpoint.protocol))
      throw new BadRequestException("模型地址必须使用 HTTP 或 HTTPS。");
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new BadRequestException("模型地址不能携带凭据或查询参数。");
    const id = randomUUID();
    const encrypted = input.apiKey ? new Vault().encrypt(input.apiKey) : null;
    await this.db.pool.query(
      "INSERT INTO cw_model_profiles(id,workspace_id,owner_id,name,provider,endpoint,model,purpose,credential_enc,key_hint,embedding_input_chars) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
        s.workspaceId,
        input.scope === "workspace" ? null : s.id,
        input.name,
        input.provider,
        input.endpoint,
        input.model,
        input.purpose,
        encrypted,
        input.apiKey ? maskKey(input.apiKey) : null,
        embeddingInputChars,
      ],
    );
    return { id, name: input.name, verifiedAt: null };
  }
  async runModel(s: Subject, engineId: EngineId, modelProfileId?: string) {
    if (engineId === "fixture" && (!s.demo || process.env.DEMO_MODE !== "true"))
      throw new ForbiddenException("演示执行仅用于演示会话。");
    const engine = this.engines.get(engineId);
    if (!engine?.describeCapabilities().configured)
      throw new BadRequestException(
        engineId + " 执行器尚未配置；不能将演示流程作为真实引擎。",
      );
    const model =
      engineId === "fixture"
        ? undefined
        : await new ModelService(this.db).resolve(s, "chat", modelProfileId);
    const providers = engine.describeCapabilities().modelProviders;
    if (model && providers && !providers.includes(model.provider))
      throw new BadRequestException(
        "所选执行器当前不支持这条连接的 API 类型，请选择兼容连接。",
      );
    return model;
  }
  async startRoomManagementRun(s: Subject, input: RoomManagementRunInput) {
    const rooms = new RoomManagementService(this.db);
    const hash = stableDigest({ ...input, idempotencyKey: undefined });
    const lookup = () =>
      this.db.pool.query(
        "SELECT id,state,input_hash,room_management_plan,room_management_provider_key FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, input.idempotencyKey],
      );
    const replay = async (row: any) => {
      if (row.input_hash !== hash)
        throw new ConflictException("相同幂等键不能用于不同通信任务。");
      await rooms.assertReceiptScope(s, row);
      return { id: row.id, state: row.state, created: false };
    };
    const old = (await lookup()).rows[0];
    if (old) return replay(old);
    let prepared: Awaited<ReturnType<RoomManagementService["prepare"]>>;
    try {
      prepared = await rooms.prepare(s, input.plan);
    } catch (error) {
      const concurrent = (await lookup()).rows[0];
      if (concurrent) return replay(concurrent);
      throw error;
    }
    if (
      !this.engines
        .get(input.engine)
        ?.describeCapabilities()
        .operations.includes("manage_communication")
    )
      throw new BadRequestException("执行器尚未声明通信管理能力。");
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    const result = await this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      const creation = ["create_direct", "create_group"].includes(
        prepared.plan.operation,
      );
      const target = "roomId" in prepared.plan ? prepared.plan.roomId : null;
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "room-command:" +
          s.workspaceId +
          ":" +
          s.id +
          ":" +
          prepared.source.bindingRef +
          ":" +
          (creation ? "creation" : target),
      ]);
      const prior = (
        await c.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) return { rows: [], rowCount: 0 };
      if (
        !(
          await c.query(
            "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
            [s.workspaceId, s.id],
          )
        ).rowCount ||
        !(
          await c.query(
            "SELECT id FROM cw_identity_credentials WHERE id=$1 AND disabled_at IS NULL FOR SHARE",
            [s.identityCredentialId],
          )
        ).rowCount
      )
        throw new ForbiddenException("当前员工或登录已失效。");
      if (prepared.plan.operation !== "read") {
        const queued = (
          await c.query(
            "SELECT id FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND workflow='manage_communication' AND room_management_provider_key=$3 AND state IN ('queued','running') AND (($4::boolean AND room_management_plan->>'operation' IN ('create_direct','create_group')) OR (NOT $4 AND room_management_plan->>'roomId'=$5)) LIMIT 1",
            [
              s.workspaceId,
              s.id,
              prepared.source.config.providerKey,
              creation,
              target,
            ],
          )
        ).rowCount;
        const pending = (
          await c.query(
            "SELECT id FROM cw_room_commands WHERE workspace_id=$1 AND actor_id=$2 AND binding_ref=$3 AND state IN ('dispatching','recovery_required') AND acknowledged_at IS NULL AND (($4::boolean AND operation IN ('create_direct','create_group')) OR (NOT $4 AND source_room_ref=$5)) LIMIT 1",
            [s.workspaceId, s.id, prepared.source.bindingRef, creation, target],
          )
        ).rowCount;
        if (queued || pending)
          throw new ConflictException(
            "此范围已有通信任务或操作待核对，请查看原任务和回执。",
          );
      }
      return c.query(
        "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,input_hash,demo,model_profile_id,identity_credential_id,task_rules,room_management_plan,room_management_provider_key) VALUES($1,$2,$3,NULL,$4,'manage_communication','执行员工明确选定的通信操作；仅以实际回执报告结果。',$5,$6,false,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state",
        [
          randomUUID(),
          s.workspaceId,
          s.id,
          input.engine,
          input.idempotencyKey,
          hash,
          model?.id,
          s.identityCredentialId,
          input.taskRules ?? {},
          prepared.plan,
          prepared.source.config.providerKey,
        ],
      );
    });
    if (result.rowCount) return { ...result.rows[0], created: true };
    return replay((await lookup()).rows[0]);
  }
  async startOfficeRun(s: Subject, raw: OfficeRunInput) {
    if (s.demo || !s.identityCredentialId)
      throw new ForbiddenException("请使用企业账号发起Office  助手。");
    const input = OfficeRunInput.parse(raw);
    const workflow =
      input.plan.operation === "draft" ? "draft_office" : "apply_office";
    const office = new OfficeRunService(this.db);
    const hash = stableDigest({ ...input, idempotencyKey: undefined });
    const lookup = async () =>
      (
        await this.db.pool.query(
          "SELECT id,state,workflow,input_hash,office_plan FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
    const replay = async (row: any) => {
      if (!row || row.workflow !== workflow || row.input_hash !== hash)
        throw new ConflictException("同一执行键不能更换Office  计划。");
      await office.scope(s, row.office_plan);
      return { id: row.id, state: row.state, created: false };
    };
    const old = await lookup();
    if (old) return replay(old);
    const plan = await office.prepare(s, input.plan);
    if (
      !this.engines
        .get(input.engine)
        ?.describeCapabilities()
        .operations.includes(workflow)
    )
      throw new BadRequestException("执行器尚未声明Office  能力。");
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    const inserted = await this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      const member = await c.query(
        "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      );
      const identity = await c.query(
        "SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.workspace_id=$2 AND i.user_id=$3 AND c.disabled_at IS NULL FOR SHARE OF c,i",
        [s.identityCredentialId, s.workspaceId, s.id],
      );
      if (!member.rowCount || !identity.rowCount)
        throw new ForbiddenException("当前员工或登录已失效。");
      return (
        await c.query(
          `INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,
          idempotency_key,input_hash,demo,model_profile_id,identity_credential_id,office_plan)
          VALUES($1,$2,$3,NULL,$4,$10,$11,$5,$6,false,$7,$8,$9)
          ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state`,
          [
            randomUUID(),
            s.workspaceId,
            s.id,
            input.engine,
            input.idempotencyKey,
            hash,
            model?.id,
            s.identityCredentialId,
            plan,
            workflow,
            input.plan.operation === "draft"
              ? input.plan.instruction
              : "按确认方案生成可编辑 Office 副本。",
          ],
        )
      ).rows[0];
    });
    return inserted ? { ...inserted, created: true } : replay(await lookup());
  }
  async startOcrRun(s: Subject, raw: OcrRunInput) {
    if (s.demo || !s.identityCredentialId)
      throw new ForbiddenException("请使用企业账号发起OCR 助手。");
    const input = OcrRunInput.parse(raw);
    const ocr = new OcrRunService(this.db);
    const hash = stableDigest({ ...input, idempotencyKey: undefined });
    const lookup = async () =>
      (
        await this.db.pool.query(
          "SELECT id,state,workflow,input_hash,ocr_plan FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
    const replay = async (row: any) => {
      if (!row || row.workflow !== "recognize_ocr" || row.input_hash !== hash)
        throw new ConflictException("同一执行键不能更换OCR 计划。");
      await ocr.scope(s, row.ocr_plan);
      return { id: row.id, state: row.state, created: false };
    };
    const old = await lookup();
    if (old) return replay(old);
    const plan = await ocr.prepare(s, input.plan);
    if (
      !this.engines
        .get(input.engine)
        ?.describeCapabilities()
        .operations.includes("recognize_ocr")
    )
      throw new BadRequestException("执行器尚未声明OCR 能力。");
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    const inserted = await this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      const member = await c.query(
        "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      );
      const identity = await c.query(
        "SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.workspace_id=$2 AND i.user_id=$3 AND c.disabled_at IS NULL FOR SHARE OF c,i",
        [s.identityCredentialId, s.workspaceId, s.id],
      );
      if (!member.rowCount || !identity.rowCount)
        throw new ForbiddenException("当前员工或登录已失效。");
      return (
        await c.query(
          `INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,
          idempotency_key,input_hash,demo,model_profile_id,identity_credential_id,ocr_plan)
          VALUES($1,$2,$3,NULL,$4,'recognize_ocr','识别员工确认的来源页，保存待校对草稿。',$5,$6,false,$7,$8,$9)
          ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state`,
          [
            randomUUID(),
            s.workspaceId,
            s.id,
            input.engine,
            input.idempotencyKey,
            hash,
            model?.id,
            s.identityCredentialId,
            plan,
          ],
        )
      ).rows[0];
    });
    return inserted ? { ...inserted, created: true } : replay(await lookup());
  }
  async startApprovalRun(s: Subject, raw: ApprovalRunInput) {
    if (s.demo || !s.identityCredentialId)
      throw new ForbiddenException("请使用企业账号发起审批助手。");
    const input = ApprovalRunInput.parse(raw);
    const approvals = new ApprovalRunService(this.db);
    const hash = stableDigest({ ...input, idempotencyKey: undefined });
    const lookup = async () =>
      (
        await this.db.pool.query(
          "SELECT id,state,workflow,input_hash,approval_plan FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
    const replay = async (row: any) => {
      if (!row || row.workflow !== "manage_approval" || row.input_hash !== hash)
        throw new ConflictException("同一执行键不能更换审批计划。");
      await approvals.scope(s, row.approval_plan, row.id);
      return { id: row.id, state: row.state, created: false };
    };
    const old = await lookup();
    if (old) return replay(old);
    const plan = await approvals.prepare(s, input.plan);
    if (
      !this.engines
        .get(input.engine)
        ?.describeCapabilities()
        .operations.includes("manage_approval")
    )
      throw new BadRequestException("执行器尚未声明审批能力。");
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    const inserted = await this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      const member = await c.query(
        "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      );
      const identity = await c.query(
        "SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.workspace_id=$2 AND i.user_id=$3 AND c.disabled_at IS NULL FOR SHARE OF c,i",
        [s.identityCredentialId, s.workspaceId, s.id],
      );
      if (!member.rowCount || !identity.rowCount)
        throw new ForbiddenException("当前员工或登录已失效。");
      return (
        await c.query(
          `INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,
          idempotency_key,input_hash,demo,model_profile_id,identity_credential_id,approval_plan)
          VALUES($1,$2,$3,NULL,$4,'manage_approval','按员工已选的审批范围核对状态。',$5,$6,false,$7,$8,$9)
          ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state`,
          [
            randomUUID(),
            s.workspaceId,
            s.id,
            input.engine,
            input.idempotencyKey,
            hash,
            model?.id,
            s.identityCredentialId,
            plan,
          ],
        )
      ).rows[0];
    });
    return inserted ? { ...inserted, created: true } : replay(await lookup());
  }
  async startCalendarRun(s: Subject, raw: CalendarRunInput) {
    const input = CalendarRunInput.parse(raw),
      calendars = new CalendarRunService(this.db);
    const hash = stableDigest({ ...input, idempotencyKey: undefined });
    const previous = async () =>
      (
        await this.db.pool.query(
          "SELECT * FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
    const replay = async (row: any) => {
      if (row.input_hash !== hash || row.workflow !== "manage_calendar")
        throw new ConflictException("同一执行键不能更换日历任务。");
      await calendars.assertRunScope(s, row);
      return { id: row.id, state: row.state, created: false };
    };
    const old = await previous();
    if (old) return replay(old);
    const prepared = await calendars.prepare(s, input.plan);
    if (
      !this.engines
        .get(input.engine)
        ?.describeCapabilities()
        .operations.includes("manage_calendar")
    )
      throw new BadRequestException("执行器尚未声明日历能力。");
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    const result = await this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      if (
        (
          await c.query(
            "SELECT id FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
            [s.workspaceId, s.id, input.idempotencyKey],
          )
        ).rowCount
      )
        return null;
      const member = await c.query(
        "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
        [s.workspaceId, s.id],
      );
      const identity = await c.query(
        "SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND i.workspace_id=$2 AND i.user_id=$3 AND c.disabled_at IS NULL FOR SHARE OF c,i",
        [s.identityCredentialId, s.workspaceId, s.id],
      );
      if (!member.rowCount || !identity.rowCount)
        throw new ForbiddenException("当前员工或登录已失效。");
      if (input.plan.operation === "apply") {
        const active = await c.query(
          "SELECT id FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND workflow='manage_calendar' AND calendar_plan->>'commandId'=$3 AND state IN ('queued','running') LIMIT 1",
          [s.workspaceId, s.id, input.plan.commandId],
        );
        if (active.rowCount)
          throw new ConflictException(
            "此日历操作已有AI执行，请先查看或停止原执行。",
          );
        const command = await c.query(
          "SELECT state FROM cw_calendar_commands WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 FOR UPDATE",
          [input.plan.commandId, s.workspaceId, s.id],
        );
        if (
          !command.rowCount ||
          ["failed", "cancelled", "applying", "recovery_required"].includes(
            command.rows[0].state,
          )
        )
          throw new ConflictException("请先核对原日历操作，不重新发起AI写入。");
      }
      const id = randomUUID();
      const inserted = await c.query(
        "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,input_hash,demo,model_profile_id,identity_credential_id,calendar_plan,calendar_binding) VALUES($1,$2,$3,NULL,$4,'manage_calendar','执行员工选定的私人日历计划；只以来源回执报告结果。',$5,$6,false,$7,$8,$9,$10) RETURNING id,state",
        [
          id,
          s.workspaceId,
          s.id,
          input.engine,
          input.idempotencyKey,
          hash,
          model?.id,
          s.identityCredentialId,
          prepared.plan,
          prepared.bindingKey,
        ],
      );
      if (input.plan.operation === "apply")
        await c.query(
          "UPDATE cw_calendar_commands SET source_run_id=$2 WHERE id=$1",
          [input.plan.commandId, id],
        );
      return inserted.rows[0];
    });
    return result ? { ...result, created: true } : replay(await previous());
  }
  async startFileRun(s: Subject, assetId: string, input: FileReadingInput) {
    const files = new SourceFileService(this.db);
    await files.assertVersion(s, assetId, input.expectedSourceVersion);
    if (
      !this.engines
        .get(input.engine)
        ?.describeCapabilities()
        .operations.includes("read_file")
    )
      throw new BadRequestException("执行器尚未声明文件阅读能力。");
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    const inputHash = stableDigest({
      ...input,
      assetId,
      workflow: "read_file",
      idempotencyKey: undefined,
    });
    const r = await this.db.pool.query(
      "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,input_hash,demo,model_profile_id,identity_credential_id,source_file_asset_id,expected_file_version) VALUES($1,$2,$3,NULL,$4,'read_file',$5,$6,$7,false,$8,$9,$10,$11) ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state",
      [
        randomUUID(),
        s.workspaceId,
        s.id,
        input.engine,
        input.instruction,
        input.idempotencyKey,
        inputHash,
        model?.id,
        s.identityCredentialId,
        assetId,
        input.expectedSourceVersion,
      ],
    );
    if (r.rowCount) return { ...r.rows[0], created: true };
    const old = (
      await this.db.pool.query(
        "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, input.idempotencyKey],
      )
    ).rows[0];
    if (old.input_hash !== inputHash)
      throw new ConflictException("相同幂等键不能用于不同任务。");
    return { id: old.id, state: old.state, created: false };
  }
  async startFileReadingRevision(
    s: Subject,
    readingId: string,
    input: FileReadingRevisionInput,
  ) {
    const reading = await new FileReadingService(this.db).get(s, readingId);
    const inputHash = stableDigest({
      ...input,
      readingId,
      assetId: reading.assetId,
      sourceVersion: reading.sourceVersion,
      workflow: "revise_file_reading",
      idempotencyKey: undefined,
    });
    const replay = (row: any) => {
      if (row.input_hash !== inputHash)
        throw new ConflictException("相同幂等键不能用于不同任务。");
      return { id: row.id, state: row.state, created: false };
    };
    const lookup = (client: Pick<PoolClient, "query">) =>
      client.query(
        "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, input.idempotencyKey],
      );
    const old = (await lookup(this.db.pool)).rows[0];
    if (old) return replay(old);
    if (reading.version !== input.expectedVersion)
      throw new ConflictException("解读版本已变化，请重新读取后修改。");
    if (reading.version >= 10)
      throw new BadRequestException("当前每条解读最多保留 10 个版本。");
    if (
      !this.engines
        .get(input.engine)
        ?.describeCapabilities()
        .operations.includes("revise_file_reading")
    )
      throw new BadRequestException("执行器尚未声明文件解读修订能力。");
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    return this.db.tx(async (c) => {
      await FileReadingService.lockSource(
        c,
        s,
        reading.assetId,
        reading.sourceVersion,
      );
      const existing = (await lookup(c)).rows[0];
      if (existing) return replay(existing);
      const target = (
        await c.query(
          `SELECT current_version FROM cw_file_readings WHERE id=$1 AND workspace_id=$2
        AND actor_id=$3 AND source_asset_id=$4 AND source_version=$5 AND invalidated_at IS NULL FOR SHARE`,
          [
            readingId,
            s.workspaceId,
            s.id,
            reading.assetId,
            reading.sourceVersion,
          ],
        )
      ).rows[0];
      if (!target || target.current_version !== input.expectedVersion)
        throw new ConflictException("解读版本已变化，请重新读取后修改。");
      const result = await c.query(
        `INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,idempotency_key,
        input_hash,demo,model_profile_id,identity_credential_id,source_file_asset_id,expected_file_version,source_file_reading_id,expected_reading_version)
        VALUES($1,$2,$3,NULL,$4,'revise_file_reading',$5,$6,$7,false,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state`,
        [
          randomUUID(),
          s.workspaceId,
          s.id,
          input.engine,
          input.instruction,
          input.idempotencyKey,
          inputHash,
          model?.id,
          s.identityCredentialId,
          reading.assetId,
          reading.sourceVersion,
          readingId,
          input.expectedVersion,
        ],
      );
      if (result.rowCount) return { ...result.rows[0], created: true };
      return replay((await lookup(c)).rows[0]);
    });
  }
  async startRun(s: Subject, input: RunInput) {
    if (isOfficeWorkflow(input.workflow))
      throw new BadRequestException("请从所选文件的 Office 助手入口发起。");
    if (input.workflow === "recognize_ocr")
      throw new BadRequestException("OCR 必须从员工选择的文件页发起。");
    if (input.workflow === "manage_approval")
      throw new BadRequestException("请从审批专用入口发起。");
    if (input.workflow === "manage_calendar")
      throw new BadRequestException("请从日历专用入口发起。");
    if (input.workflow === "manage_communication")
      throw new BadRequestException("请从通信管理专用入口发起。");
    if (isFileWorkflow(input.workflow))
      throw new BadRequestException("请从个人文件阅读入口发起。");
    const conversation = await this.conversation(s, input.conversationId);
    if (input.notificationPlan || input.workflow === "manage_notifications") {
      const allowed = new Set([
        "conversationId",
        "workflow",
        "engine",
        "instruction",
        "modelProfileId",
        "notificationPlan",
        "taskRules",
        "idempotencyKey",
      ]);
      if (
        input.workflow !== "manage_notifications" ||
        !input.notificationPlan ||
        Object.keys(input).some((key) => !allowed.has(key))
      )
        throw new BadRequestException(
          "提醒设置只接受一个明确的规则方案，不混入其他业务目标。",
        );
      const prior = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: prior.id, state: prior.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("manage_notifications")
      )
        throw new BadRequestException("执行器尚未声明提醒设置能力。");
      await new NotificationPolicyService(this.db).prepare(
        s,
        conversation.project_id,
        input.notificationPlan,
      );
    }
    if (input.organizationPlan || input.workflow === "manage_organization") {
      const allowed = new Set([
        "conversationId",
        "workflow",
        "engine",
        "instruction",
        "modelProfileId",
        "organizationPlan",
        "taskRules",
        "idempotencyKey",
      ]);
      if (
        input.workflow !== "manage_organization" ||
        !input.organizationPlan ||
        Object.keys(input).some((key) => !allowed.has(key))
      )
        throw new BadRequestException(
          "组织操作只接受一个明确的员工选择，不混入其他业务目标。",
        );
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("manage_organization")
      )
        throw new BadRequestException("执行器未声明组织管理能力。");
      const previous = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能更换任务。");
        return { id: previous.id, state: previous.state, created: false };
      }
      await new OrganizationService(this.db).prepare(s, input.organizationPlan);
    }
    let knowledgeScope:
      | Awaited<ReturnType<KnowledgeContextService["prepare"]>>
      | undefined;
    if (input.knowledgePlan || input.workflow === "query_knowledge") {
      if (
        input.workflow !== "query_knowledge" ||
        !input.knowledgePlan ||
        input.artifactId ||
        input.taskId ||
        input.decisionPlan ||
        input.methodPlan ||
        input.methodRefs?.length ||
        input.briefPlan ||
        input.briefRef ||
        input.taskAssignmentPlan ||
        input.attachmentPlan ||
        input.followUpPlan ||
        input.policyPlan ||
        input.spendingPlan ||
        input.artifactReviewPlan
      )
        throw new BadRequestException(
          "知识问答只接受明确选中的资料版本与问题。",
        );
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("query_knowledge")
      )
        throw new BadRequestException("执行器未声明知识问答能力。");
      knowledgeScope = await new KnowledgeContextService(this.db).prepare(
        s,
        input.knowledgePlan,
      );
    }
    if (input.decisionPlan || input.workflow === "manage_decision") {
      if (
        input.workflow !== "manage_decision" ||
        !input.decisionPlan ||
        input.artifactId ||
        input.taskId ||
        input.methodPlan ||
        input.methodRefs?.length ||
        input.briefPlan ||
        input.briefRef ||
        input.taskAssignmentPlan ||
        input.attachmentPlan ||
        input.followUpPlan ||
        input.policyPlan ||
        input.spendingPlan ||
        input.artifactReviewPlan
      )
        throw new BadRequestException("决定执行只接受单一明确的项目操作。");
      const previous = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能更换任务。");
        return { id: previous.id, state: previous.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("manage_decision")
      )
        throw new BadRequestException("执行器未声明决定操作能力。");
      await new DecisionService(this.db).prepare(
        s,
        conversation.project_id,
        input.decisionPlan,
      );
    }
    if (input.attachmentPlan || input.workflow === "share_attachment") {
      if (
        input.workflow !== "share_attachment" ||
        !input.attachmentPlan ||
        input.artifactId ||
        input.taskId ||
        input.methodPlan ||
        input.methodRefs?.length ||
        input.briefPlan ||
        input.briefRef ||
        input.taskAssignmentPlan ||
        input.followUpPlan ||
        input.policyPlan ||
        input.spendingPlan ||
        input.artifactReviewPlan
      )
        throw new BadRequestException(
          "附件发送只接受员工确认的单一会话与文件。",
        );
      const prior = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: prior.id, state: prior.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes(input.workflow)
      )
        throw new BadRequestException("执行器未声明附件发送能力。");
      await new AttachmentSendService(this.db).prepare(
        s,
        input.attachmentPlan,
        conversation.project_id,
      );
    }
    if (
      input.taskAssignmentPlan ||
      ["assign_task", "directory_report"].includes(input.workflow)
    ) {
      if (
        (input.workflow === "assign_task") !== !!input.taskAssignmentPlan ||
        input.artifactId ||
        input.taskId ||
        input.methodRefs?.length ||
        input.briefRef ||
        input.briefPlan
      )
        throw new BadRequestException(
          "请从员工分配或成员目录入口选择明确范围。",
        );
      const prior = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: prior.id, state: prior.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes(input.workflow)
      )
        throw new BadRequestException("执行器未声明此成员能力。");
      if (input.taskAssignmentPlan)
        await new TaskAssignmentService(this.db).prepare(
          s,
          conversation.project_id,
          input.taskAssignmentPlan,
        );
    }
    if (
      input.briefPlan ||
      input.briefRef ||
      input.workflow === "manage_brief"
    ) {
      if (
        (input.workflow === "manage_brief") !== !!input.briefPlan ||
        (input.briefPlan &&
          (input.briefRef ||
            input.artifactId ||
            input.taskId ||
            input.methodRefs?.length))
      )
        throw new BadRequestException("请从任务说明入口选择明确操作。");
      if (
        input.briefRef &&
        ![
          "discussion_to_minutes",
          "project_report",
          "revise_artifact",
        ].includes(input.workflow)
      )
        throw new BadRequestException("此工作类型不接受任务说明引用。");
      const old = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: old.id, state: old.state, created: false };
      }
      if (input.briefPlan) {
        if (
          !this.engines
            .get(input.engine)
            ?.describeCapabilities()
            .operations.includes("manage_brief")
        )
          throw new BadRequestException("执行器未声明任务说明能力。");
        await new WorkBriefService(this.db).prepare(
          s,
          conversation.project_id,
          input.briefPlan,
        );
      }
      if (input.briefRef)
        await new WorkBriefService(this.db).reference(
          this.db.pool,
          s,
          conversation.project_id,
          input.briefRef,
        );
    }
    if (input.workflow === "manage_method") {
      if (
        !input.methodPlan ||
        input.artifactId ||
        input.taskId ||
        input.methodRefs?.length
      )
        throw new BadRequestException("请从方法入口指定唯一操作和范围。");
      const old = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: old.id, state: old.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("manage_method")
      )
        throw new BadRequestException("执行器未声明方法管理能力。");
      await new MethodsService(this.db).prepare(
        s,
        input.methodPlan,
        conversation.project_id,
      );
    } else if (input.methodPlan)
      throw new BadRequestException("此工作类型不接受方法管理计划。");
    if (input.methodRefs?.length) {
      if (
        ![
          "discussion_to_minutes",
          "project_report",
          "revise_artifact",
        ].includes(input.workflow)
      )
        throw new BadRequestException("此工作类型不能复用方法。");
      const old = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: old.id, state: old.state, created: false };
      }
      await new MethodsService(this.db).references(
        s,
        conversation.project_id,
        input.methodRefs,
      );
    }
    if (input.workflow === "manage_spending") {
      if (!input.spendingPlan || input.artifactId)
        throw new BadRequestException("请先指定明确的费用配置或核对方案。");
      const prior = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: prior.id, state: prior.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("manage_spending")
      )
        throw new BadRequestException("执行器未声明费用管理能力。");
      await new ModelSpendingService(this.db).prepare(s, input.spendingPlan);
    } else if (input.spendingPlan)
      throw new BadRequestException("此工作类型不接受费用管理方案。");
    if (input.workflow === "configure_policy") {
      if (!input.policyPlan || input.artifactId)
        throw new BadRequestException("请明确指定执行规则与范围。");
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("configure_policy")
      )
        throw new BadRequestException("执行器未声明执行规则配置能力。");
      const prior = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: prior.id, state: prior.state, created: false };
      }
      await new ExecutionPolicyService(this.db).prepare(
        s,
        conversation.project_id,
        input.policyPlan,
      );
    } else if (input.policyPlan)
      throw new BadRequestException("此工作类型不接受执行规则配置。");
    if (input.workflow === "configure_follow_up") {
      if (!input.followUpPlan || input.artifactId)
        throw new BadRequestException("请明确指定跟进配置与范围。");
      const old = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: old.id, state: old.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("configure_follow_up")
      )
        throw new BadRequestException("所选执行器未声明跟进配置能力。");
      await new FollowUpScheduleService(this).prepare(
        s,
        input.conversationId,
        input.followUpPlan,
        input.engine,
        input.modelProfileId,
      );
    } else if (input.followUpPlan)
      throw new BadRequestException("此工作类型不接受跟进配置。");
    if (input.workflow === "follow_up" && input.artifactId)
      throw new BadRequestException("待办检查不接受成果目标。");
    if (
      input.workflow === "draft_reply" &&
      !(await this.access.binding(s, conversation.project_id))
    )
      throw new BadRequestException("请先从企业会话创建关联项目，再起草回复。");
    let expectedVersion: number | null = null;
    if (input.workflow === "revise_task") {
      if (!input.taskId || !input.expectedTaskVersion || input.artifactId)
        throw new BadRequestException("请指定待办、当前版本和修改要求。");
      const old = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: old.id, state: old.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("revise_task")
      )
        throw new BadRequestException("所选执行器未声明待办修改能力。");
      const task = await this.task(s, input.taskId, conversation.project_id);
      if (task.current.version !== input.expectedTaskVersion)
        throw new ConflictException("待办已更新，请重新读取后修改。");
    } else if (input.taskId || input.expectedTaskVersion)
      throw new BadRequestException("此工作类型不接受待办修改目标。");
    if (input.workflow === "review_artifact") {
      if (!input.artifactId || !input.artifactReviewPlan)
        throw new BadRequestException("请指定成果、版本和明确验收决定。");
      const old = (
        await this.db.pool.query(
          "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.input_hash !==
          stableDigest({ ...input, idempotencyKey: undefined })
        )
          throw new ConflictException("相同幂等键不能用于不同任务。");
        return { id: old.id, state: old.state, created: false };
      }
      if (
        !this.engines
          .get(input.engine)
          ?.describeCapabilities()
          .operations.includes("review_artifact")
      )
        throw new BadRequestException("所选执行器未声明验收代执行能力。");
      await new ArtifactReviewService(this.db).prepare(
        s,
        input.artifactId,
        input.artifactReviewPlan,
        conversation.project_id,
      );
      expectedVersion = input.artifactReviewPlan.expectedVersion;
    } else if (input.artifactReviewPlan)
      throw new BadRequestException("此工作类型不接受验收决定。");
    if (input.workflow === "revise_artifact") {
      if (!input.artifactId)
        throw new BadRequestException("请指定要修改的成果。");
      const artifact = (
        await this.db.pool.query(
          "SELECT current_version FROM cw_artifacts WHERE id=$1 AND workspace_id=$2 AND project_id=$3",
          [input.artifactId, s.workspaceId, conversation.project_id],
        )
      ).rows[0];
      if (!artifact) throw new NotFoundException("成果不在当前项目中。");
      expectedVersion = artifact.current_version;
    }
    const model = await this.runModel(s, input.engine, input.modelProfileId);
    if (input.workflow === "plan_work" && input.artifactId)
      throw new BadRequestException(
        "工作计划目标在计划内明确解析，请勿混入另一个成果目标。",
      );
    if (
      input.workflow === "plan_work" &&
      !this.engines
        .get(input.engine)
        ?.describeCapabilities()
        .operations.includes("plan_work")
    )
      throw new BadRequestException("执行器未声明工作计划能力。");
    const inputHash = stableDigest({ ...input, idempotencyKey: undefined });
    const id = randomUUID();
    const insertRun = (c: PoolClient | Database["pool"]) =>
      c.query(
        "INSERT INTO cw_runs(id,workspace_id,actor_id,conversation_id,engine,workflow,instruction,artifact_id,idempotency_key,input_hash,demo,model_profile_id,expected_artifact_version,identity_credential_id,follow_up_plan,artifact_review_plan,task_id,expected_task_version,method_plan,method_refs,policy_plan,task_rules,spending_plan,brief_plan,brief_ref,task_assignment_plan,attachment_plan,decision_plan,knowledge_plan,organization_plan,notification_plan) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) ON CONFLICT(workspace_id,actor_id,idempotency_key) DO NOTHING RETURNING id,state",
        [
          id,
          s.workspaceId,
          s.id,
          input.conversationId,
          input.engine,
          input.workflow,
          input.instruction,
          input.artifactId ?? null,
          input.idempotencyKey,
          inputHash,
          s.demo,
          model?.id ?? null,
          expectedVersion,
          s.identityCredentialId ?? null,
          input.followUpPlan ?? null,
          input.artifactReviewPlan ?? null,
          input.taskId ?? null,
          input.expectedTaskVersion ?? null,
          input.methodPlan ?? null,
          JSON.stringify(input.methodRefs ?? []),
          input.policyPlan ?? null,
          input.taskRules ?? {},
          input.spendingPlan ?? null,
          input.briefPlan ?? null,
          input.briefRef ?? null,
          input.taskAssignmentPlan ?? null,
          input.attachmentPlan ?? null,
          input.decisionPlan ?? null,
          input.knowledgePlan ?? null,
          input.organizationPlan ?? null,
          input.notificationPlan ?? null,
        ],
      );
    const r = knowledgeScope
      ? await this.db.tx(async (c) => {
          await new KnowledgeContextService(this.db).lockSources(
            c,
            s,
            input.knowledgePlan!,
            knowledgeScope!,
          );
          const result = await insertRun(c);
          if (result.rowCount)
            for (const ref of input.knowledgePlan!.assetRefs)
              await c.query(
                "INSERT INTO cw_run_knowledge_sources(run_id,asset_id,source_version)VALUES($1,$2,$3)",
                [id, ref.id, ref.sourceVersion],
              );
          return result;
        })
      : await insertRun(this.db.pool);
    if (r.rowCount) return { ...r.rows[0], created: true };
    const old = (
      await this.db.pool.query(
        "SELECT id,state,input_hash FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, input.idempotencyKey],
      )
    ).rows[0];
    if (old.input_hash !== inputHash)
      throw new ConflictException("相同幂等键不能用于不同任务。");
    return { id: old.id, state: old.state, created: false };
  }
  async recentRuns(s: Subject, projectId: string, before?: string) {
    await assertMember(this.db, s);
    await this.access.assert(s, projectId);
    const rows = (
      await this.db.pool.query(
        `SELECT r.id,r.state,r.engine,r.workflow,r.created_at AS "createdAt"
         FROM cw_runs r JOIN cw_conversations v
           ON v.id=r.conversation_id AND v.workspace_id=r.workspace_id
         WHERE r.workspace_id=$1 AND r.actor_id=$2 AND v.project_id=$3
           AND ($4::uuid IS NULL OR (r.created_at,r.id)<(
             SELECT previous.created_at,previous.id FROM cw_runs previous
             JOIN cw_conversations pv ON pv.id=previous.conversation_id AND pv.workspace_id=previous.workspace_id
             WHERE previous.id=$4 AND previous.workspace_id=$1 AND previous.actor_id=$2 AND pv.project_id=$3
           ))
         ORDER BY r.created_at DESC,r.id DESC LIMIT 21`,
        [s.workspaceId, s.id, projectId, before ?? null],
      )
    ).rows;
    await assertMember(this.db, s);
    await this.access.assert(s, projectId);
    const items = rows.slice(0, 20);
    return {
      items,
      hasMore: rows.length > 20,
      before: items.at(-1)?.id ?? null,
    };
  }
  async getRun(s: Subject, id: string) {
    await assertMember(this.db, s);
    const target = (
      await this.db.pool.query(
        "SELECT conversation_id,source_file_asset_id,expected_file_version,knowledge_plan,room_management_plan,room_management_provider_key,calendar_plan,calendar_binding,approval_plan,ocr_plan,office_plan,(instruction='') AS source_redacted FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!target) throw new NotFoundException("执行不存在或无权访问。");
    if (target.office_plan && target.source_redacted)
      throw new NotFoundException("Office 执行已因来源失效而清理。");
    if (target.source_file_asset_id && target.source_redacted)
      throw new NotFoundException("文件执行已因来源失效而清理。");
    if (target.source_file_asset_id)
      await new SourceFileService(this.db).assertVersion(
        s,
        target.source_file_asset_id,
        target.expected_file_version,
      );
    else if (target.office_plan)
      await new OfficeRunService(this.db).scope(s, target.office_plan);
    else if (target.ocr_plan)
      await new OcrRunService(this.db).scope(s, target.ocr_plan);
    else if (target.approval_plan)
      await new ApprovalRunService(this.db).scope(s, target.approval_plan, id);
    else if (target.calendar_plan)
      await new CalendarRunService(this.db).assertRunScope(s, {
        ...target,
        id,
      });
    else if (target.room_management_plan)
      await new RoomManagementService(this.db).assertReceiptScope(s, {
        ...target,
        id,
      });
    else await this.conversation(s, target.conversation_id);
    if (target.knowledge_plan) {
      if (target.source_redacted)
        throw new NotFoundException("检索来源已失效，私人回答不可读取。");
      await new KnowledgeContextService(this.db).checkRun(s, {
        id,
        knowledge_plan: target.knowledge_plan,
      });
    }
    const r = await this.db.pool.query(
      'SELECT id,state,engine,workflow,artifact_id AS "artifactId",task_id AS "taskId",method_plan AS "methodPlan",method_refs AS "methodRefs",execution_policy_snapshot AS "executionPolicy",brief_ref AS "briefRef",task_assignment_plan AS "taskAssignmentPlan",attachment_plan AS "attachmentPlan",decision_plan AS "decisionPlan",organization_plan AS "organizationPlan",knowledge_plan AS "knowledgePlan",knowledge_answer AS "knowledgeAnswer",instruction,result,error,context_refs AS "contextRefs",created_at AS "createdAt",updated_at AS "updatedAt" FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3',
      [id, s.workspaceId, s.id],
    );
    if (!r.rowCount) throw new NotFoundException("执行不存在或无权访问。");
    const usage = (
      await this.db.pool.query(
        `SELECT count(*)::int AS requests,count(*) FILTER(WHERE usage_status='reported')::int AS reported,count(*) FILTER(WHERE usage_status<>'reported')::int AS incomplete,sum(input_tokens)::float8 AS "reportedInputTokens",sum(output_tokens)::float8 AS "reportedOutputTokens" FROM cw_model_requests WHERE run_id=$1 AND workspace_id=$2 AND actor_id=$3`,
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    const costs = (
      await this.db.pool.query(
        `SELECT cost_currency AS currency,sum(COALESCE(declared_cost_picos,estimated_cost_picos))::text AS amount,count(*) FILTER(WHERE declared_cost_picos IS NULL AND estimated_cost_picos IS NULL)::int AS unknown FROM cw_model_requests WHERE run_id=$1 AND workspace_id=$2 AND actor_id=$3 AND cost_currency IS NOT NULL GROUP BY cost_currency ORDER BY cost_currency`,
        [id, s.workspaceId, s.id],
      )
    ).rows.map((row) => ({
      ...row,
      amount: row.amount === null ? null : units(row.amount),
    }));
    r.rows[0].modelUsage = {
      ...usage,
      costs,
      costStatus: costs.length
        ? "estimates-and-declarations"
        : "not-configured",
    };
    if (target.knowledge_plan) {
      await this.conversation(s, target.conversation_id);
      await new KnowledgeContextService(this.db).checkRun(s, {
        id,
        knowledge_plan: target.knowledge_plan,
      });
    }
    if (target.office_plan) {
      const receipt = await new OfficeRunService(this.db).recordedReceipt(
        s,
        id,
      );
      if (receipt)
        r.rows[0].result = { ...r.rows[0].result, receipts: [receipt] };
    }
    if (target.ocr_plan && !r.rows[0].result?.receipts?.length) {
      const receipt = await new OcrRunService(this.db).recordedReceipt(s, id);
      if (receipt)
        r.rows[0].result = { ...r.rows[0].result, receipts: [receipt] };
    }
    if (target.approval_plan && !r.rows[0].result?.receipts?.length) {
      const receipt = await new ApprovalRunService(this.db).recordedReceipt(
        s,
        id,
      );
      if (receipt)
        r.rows[0].result = { ...r.rows[0].result, receipts: [receipt] };
    }
    if (target.room_management_plan)
      r.rows[0].result = await new RoomManagementService(
        this.db,
      ).publicRunMetadata(s, r.rows[0].result);
    return r.rows[0];
  }
  async events(s: Subject, id: string, after = 0, limit = 2147483647) {
    const run = await this.getRun(s, id);
    const rows = (
      await this.db.pool.query(
        'SELECT event_id AS "eventId",run_id AS "runId",sequence,kind,data,occurred_at AS "occurredAt",\'1.0.0\' AS "schemaVersion" FROM cw_run_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3',
        [id, after, limit],
      )
    ).rows;
    return run.workflow === "manage_communication"
      ? new RoomManagementService(this.db).publicRunMetadata(s, rows)
      : rows;
  }
  async cancel(s: Subject, id: string) {
    await assertMember(this.db, s);
    const owned = await this.db.pool.query(
      "SELECT id FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
      [id, s.workspaceId, s.id],
    );
    if (!owned.rowCount) throw new NotFoundException("执行不存在或无权访问。");
    await this.db.tx(async (c) => {
      const r = await c.query(
        "UPDATE cw_runs SET state='cancelled',updated_at=now() WHERE id=$1 AND state IN ('queued','running','waiting_input','waiting_confirmation') RETURNING id,calendar_plan",
        [id],
      );
      if (r.rows[0]?.calendar_plan?.operation === "apply")
        await c.query(
          "UPDATE cw_calendar_commands SET stop_requested_at=COALESCE(stop_requested_at,now()),state=CASE WHEN state='prepared' THEN 'cancelled' ELSE state END,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND source_run_id=$4",
          [r.rows[0].calendar_plan.commandId, s.workspaceId, s.id, id],
        );
      if (r.rowCount)
        await appendEvent(c, id, "run.cancelled", {
          message: "已停止后续执行；已完成操作保留。",
        });
    });
    return (
      await this.db.pool.query(
        "SELECT id,state FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
  }
}
export async function appendEvent(
  c: PoolClient,
  runId: string,
  kind: EventKind,
  data: Record<string, unknown>,
) {
  const r = await c.query(
    "UPDATE cw_runs SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence",
    [runId],
  );
  await c.query(
    "INSERT INTO cw_run_events(event_id,run_id,sequence,kind,data) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), runId, r.rows[0].sequence, kind, data],
  );
}
