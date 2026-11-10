import { OcrRunService } from "./core/ocr-runs.js";
import { verifyKnowledgeSources } from "./core/knowledge-sources.js";
import { OcrCorrection, OcrRecognition, OcrRunInput, OcrSource } from "@hyper/contracts/ocr";
import { OcrService } from "./core/ocr.js";
import { ApprovalRunInput } from "@hyper/contracts/approvals";
import { NotificationPolicyService } from "./core/notification-policy.js";
import { CalendarService } from "./core/calendar.js";
import { CalendarRunService } from "./core/calendar-runs.js";
import { ApprovalRunService } from "./core/approval-runs.js";
import { ApprovalService } from "./core/approvals.js";
import {
  CalendarCommandInput,
  CalendarQuery,
  CalendarRunInput,
  CalendarAvailabilityQuery,
} from "@hyper/contracts/calendar";
import { NotificationInput } from "@hyper/contracts/notifications";
import { RoomManagementService } from "./core/room-management.js";
import { CommunicationSearchService } from "./core/communication-search.js";
import {
  RoomManagementInput,
  RoomManagementRunInput,
} from "@hyper/contracts/room-management";
import { OrganizationService } from "./core/organization.js";
import { OfficeSource, OrganizationPlan, OrganizationQuery } from "@hyper/contracts";
import { KnowledgeContextService } from "./core/knowledge-context.js";
import { WorkPlanService } from "./core/work-plans.js";
import { WorkPlanResponse, WorkProposal } from "@hyper/contracts";
import { KnowledgePlan } from "@hyper/contracts";
import { DecisionService } from "./core/decisions.js";
import { DecisionMutation } from "@hyper/contracts";
import { DirectoryService } from "./core/directory.js";
import { TaskAssignmentService } from "./core/task-assignments.js";
import { TaskAssignmentInput } from "@hyper/contracts";
import { WorkBriefInput } from "@hyper/contracts";
import { WorkBriefService } from "./core/work-briefs.js";
import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Param,
  Query,
  Req,
  Res,
  Module,
  HttpException,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  UseFilters,
  Catch,
  type ExceptionFilter,
  type ArgumentsHost,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applicationConfig } from "./core/application-config.js";
import { z, ZodError } from "zod";
import {
  RunInput,
  NewMessage,
  TaskInput,
  TaskPatch,
  ArtifactRevision,
  ModelInput,
  CommunicationSendInput,
  TalkFileId,
  AttachmentEtag,
  FollowUpConfiguration,
  ArtifactReviewInput,
  MethodActionInput,
  ExecutionPolicyInput,
  ModelSpendingInput,
} from "@hyper/contracts";
import { Database, DEMO } from "./db/database.js";
import { authenticate, issueSession } from "./core/security.js";
import { digest } from "./core/credentials.js";
import { WorkspaceService } from "./core/workspace.js";
import { RunProcessor } from "./core/processor.js";
import { engineRegistry } from "./engines/adapters.js";
import { ModelService } from "./core/models.js";
import { ModelUsageService } from "./core/model-usage.js";
import { OrganizationBudgetService } from "./core/organization-budgets.js";
import { ModelSpendingService } from "./core/model-spending.js";
import { KnowledgeService } from "./core/knowledge.js";
import { CommunicationService } from "./core/communication.js";
import { AttachmentUploadService } from "./core/attachment-uploads.js";
import { AttachmentUploadInput, MAX_ATTACHMENT_BYTES } from "@hyper/contracts";
import { AttachmentSendService } from "./core/attachment-sends.js";
import { AttachmentSendInput } from "@hyper/contracts";
import { ReplyDraftService } from "./core/reply-drafts.js";
import { SourceFileService } from "./core/source-files.js";
import {
  FilePath,
  FileReadingInput,
  FileReadingRevision,
  FileReadingRevisionInput,
} from "@hyper/contracts";
import { FileReadingService } from "./core/file-readings.js";
import { FollowUpScheduleService } from "./core/follow-up-schedules.js";
import { ArtifactReviewService } from "./core/artifact-reviews.js";
import { MethodsService } from "./core/methods.js";
import { ExecutionPolicyService } from "./core/execution-policy.js";
import { TalkToken, TalkCursor } from "./providers/nextcloud-talk.js";
import { IdentityService } from "./core/identity.js";
import { nextcloudConfig } from "./providers/nextcloud.js";
const config = applicationConfig();
const db = new Database();
const service = new WorkspaceService(db, engineRegistry());
const queue = new RunProcessor(service);
const identity = new IdentityService(db);
const communication = new CommunicationService(db);
const followUpSchedules = new FollowUpScheduleService(service);
const sessionCookie = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: config.secureCookie,
  maxAge: 12 * 60 * 60 * 1000,
  path: "/",
};
const flowCookie = {
  ...sessionCookie,
  maxAge: 10 * 60 * 1000,
  path: "/api/auth/nextcloud",
};
function cookie(req: Request, name: string) {
  return req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1);
}
function loginOrigin(req: Request) {
  if (!process.env.APP_ORIGIN || req.headers.origin !== process.env.APP_ORIGIN)
    throw new ForbiddenException("请从工作区页面发起企业登录。");
}
const uuid = (v: string) => z.uuid().parse(v);
function token(req: Request) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const cookie = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("hyper_session="))
    ?.slice(14);
  return bearer ?? cookie;
}
const subject = (req: Request) => authenticate(db, token(req));
@Catch()
class ApiErrors implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (e instanceof ZodError)
      return res.status(400).json({
        message: "输入格式有误。",
        issues: e.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    if (e instanceof HttpException)
      return res.status(e.getStatus()).json({ message: e.message });
    console.error(
      "Unhandled API error:",
      e instanceof Error ? e.name : "unknown",
    );
    return res.status(500).json({ message: "服务暂时无法完成此操作。" });
  }
}
@Controller("api")
@UseFilters(ApiErrors)
class ApiController {
  @Post("calendar/availability") async calendarAvailability(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new CalendarService(db).availability(
      await subject(req),
      CalendarAvailabilityQuery.parse(body),
    );
  }
  @Get("calendar/runs") async calendarRunHistory(@Req() req: Request) {
    return new CalendarRunService(db).history(await subject(req));
  }
  @Post("calendar/runs") async calendarRun(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const run = await service.startCalendarRun(
      await subject(req),
      CalendarRunInput.parse(body),
    );
    await queue.enqueue(run.id);
    return run;
  }
  @Get("approvals/runs") async approvalRunHistory(@Req() req: Request) {
    return new ApprovalRunService(db).history(await subject(req));
  }
  @Post("approvals/runs") async startApprovalRun(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const run = await service.startApprovalRun(
      await subject(req),
      ApprovalRunInput.parse(body),
    );
    await queue.enqueue(run.id);
    return run;
  }
  @Get("approvals/flows") async approvalFlows(@Req() req: Request) {
    return new ApprovalService(db).flows(await subject(req));
  }
  @Post("approvals/flows") async publishApprovalFlow(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new ApprovalService(db).publish(await subject(req), body);
  }
  @Get("approvals/requests") async approvalRequests(@Req() req: Request) {
    return new ApprovalService(db).list(await subject(req));
  }
  @Get("approvals/reminders") async approvalReminders(@Req() req: Request) {
    return new ApprovalService(db).reminders(await subject(req));
  }
  @Post("approvals/requests") async openApprovalRequest(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new ApprovalService(db).open(await subject(req), body);
  }
  @Get("approvals/requests/:id") async approvalRequest(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new ApprovalService(db).detail(await subject(req), uuid(id));
  }
  @Post("approvals/requests/:id/actions") async approvalAction(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return new ApprovalService(db).action(await subject(req), uuid(id), body);
  }
  @Get("calendar/calendars") async calendars(@Req() req: Request) {
    return new CalendarService(db).calendars(await subject(req));
  }
  @Post("calendar/query") async calendarQuery(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new CalendarService(db).occurrences(
      await subject(req),
      CalendarQuery.parse(body),
    );
  }
  @Post("calendar/series-rule") async calendarSeriesRule(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new CalendarService(db).seriesRule(await subject(req), body);
  }
  @Post("calendar/links/query") async calendarLinks(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new CalendarService(db).links(await subject(req), body);
  }
  @Post("calendar/links/change") async changeCalendarLink(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new CalendarService(db).changeLink(await subject(req), body);
  }
  @Post("calendar/meeting") async calendarMeeting(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new CalendarService(db).meeting(await subject(req), body);
  }
  @Get("calendar/commands") async calendarCommands(@Req() req: Request) {
    return new CalendarService(db).history(await subject(req));
  }
  @Post("calendar/commands") async prepareCalendar(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new CalendarService(db).prepare(
      await subject(req),
      CalendarCommandInput.parse(body),
    );
  }
  @Get("calendar/commands/:id") async calendarCommand(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new CalendarService(db).get(await subject(req), uuid(id));
  }
  @Post("calendar/commands/:id/apply") async applyCalendar(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(body);
    return new CalendarService(db).apply(await subject(req), uuid(id));
  }
  @Post("calendar/commands/:id/reconcile") async reconcileCalendar(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    z.object({}).strict().parse(body);
    return new CalendarService(db).reconcile(await subject(req), uuid(id));
  }
  @Post("calendar/commands/:id/cancel") async cancelCalendar(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    z.object({}).strict().parse(body);
    return new CalendarService(db).cancel(await subject(req), uuid(id));
  }
  @Get("health") async health() {
    await db.pool.query("SELECT 1");
    return { status: "ok", service: "Hyper Workspace", version: "0.1.0" };
  }
  @Get("auth/status") status() {
    const nextcloudConfigured = !!nextcloudConfig();
    const filesEnabled =
      process.env.NEXTCLOUD_FILES_ENABLED === "true" && nextcloudConfigured;
    return {
      demoEnabled: process.env.DEMO_MODE === "true",
      nextcloudConfigured,
      filesEnabled,
      officeEnabled: filesEnabled && process.env.NEXTCLOUD_OFFICE_ENABLED === "true",
    };
  }
  @Post("auth/nextcloud/start") async startLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    loginOrigin(req);
    const { binding, ...flow } = await identity.start(
      cookie(req, "hyper_login"),
    );
    res.cookie("hyper_login", binding, flowCookie);
    return flow;
  }
  @Post("auth/nextcloud/poll") async pollLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    loginOrigin(req);
    const input = z.object({ flowId: z.uuid() }).strict().parse(body);
    const result = await identity.poll(
      input.flowId,
      cookie(req, "hyper_login"),
    );
    if (result.state === "complete")
      res.cookie("hyper_session", result.session, sessionCookie);
    return { state: result.state };
  }
  @Post("auth/nextcloud/cancel") async cancelLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    loginOrigin(req);
    const input = z.object({ flowId: z.uuid() }).strict().parse(body);
    const cancelledSession = await identity.cancel(
      input.flowId,
      cookie(req, "hyper_login"),
    );
    if (
      cancelledSession &&
      token(req) &&
      digest(token(req)!) === cancelledSession
    )
      res.clearCookie("hyper_session", { path: "/" });
    return { ok: true };
  }
  @Post("auth/demo") async demo(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (process.env.DEMO_MODE !== "true")
      throw new ForbiddenException("演示登录未开启。");
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress ?? "",
    );
    if (!loopback) throw new ForbiddenException("演示登录仅限本机访问。");
    const session = await issueSession(db, DEMO.user, DEMO.workspace, true);
    res.cookie("hyper_session", session, sessionCookie);
    return { ok: true, evidence: "fixture" };
  }
  @Post("auth/logout") async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const t = token(req);
    if (t)
      await db.tx(async (c) => {
        const session = (
          await c.query(
            "DELETE FROM cw_sessions WHERE token_hash=$1 RETURNING identity_credential_id",
            [digest(t)],
          )
        ).rows[0];
        if (session?.identity_credential_id)
          await c.query(
            "UPDATE cw_identity_credentials SET disabled_at=now(),credential_enc='' WHERE id=$1",
            [session.identity_credential_id],
          );
      });
    res.clearCookie("hyper_session", { path: "/" });
    return { ok: true };
  }
  @Get("workspace") async workspace(
    @Req() req: Request,
    @Query("projectId") pid?: string,
  ) {
    return service.view(await subject(req), pid ? uuid(pid) : undefined);
  }
  @Get("projects/:id/methods") async listMethods(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new MethodsService(db).list(await subject(req), uuid(id));
  }
  @Get("methods/:id") async getMethod(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new MethodsService(db).get(await subject(req), uuid(id));
  }
  @Post("projects/:id/methods/actions") async methodAction(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return new MethodsService(db).record(
      await subject(req),
      uuid(id),
      MethodActionInput.parse(body),
    );
  }
  @Post("projects") async project(@Req() req: Request, @Body() body: unknown) {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        goal: z.string().trim().min(1).max(1000),
      })
      .strict()
      .parse(body);
    return service.createProject(await subject(req), input.name, input.goal);
  }
  @Get("talk/rooms/:token/project") async talkProject(
    @Req() req: Request,
    @Param("token") token: string,
  ) {
    return {
      project: await service.talkProject(
        await subject(req),
        TalkToken.parse(token),
      ),
    };
  }
  @Post("projects/from-talk") async projectFromTalk(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        roomId: TalkToken,
        name: z.string().trim().min(1).max(100),
        goal: z.string().trim().min(1).max(1000),
      })
      .strict()
      .parse(body);
    return service.createTalkProject(
      await subject(req),
      input.roomId,
      input.name,
      input.goal,
    );
  }
  @Get("projects/:id/directory") async directory(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new DirectoryService(db).read(await subject(req), uuid(id));
  }
  @Post("tasks/:id/assignment") async assignTask(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const s = await subject(req),
      input = TaskAssignmentInput.parse(body);
    if (input.plan.taskId !== uuid(id))
      throw new BadRequestException("员工分配目标不匹配。");
    const task = await service.task(s, uuid(id));
    return new TaskAssignmentService(db).save(
      s,
      task.current.projectId,
      input.plan,
      input.idempotencyKey,
    );
  }
  @Get("projects/:id/work-briefs") async briefs(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new WorkBriefService(db).list(await subject(req), uuid(id));
  }
  @Get("projects/:id/work-briefs/:briefId") async brief(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("briefId") briefId: string,
  ) {
    return new WorkBriefService(db).get(
      await subject(req),
      uuid(id),
      uuid(briefId),
    );
  }
  @Post("projects/:id/work-briefs") async saveBrief(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = WorkBriefInput.parse(body);
    return new WorkBriefService(db).save(
      await subject(req),
      uuid(id),
      input.plan,
      input.draft,
      input.idempotencyKey,
    );
  }
  @Post("conversations/:id/messages") async message(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = NewMessage.parse(body);
    return service.message(await subject(req), uuid(id), input.content);
  }
  @Post("conversations/:id/tasks") async task(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return service.createTask(
      await subject(req),
      uuid(id),
      TaskInput.parse(body),
    );
  }
  @Get("conversations/:id/follow-ups") async scheduledFollowUps(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return followUpSchedules.list(await subject(req), uuid(id));
  }
  @Post("conversations/:id/follow-ups") async configureFollowUp(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return followUpSchedules.configure(
      await subject(req),
      uuid(id),
      FollowUpConfiguration.parse(body),
    );
  }
  @Get("tasks/:id") async getTask(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return service.task(await subject(req), uuid(id));
  }
  @Patch("tasks/:id") async patchTask(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return service.patchTask(
      await subject(req),
      uuid(id),
      TaskPatch.parse(body),
    );
  }
  @Get("artifacts/:id") async artifact(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return service.artifact(await subject(req), uuid(id));
  }
  @Post("artifacts/:id/reviews") async reviewArtifact(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return new ArtifactReviewService(db).record(
      await subject(req),
      uuid(id),
      ArtifactReviewInput.parse(body),
    );
  }
  @Post("artifacts/:id/revisions") async revise(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return service.revise(
      await subject(req),
      uuid(id),
      ArtifactRevision.parse(body),
    );
  }
  @Get("knowledge") async knowledge(@Req() req: Request, @Query("q") q = "") {
    return service.search(await subject(req), q.slice(0, 500));
  }
  @Get("talk/management") async roomManagement(
    @Req() req: Request,
    @Query("roomId") roomId?: string,
  ) {
    if (roomId !== undefined && !/^[a-z0-9]{4,30}$/.test(roomId))
      throw new BadRequestException("会话 ID 无效。");
    return new RoomManagementService(db).read(await subject(req), roomId);
  }
  @Get("talk/management/commands") async roomCommands(@Req() req: Request) {
    return new RoomManagementService(db).activity(await subject(req));
  }
  @Get("talk/rooms/:id/search") async searchTalk(
    @Req() req: Request,
    @Param("id") id: string,
    @Query("q") query: string,
    @Query("bindingRef") bindingRef: string,
    @Query("cursor") cursor?: string,
  ) {
    return new CommunicationSearchService(db).search(
      await subject(req),
      id,
      { query, ...(cursor === undefined ? {} : { cursor }) },
      bindingRef,
    );
  }
  @Post("talk/management/commands") async roomCommand(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = RoomManagementInput.parse(body);
    return new RoomManagementService(db).execute(
      await subject(req),
      input.plan,
      input.idempotencyKey,
    );
  }
  @Get("talk/management/commands/:id") async roomCommandReceipt(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new RoomManagementService(db).receipt(await subject(req), uuid(id));
  }
  @Post("talk/management/commands/:id/reconcile") async reconcileRoom(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new RoomManagementService(db).reconcile(
      await subject(req),
      uuid(id),
    );
  }
  @Post("talk/management/commands/:id/stop") async stopRoom(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new RoomManagementService(db).stop(await subject(req), uuid(id));
  }
  @Post("talk/management/commands/:id/acknowledge") async acknowledgeRoom(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(body);
    return new RoomManagementService(db).acknowledge(
      await subject(req),
      uuid(id),
    );
  }
  @Post("talk/management/runs") async startRoomRun(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const run = await service.startRoomManagementRun(
      await subject(req),
      RoomManagementRunInput.parse(body),
    );
    await queue.enqueue(run.id);
    return run;
  }
  @Post("files/imports/:id/readings") async readFile(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const r = await service.startFileRun(
      await subject(req),
      uuid(id),
      FileReadingInput.parse(body),
    );
    await queue.enqueue(r.id);
    return r;
  }
  @Get("files/imports/:id/readings") async fileReadings(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new FileReadingService(db).list(await subject(req), uuid(id));
  }
  @Get("files/readings/:id") async fileReading(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new FileReadingService(db).get(await subject(req), uuid(id));
  }
  @Patch("files/readings/:id") async reviseFileReading(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return new FileReadingService(db).revise(
      await subject(req),
      uuid(id),
      FileReadingRevision.parse(body),
    );
  }
  @Post("files/readings/:id/revisions") async aiReviseFileReading(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const r = await service.startFileReadingRevision(
      await subject(req),
      uuid(id),
      FileReadingRevisionInput.parse(body),
    );
    await queue.enqueue(r.id);
    return r;
  }
  @Post("ocr/lookup") async lookupOcr(@Req() req: Request, @Body() body: unknown) {
    return new OcrRunService(db).review(await subject(req), OcrSource.parse(body));
  }
  @Post("ocr/source-preview") async previewOcrSource(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    const result = await new OcrService(db).preview(await subject(req), OcrSource.parse(body));
    res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader("Content-Disposition", "inline");
    return res.status(200).type(result.mime).send(result.bytes);
  }
  @Post("ocr/runs") async startOcrRun(@Req() req: Request, @Body() body: unknown) {
    const run = await service.startOcrRun(await subject(req), OcrRunInput.parse(body));
    await queue.enqueue(run.id);
    return run;
  }
  @Post("ocr/recognitions") async recognizeOcr(@Req() req: Request, @Body() body: unknown) {
    return new OcrService(db).recognize(await subject(req), OcrRecognition.parse(body));
  }
  @Get("ocr/documents/:id") async getOcr(
    @Req() req: Request,
    @Param("id") id: string,
    @Query("revision") revision?: string,
  ) {
    return new OcrService(db).detail(await subject(req), uuid(id),
      revision === undefined ? undefined : z.coerce.number().int().min(1).max(2147483647).parse(revision));
  }
  @Post("ocr/documents/:id/confirm") async confirmOcr(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return new OcrService(db).confirm(await subject(req), uuid(id), OcrCorrection.parse(body));
  }
  @Post("files/list") async sourceFiles(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z.object({ path: FilePath }).strict().parse(body);
    return new SourceFileService(db).list(await subject(req), input.path);
  }
  @Post("files/office-link") async officeLink(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new SourceFileService(db).officeLink(await subject(req), OfficeSource.parse(body));
  }
  @Post("files/import") async importFile(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        path: FilePath,
        expectedId: z.string().regex(/^[1-9]\d{0,19}$/),
        expectedEtag: z.string().min(1).max(256),
      })
      .strict()
      .parse(body);
    return new SourceFileService(db).import(
      await subject(req),
      input.path,
      input.expectedId,
      input.expectedEtag,
    );
  }
  @Get("files/imports") async importedFiles(@Req() req: Request) {
    return new SourceFileService(db).imported(await subject(req));
  }
  @Get("files/imports/:id") async importedFile(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new SourceFileService(db).get(await subject(req), uuid(id));
  }
  @Post("files/imports/:id/refresh") async refreshFile(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    z.object({}).strict().parse(body);
    return new SourceFileService(db).refresh(await subject(req), uuid(id));
  }
  @Post("knowledge/source-access") async knowledgeSourceAccess(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z.object({ ids: z.array(z.uuid()).min(1).max(50) }).strict().parse(body);
    return { versions: Object.fromEntries(await verifyKnowledgeSources(db, await subject(req), input.ids)) };
  }
  @Post("knowledge/index") async indexKnowledge(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        assetIds: z.array(z.uuid()).min(1).max(20),
        modelProfileId: z.uuid().optional(),
      })
      .strict()
      .parse(body);
    return new KnowledgeService(db).index(
      await subject(req),
      input.assetIds,
      input.modelProfileId,
    );
  }
  @Post("knowledge/citation") async knowledgeCitation(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        assetId: z.uuid(),
        sourceVersion: z.string().min(1).max(512),
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      })
      .strict()
      .parse(body);
    return new KnowledgeContextService(db).citation(await subject(req), input);
  }
  @Post("knowledge/context") async knowledgeContext(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new KnowledgeContextService(db).context(
      await subject(req),
      KnowledgePlan.parse(body),
    );
  }
  @Post("knowledge/semantic") async semanticKnowledge(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        query: z.string().trim().min(1).max(500),
        modelProfileId: z.uuid().optional(),
      })
      .strict()
      .parse(body);
    return new KnowledgeService(db).semantic(
      await subject(req),
      input.query,
      input.modelProfileId,
    );
  }
  @Get("projects/:id/decisions") async decisions(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new DecisionService(db).list(await subject(req), uuid(id));
  }
  @Get("projects/:id/decision-sources") async decisionSources(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new DecisionService(db).sources(await subject(req), uuid(id));
  }
  @Post("projects/:id/decisions") async mutateDecision(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return new DecisionService(db).mutate(
      await subject(req),
      uuid(id),
      DecisionMutation.parse(body),
    );
  }
  @Get("decisions/:id") async decision(
    @Req() req: Request,
    @Param("id") id: string,
    @Query("beforeVersion") before?: string,
  ) {
    return new DecisionService(db).get(
      await subject(req),
      uuid(id),
      undefined,
      before ? z.coerce.number().int().positive().parse(before) : undefined,
    );
  }
  @Get("talk/rooms") async talkRooms(@Req() req: Request) {
    return communication.rooms(await subject(req));
  }
  @Post("talk/attachment-uploads") async prepareUpload(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new AttachmentUploadService(db).create(
      await subject(req),
      AttachmentUploadInput.parse(body),
    );
  }
  @Get("talk/rooms/:token/attachment-uploads") async uploadActivity(
    @Req() req: Request,
    @Param("token") token: string,
  ) {
    return new AttachmentUploadService(db).list(
      await subject(req),
      TalkToken.parse(token),
    );
  }
  @Get("talk/attachment-uploads/:id") async uploadReceipt(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new AttachmentUploadService(db).get(await subject(req), uuid(id));
  }
  @Put("talk/attachment-uploads/:id/content") async uploadContent(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: Buffer,
  ) {
    return new AttachmentUploadService(db).upload(
      await subject(req),
      uuid(id),
      body,
    );
  }
  @Post("talk/attachment-uploads/:id/reconcile") async reconcileUpload(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new AttachmentUploadService(db).reconcile(
      await subject(req),
      uuid(id),
    );
  }
  @Post("talk/attachment-uploads/:id/release") async releaseUpload(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new AttachmentUploadService(db).release(
      await subject(req),
      uuid(id),
    );
  }
  @Post("talk/rooms/:token/attachments") async sendAttachment(
    @Req() req: Request,
    @Param("token") token: string,
    @Body() body: unknown,
  ) {
    const input = AttachmentSendInput.parse(body);
    if (input.plan.roomId !== TalkToken.parse(token))
      throw new BadRequestException("附件目标会话不匹配。");
    return new AttachmentSendService(db).send(
      await subject(req),
      input.plan,
      input.idempotencyKey,
    );
  }
  @Get("talk/rooms/:token/attachment-sends") async pendingAttachments(
    @Req() req: Request,
    @Param("token") token: string,
  ) {
    return new AttachmentSendService(db).activity(
      await subject(req),
      TalkToken.parse(token),
    );
  }
  @Get("talk/attachment-sends/:id") async attachmentReceipt(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new AttachmentSendService(db).get(await subject(req), uuid(id));
  }
  @Post("talk/attachment-sends/:id/reconcile") async reconcileAttachment(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new AttachmentSendService(db).reconcile(
      await subject(req),
      uuid(id),
    );
  }
  @Post("talk/attachment-sends/:id/acknowledge") async acknowledgeAttachment(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new AttachmentSendService(db).acknowledge(
      await subject(req),
      uuid(id),
    );
  }
  @Get("talk/rooms/:token/drafts") async replyDrafts(
    @Req() req: Request,
    @Param("token") token: string,
  ) {
    return new ReplyDraftService(db).list(
      await subject(req),
      TalkToken.parse(token),
    );
  }
  @Get("talk/drafts/:id") async replyDraft(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new ReplyDraftService(db).get(await subject(req), uuid(id));
  }
  @Get("talk/rooms/:token/messages") async talkMessages(
    @Req() req: Request,
    @Param("token") token: string,
    @Query("before") before?: string,
  ) {
    return communication.messages(
      await subject(req),
      TalkToken.parse(token),
      before ? TalkCursor.parse(before) : undefined,
    );
  }
  @Get("talk/rooms/:token/messages/:messageId/attachments/:fileId/:action")
  async talkAttachment(
    @Req() req: Request,
    @Res() res: Response,
    @Param("token") token: string,
    @Param("messageId") messageId: string,
    @Param("fileId") fileId: string,
    @Param("action") action: string,
    @Query("etag") etag: string,
  ) {
    const mode = z.enum(["open", "download"]).parse(action);
    const result = await communication.attachment(
      await subject(req),
      TalkToken.parse(token),
      TalkCursor.parse(messageId),
      TalkFileId.parse(fileId),
      AttachmentEtag.parse(etag),
      mode === "download",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    if (mode === "open") return res.redirect(302, result.url);
    // Always download as an opaque attachment; never render active content on the product origin.
    const filename = encodeURIComponent(
      Buffer.from(result.attachment.name, "utf8").toString("utf8"),
    ).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=attachment; filename*=UTF-8''" + filename,
    );
    res.setHeader("Content-Length", result.bytes!.length);
    return res.end(result.bytes);
  }
  @Post("talk/rooms/:token/messages") async sendTalk(
    @Req() req: Request,
    @Param("token") token: string,
    @Body() body: unknown,
  ) {
    const input = CommunicationSendInput.parse(body);
    return communication.send(
      await subject(req),
      TalkToken.parse(token),
      input.content,
      input.idempotencyKey,
      input.draftId,
    );
  }
  @Get("talk/rooms/:token/sends") async pendingTalk(
    @Req() req: Request,
    @Param("token") token: string,
  ) {
    return communication.pending(await subject(req), TalkToken.parse(token));
  }
  @Post("talk/sends/:id/acknowledge") async acknowledgeTalk(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return communication.acknowledge(await subject(req), uuid(id));
  }
  @Get("talk/sends/:id") async talkReceipt(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return communication.receipt(await subject(req), uuid(id));
  }
  @Post("talk/sends/:id/reconcile") async reconcileTalk(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return communication.reconcile(await subject(req), uuid(id));
  }
  @Get("projects/:id/execution-policy") async executionPolicy(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new ExecutionPolicyService(db).view(await subject(req), uuid(id));
  }
  @Post("projects/:id/execution-policy") async saveExecutionPolicy(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { idempotencyKey, ...plan } = ExecutionPolicyInput.parse(body);
    return new ExecutionPolicyService(db).save(
      await subject(req),
      uuid(id),
      plan,
      idempotencyKey,
    );
  }
  @Get("projects/:id/notification-policy") async notificationPolicy(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new NotificationPolicyService(db).view(await subject(req), uuid(id));
  }
  @Post("projects/:id/notification-policy") async saveNotificationPolicy(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() raw: unknown,
  ) {
    const input = NotificationInput.parse(raw);
    return new NotificationPolicyService(db).save(
      await subject(req),
      uuid(id),
      input.plan,
      input.idempotencyKey,
    );
  }
  @Get("organization") async organization(
    @Req() req: Request,
    @Query("query") query = "",
    @Query("offset") offset = "0",
    @Query("departmentId") departmentId?: string,
  ) {
    return new OrganizationService(db).read(
      await subject(req),
      OrganizationQuery.parse({
        query,
        offset: Number(offset),
        ...(departmentId ? { departmentId } : {}),
      }),
    );
  }
  @Post("organization") async saveOrganization(
    @Req() req: Request,
    @Body() raw: unknown,
  ) {
    const input = z
      .object({ plan: OrganizationPlan, idempotencyKey: z.uuid() })
      .strict()
      .parse(raw);
    return new OrganizationService(db).save(
      await subject(req),
      input.plan,
      input.idempotencyKey,
    );
  }
  @Get("models") async models(@Req() req: Request) {
    return service.models(await subject(req));
  }
  @Get("model-usage") async modelUsage(@Req() req: Request) {
    return new ModelUsageService(db).view(await subject(req));
  }
  @Get("organization-budgets") async organizationBudgets(
    @Req() req: Request,
    @Query("projectId") projectId?: string,
    @Query("before") before?: string,
    @Query("pendingOnly") pendingOnly?: string,
    @Query("requestId") requestId?: string,
  ) {
    return new OrganizationBudgetService(db).view(
      await subject(req),
      projectId ? uuid(projectId) : null,
      {
        before: before ? uuid(before) : undefined,
        pendingOnly: pendingOnly === "true",
        requestId: requestId ? uuid(requestId) : undefined,
      },
    );
  }
  @Post("organization-budgets/price-lookup") async lookupBudgetPrice(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return new OrganizationBudgetService(db).lookup(await subject(req), body);
  }
  @Get("model-spending") async modelSpending(
    @Req() req: Request,
    @Query("modelProfileId") profileId?: string,
  ) {
    return new ModelSpendingService(db).view(
      await subject(req),
      profileId ? uuid(profileId) : undefined,
    );
  }
  @Post("model-spending") async saveModelSpending(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = ModelSpendingInput.parse(body);
    return new ModelSpendingService(db).save(
      await subject(req),
      input.plan,
      input.idempotencyKey,
    );
  }
  @Post("models") async saveModel(@Req() req: Request, @Body() body: unknown) {
    return service.saveModel(await subject(req), ModelInput.parse(body));
  }
  @Post("models/:id/verify") async verifyModel(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new ModelService(db).verify(await subject(req), uuid(id));
  }
  @Post("runs") async run(@Req() req: Request, @Body() body: unknown) {
    const r = await service.startRun(await subject(req), RunInput.parse(body));
    await queue.enqueue(r.id);
    return r;
  }
  @Get("projects/:id/runs") async recentRuns(
    @Req() req: Request,
    @Param("id") id: string,
    @Query("before") before?: string,
  ) {
    return service.recentRuns(
      await subject(req),
      uuid(id),
      before === undefined ? undefined : uuid(before),
    );
  }
  @Get("runs/:id") async runStatus(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return service.getRun(await subject(req), uuid(id));
  }
  @Post("runs/:id/cancel") async cancel(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return service.cancel(await subject(req), uuid(id));
  }
  @Get("projects/:id/work-plans") async workPlans(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new WorkPlanService(db).list(await subject(req), uuid(id));
  }
  @Get("runs/:id/plan") async workPlan(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new WorkPlanService(db).view(await subject(req), uuid(id));
  }
  @Post("runs/:id/plan/responses") async workPlanResponse(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const result = await new WorkPlanService(db).respond(
      await subject(req),
      uuid(id),
      WorkPlanResponse.parse(body),
    );
    if (result.state === "queued") await queue.enqueue(result.runId);
    return result;
  }
  @Patch("runs/:id/plan") async editWorkPlan(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        expectedRevision: z.number().int().positive(),
        proposal: WorkProposal,
        idempotencyKey: z.uuid(),
      })
      .strict()
      .parse(body);
    return new WorkPlanService(db).edit(await subject(req), uuid(id), input);
  }
  @Get("runs/:id/history") async history(
    @Req() req: Request,
    @Param("id") id: string,
    @Query("after") after = "0",
  ) {
    const since = Number(after);
    if (!Number.isSafeInteger(since) || since < 0)
      throw new BadRequestException("无效事件游标。");
    const records = await service.events(
      await subject(req),
      uuid(id),
      since,
      101,
    );
    const events = records.slice(0, 100);
    return {
      events,
      after: events.at(-1)?.sequence ?? since,
      hasMore: records.length > events.length,
    };
  }
  @Get("runs/:id/events") async events(
    @Req() req: Request,
    @Res() res: Response,
    @Param("id") id: string,
    @Query("after") after = "0",
  ) {
    const s = await subject(req);
    uuid(id);
    const since = Number(after);
    if (!Number.isSafeInteger(since) || since < 0)
      throw new BadRequestException("无效事件游标。");
    await service.getRun(s, id);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    let cursor = since,
      busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const event of await service.events(s, id, cursor)) {
          cursor = event.sequence;
          res.write(
            "id: " +
              cursor +
              "\nevent: run-event\ndata: " +
              JSON.stringify(event) +
              "\n\n",
          );
        }
        res.write(": heartbeat\n\n");
      } catch {
        res.end();
        clearInterval(timer);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), 700);
    req.on("close", () => clearInterval(timer));
    await tick();
  }
}
@Module({ controllers: [ApiController] })
class AppModule {}
const app = await NestFactory.create(AppModule, {
  logger: ["error", "warn", "log"],
});
app.use((req: Request, res: Response, next: NextFunction) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin &&
    req.headers.origin !== process.env.APP_ORIGIN
  ) {
    res.status(403).json({ message: "请求来源不被允许。" });
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "POST" || !/^\/api\/ocr\/documents\/[0-9a-f-]+\/confirm$/.test(req.path))
    return next();
  express.json({ limit: "1mb", inflate: false })(req, res, (error?: unknown) => {
    if (error) res.status(400).json({ message: "校对内容过大或请求不完整。" });
    else next();
  });
});
// Binary input is scoped to this one authenticated endpoint; JSON limits remain unchanged.
app.use(async (req: Request, res: Response, next: NextFunction) => {
  const match = /^\/api\/talk\/attachment-uploads\/([0-9a-f-]+)\/content$/.exec(
    req.path,
  );
  if (req.method !== "PUT" || !match) return next();
  try {
    const info = await new AttachmentUploadService(db).authorizeContent(
      await subject(req),
      uuid(match[1]!),
    );
    if (
      req.headers["content-type"] !== "application/octet-stream" ||
      req.headers["content-encoding"]
    )
      return res.status(415).json({ message: "上传需使用原始二进制文件。" });
    const length = req.headers["content-length"];
    if (length !== undefined && Number(length) !== info.size)
      return res.status(400).json({ message: "上传长度与确认记录不符。" });
    express.raw({
      type: "application/octet-stream",
      limit: MAX_ATTACHMENT_BYTES,
      inflate: false,
    })(req, res, (error?: unknown) => {
      if (error)
        res.status(413).json({ message: "上传内容超过限制或请求不完整。" });
      else next();
    });
  } catch (e) {
    res.status(e instanceof HttpException ? e.getStatus() : 400).json({
      message: e instanceof HttpException ? e.message : "上传请求无效。",
    });
  }
});
if (config.serveWeb) {
  const directory = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (!existsSync(directory + "/index.html"))
    throw new Error("Build the web application before enabling SERVE_WEB.");
  app.use(
    express.static(directory, {
      dotfiles: "deny",
      setHeaders(res, path) {
        res.setHeader(
          "Cache-Control",
          path.endsWith("/index.html")
            ? "no-store"
            : "public, max-age=31536000, immutable",
        );
      },
    }),
  );
}
await queue.start(false);
app.enableShutdownHooks();
await app.listen(config.port, config.host);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    void queue
      .stop()
      .then(() => app.close())
      .then(() => db.close())
      .then(() => process.exit(0));
  });
