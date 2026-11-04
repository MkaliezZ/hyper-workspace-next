import type {
  EngineAdapter,
  EngineRequest,
  EngineResult,
  EngineId,
} from "@hyper/contracts";
import { toolsForWorkflow } from "@hyper/contracts";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsonRpcProcess, runtimeCommand } from "./rpc.js";
import { z } from "zod";
const resultSchema = z.object({
  text: z.string().min(1),
  actions: z
    .array(
      z.object({
        tool: z.enum([
          "artifact.create",
          "artifact.revise",
          "artifact.review",
          "task.create",
          "task.update",
          "method.write",
          "method.manage",
          "project.report",
          "follow_up.check",
          "follow_up.configure",
          "policy.configure",
          "notifications.manage",
          "usage.report",
          "spending.manage",
          "brief.write",
          "brief.manage",
          "task.assign",
          "directory.read",
          "organization.manage",
          "communication.manage",
          "calendar.manage",
          "attachment.share",
          "decision.write",
          "decision.manage",
          "knowledge.answer",
          "work.plan",
          "communication.draft",
          "file.reading.save",
        ]),
        args: z.record(z.string(), z.unknown()),
      }),
    )
    .max(30),
});
const instruction =
  'Return ONLY JSON: {"text":"brief result","actions":[{"tool":"artifact.create|artifact.revise|artifact.review|task.create|task.update|method.write|method.manage|project.report|follow_up.check|follow_up.configure|communication.draft|file.reading.save|policy.configure|notifications.manage|usage.report|spending.manage|brief.write|brief.manage|task.assign|directory.read|attachment.share|decision.write|decision.manage|knowledge.answer|work.plan|organization.manage|communication.manage|calendar.manage","args":{}}]}. Do not claim an action already happened. The host validates and executes it. Use empty args for exactly one artifact.review when given a Host-bound artifact review decision; the employee has chosen the decision and the host enforces it. Never claim the model verified artifact quality. For a Host-bound task revision propose only changed title, assignee, dueDate or status fields in task.update; the host fixes the task and version. Never claim actual work completion was independently verified or a person notified. Use title/content for artifact.create; artifactId/content for artifact.revise. For task.create use {title:string,assignee:string,dueDate:string|null}. Put an explicit source deadline in dueDate as YYYY-MM-DD, not only in the title. Preserve the source year and exact date; use null when no deadline is known and never invent one. assignee is a source label or UID, not a verified employee assignment; never choose assigneeId here. Verified identity assignment is a separate host-confirmed operation. New tasks are open records, not proof that work was completed. Use empty args for exactly one follow_up.configure when given a Host-bound follow-up plan; settings are fixed by the employee and enforced by the host. Use empty args for exactly one follow_up.check; only the host compares current project tasks and decides whether to post one factual project message. Use only content for communication.draft (max 20000 characters); it saves a personal draft for review, never sends a message. Use only content for file.reading.save (max 20000 characters); it saves one personal file reading bound by the host to the selected file and version. Never choose a file, recipient or room. Never invent project facts. For Host-bound method draft, use exactly one method.write {title,kind,content}; it creates only a candidate. For Host-bound method management, use exactly one method.manage with empty args, preserving the confirmed employee operation. Published methods are reusable guidance, never authorization or policy. For a Host-bound execution policy plan, use exactly one policy.configure with empty args. The host applies only the employee-confirmed rules. Never choose policy values or permissions. For a Host-bound personal model usage query, use exactly one usage.report with empty args; no actors, periods or prices. For a Host-bound model spending plan, use exactly one spending.manage with empty args. Never choose targets, prices, currencies, amounts, budgets or claim provider-verified invoices. For a Host-bound work brief draft use exactly one brief.write with title, goal, scope, constraints, completionCriteria and questions (array of clarification strings). Never fill employee answers or confirm a draft. For a Host-bound work brief operation use exactly one brief.manage with empty args. For a Host-bound task assignment use exactly one task.assign with empty args; the employee chose the identity, not a name guess. Never claim notification, account creation or permission grants. For a Host-bound project directory query use exactly one directory.read with empty args. For a Host-bound attachment share use exactly one attachment.share with empty args; the employee fixed the room, file and caption. Only the host may send and reconcile; never claim delivery before a real receipt. For a Host-bound decision draft use exactly one decision.write with title, content, rationale and optional links (kind task|artifact, id and exact version from supplied context only). It saves a proposed decision, never confirms it. For a Host-bound decision operation use exactly one decision.manage with empty args. Never select another target or version, invent employee confirmation, or turn a suggestion into an adopted decision. For a Host-bound knowledge question use exactly one knowledge.answer {content:string}; answer only from the selected excerpts, cite exact supplied asset references in brackets, state partial coverage and uncertainty. Never invent citations, read other assets or claim full-document review. For Host-bound work planning, use exactly one work.plan with summary, questions and operations per the supplied context schema. It saves only a proposal; never claim work was executed, choose identity IDs or resolve ambiguous names. For a Host-bound organization operation use exactly one organization.manage with empty args. Never choose roles, departments, identities or grant source permissions. For a Host-bound communication operation use exactly one communication.manage with empty args. The host fixes the confirmed source target and settings, enforces permissions and records actual effects. Never choose members, recipients, roles, message positions or notification settings. For a Host-bound notification policy operation use exactly one notifications.manage with empty args. The host fixes the operation, scope, rules and revision. Never choose actors, preferences, importance judgments or publication recipients. For a Host-bound private calendar operation use exactly one calendar.manage with empty args. The host binds the selected calendar, time window or immutable prepared command, enforces current permissions, stop and version checks, and records actual source results. Never select actors, targets, times, recipients or claim a source write or invitation occurred before its verified receipt. No native shell or business tools are needed.';
function parseResult(text: string): EngineResult {
  const clean = text
    .trim()
    .replace(/^\x60\x60\x60(?:json)?\s*/, "")
    .replace(/\s*\x60\x60\x60$/, "");
  return { ...resultSchema.parse(JSON.parse(clean)), evidence: "runtime" };
}
function installedDshCommand(): string[] | undefined {
  const directory = new URL("../../../../runtime/dsh/", import.meta.url);
  return existsSync(
    new URL("node_modules/@deepseek-ai/dsh/package.json", directory),
  )
    ? [process.execPath, fileURLToPath(new URL("launch.mjs", directory))]
    : undefined;
}
function installedHermesCommand(): string[] | undefined {
  const root = new URL("../../../../", import.meta.url);
  const receiptFile = new URL(".runtime/hermes-install.json", root);
  if (!existsSync(receiptFile)) return;
  try {
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    const lock = JSON.parse(
      readFileSync(new URL("runtime/hermes/lock.json", root), "utf8"),
    );
    if (
      receipt.commit !== lock.commit ||
      receipt.archiveSha256 !== lock.archiveSha256 ||
      typeof receipt.python !== "string"
    )
      return;
    const python = new URL(receipt.python, root);
    if (
      !python.pathname.startsWith(new URL(".runtime/", root).pathname) ||
      !existsSync(python)
    )
      return;
    return [
      fileURLToPath(python),
      fileURLToPath(new URL("runtime/hermes/launch.py", root)),
    ];
  } catch {
    return;
  }
}
export class FixtureAdapter implements EngineAdapter {
  readonly id = "fixture" as const;
  describeCapabilities() {
    return {
      configured: process.env.DEMO_MODE === "true",
      operations: [
        "discussion_to_minutes",
        "project_report",
        "revise_artifact",
        "revise_task",
        "manage_method",
        "review_artifact",
        "follow_up",
        "configure_follow_up",
        "configure_policy",
        "manage_notifications",
        "usage_report",
        "manage_spending",
        "manage_brief",
        "assign_task",
        "directory_report",
        "manage_organization",
        "manage_communication",
        "manage_calendar",
        "share_attachment",
        "manage_decision",
        "query_knowledge",
        "plan_work",
        "chat",
      ],
      evidence: "deterministic-fixture",
    };
  }
  async execute(r: EngineRequest): Promise<EngineResult> {
    if (!r.subject.demo || process.env.DEMO_MODE !== "true")
      throw new Error(
        "Fixture execution is only available in an explicitly enabled demo session.",
      );
    r.signal.throwIfAborted();
    await r.onProgress("正在演示资料上验证业务流程；此步骤未调用真实模型。");
    const heading =
      r.workflow === "project_report" ? "项目进展周报" : "讨论纪要";
    if (r.workflow === "follow_up")
      return {
        text: "演示检查已完成。实际任务状态请查看待办列表；没有调用真实模型。",
        actions: [{ tool: "follow_up.check", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "query_knowledge") {
      const reference = r.context.match(/"reference":"(asset:[^"]+)"/)?.[1];
      return {
        text: "演示资料回答，未调用真实模型。",
        evidence: "fixture",
        actions: [
          {
            tool: "knowledge.answer",
            args: {
              content: "合成片段回答，仅供流程验证：[" + reference + "]",
            },
          },
        ],
      };
    }
    if (r.workflow === "plan_work")
      return {
        text: "演示工作计划，未调用真实模型。",
        evidence: "fixture",
        actions: [
          {
            tool: "work.plan",
            args: {
              summary: "演示：先确认范围再形成待办与成果。",
              questions: ["请说明这项工作的交付对象。"],
              operations: [
                {
                  operation: "create_task",
                  title: "演示：核对交付要求",
                  assignee: { name: "我" },
                  dueDate: null,
                },
                {
                  operation: "create_artifact",
                  title: "演示：工作方案",
                  content:
                    "这是可修改的演示方案，尚未进行业务执行或真实质量验收。",
                },
              ],
            },
          },
        ],
      };
    if (r.workflow === "manage_decision")
      return {
        text: "演示决定操作，未调用模型。",
        evidence: "fixture",
        actions: [
          r.context.includes("Host-bound decision draft.")
            ? {
                tool: "decision.write",
                args: {
                  title: "演示提议",
                  content: r.instruction.slice(0, 8000),
                  rationale: "明确演示资料，待员工确认。",
                  links: [],
                },
              }
            : { tool: "decision.manage", args: {} },
        ],
      };
    if (r.workflow === "manage_spending")
      return {
        text: "演示费用代保存，未调用模型。",
        actions: [{ tool: "spending.manage", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "usage_report")
      return {
        text: "演示用量回读，未调用模型。",
        actions: [{ tool: "usage.report", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "manage_notifications")
      return {
        text: "Synthetic notification settings fixture",
        evidence: "fixture",
        actions: [{ tool: "notifications.manage", args: {} }],
      };
    if (r.workflow === "configure_policy")
      return {
        text: "演示执行规则配置，未调用模型。",
        actions: [{ tool: "policy.configure", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "configure_follow_up")
      return {
        text: "演示跟进配置。",
        actions: [{ tool: "follow_up.configure", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "review_artifact")
      return {
        text: "演示验收代执行。",
        actions: [{ tool: "artifact.review", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "manage_method")
      return {
        text: "演示方法操作，未调用模型。",
        evidence: "fixture",
        actions: r.context.includes("Host-bound method draft.")
          ? [
              {
                tool: "method.write",
                args: {
                  title: "演示方法候选",
                  kind: "sop",
                  content:
                    "演示候选方法，尚未验证。先检查目标，再核对证据，最后保存结果。",
                },
              },
            ]
          : [{ tool: "method.manage", args: {} }],
      };
    if (r.workflow === "share_attachment")
      return {
        text: "演示附件流程，未调用模型。",
        actions: [{ tool: "attachment.share", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "manage_communication")
      return {
        text: "Synthetic communication fixture",
        actions: [{ tool: "communication.manage", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "manage_calendar")
      return {
        text: "Synthetic calendar fixture",
        actions: [{ tool: "calendar.manage", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "manage_organization")
      return {
        text: "Synthetic organization fixture",
        actions: [{ tool: "organization.manage", args: {} }],
        evidence: "fixture",
      };
    if (r.workflow === "assign_task" || r.workflow === "directory_report")
      return {
        text: "演示成员流程，未调用模型。",
        actions: [
          {
            tool:
              r.workflow === "assign_task" ? "task.assign" : "directory.read",
            args: {},
          },
        ],
        evidence: "fixture",
      };
    if (r.workflow === "manage_brief")
      return {
        text: "演示任务说明，未调用模型。",
        evidence: "fixture",
        actions: [
          r.context.includes("Host-bound work brief draft.")
            ? {
                tool: "brief.write",
                args: {
                  title: "演示任务说明",
                  goal: r.instruction,
                  scope: "当前项目的已获准工作",
                  constraints: "不扩展授权范围",
                  completionCriteria: "交付可修改的成果并保留实际回执",
                  questions: ["这次成果具体交付给谁使用？"],
                },
              }
            : { tool: "brief.manage", args: {} },
        ],
      };
    if (r.workflow === "revise_task")
      return {
        text: "演示待办修改，未调用模型。",
        actions: [{ tool: "task.update", args: { title: "演示修改后的待办" } }],
        evidence: "fixture",
      };
    if (r.workflow === "chat")
      return {
        text: "已保存这条讨论。你可以通过“发起任务”生成纪要、周报或修改成果。当前为演示模式，未调用真实模型。",
        actions: [],
        evidence: "fixture",
      };
    if (r.workflow === "revise_artifact")
      return {
        text: "已根据反馈准备演示修订内容。",
        actions: [
          {
            tool: "artifact.revise",
            args: { content: r.context + "\n\n## 本次反馈\n" + r.instruction },
          },
        ],
        evidence: "fixture",
      };
    return {
      text: "已根据演示上下文准备" + heading + "，可查看和继续修改。",
      actions: [
        {
          tool: "artifact.create",
          args: {
            title: "产品共创 · " + heading,
            content:
              "# " +
              heading +
              "\n\n" +
              r.context +
              "\n\n## 本次要求\n" +
              r.instruction +
              "\n\n> 此成果由确定性演示流程生成，未调用真实模型。",
          },
        },
      ],
      evidence: "fixture",
    };
  }
}
export class DshAdapter implements EngineAdapter {
  readonly id = "dsh" as const;
  constructor(
    private command = runtimeCommand(process.env.DSH_COMMAND) ??
      installedDshCommand(),
    private route = {
      provider: process.env.DSH_PROVIDER ?? "hyper-model",
      model: process.env.DSH_MODEL ?? "",
    },
  ) {}
  describeCapabilities() {
    return {
      configured: !!this.command,
      operations: [
        "discussion_to_minutes",
        "project_report",
        "revise_artifact",
        "revise_task",
        "manage_method",
        "review_artifact",
        "follow_up",
        "chat",
        "draft_reply",
        "configure_follow_up",
        "configure_policy",
        "manage_notifications",
        "usage_report",
        "manage_spending",
        "manage_brief",
        "assign_task",
        "directory_report",
        "manage_organization",
        "manage_communication",
        "manage_calendar",
        "share_attachment",
        "manage_decision",
        "query_knowledge",
        "plan_work",
        "read_file",
        "revise_file_reading",
      ],
      evidence: this.command ? "configured-unverified" : "not-configured",
    };
  }
  async execute(r: EngineRequest): Promise<EngineResult> {
    r.signal.throwIfAborted();
    if (!this.command)
      throw new Error(
        "DSH 尚未安装。请安装 runtime/dsh 依赖，或设置经过验证的 DSH_COMMAND。",
      );
    const model = r.model?.model ?? this.route.model;
    if (!model) throw new Error("本次执行缺少模型配置。");
    const rpc = new JsonRpcProcess(this.command, r.workdir, {
      DSH_HOME: r.workdir,
      HYPER_MODEL_PROVIDER: r.model?.provider,
      HYPER_MODEL_ENDPOINT: r.model?.endpoint,
      HYPER_MODEL_NAME: model,
      HYPER_MODEL_API_KEY: r.model?.apiKey,
      HYPER_MODEL_MAX_TOKENS: String(r.limits?.maxOutputTokens ?? 4096),
      HYPER_RUN_SECONDS: String(r.limits?.maxDurationSeconds ?? 180),
      DSH_SYSTEM_PROMPT:
        r.policy +
        "\n" +
        instruction +
        "\nAllowed actions: " +
        toolsForWorkflow(r.workflow).join(","),
    });
    const abort = () => {
      void rpc.close().catch(() => {});
    };
    r.signal.addEventListener("abort", abort, { once: true });
    rpc.onRequest = async (method) => {
      if (method === "approval/request") return { outcome: "rejected" };
      throw new Error("Runtime native tool is not authorized.");
    };
    let text = "";
    let terminalReason = "";
    rpc.onNotification = (method, p) => {
      if (method !== "session.event" || p?.sessionId !== r.runId) return;
      if (p.event?.type === "turn/end")
        terminalReason = p.event.data?.reason?.kind ?? "";
      const content =
        p.event?.type === "assistant/message"
          ? p.event.data?.message?.content
          : undefined;
      if (Array.isArray(content))
        text = content
          .filter((x: any) => x.type === "text")
          .map((x: any) => x.text ?? "")
          .join("");
    };
    try {
      await rpc.request("initialize", {
        cwd: r.workdir,
        provider: this.route.provider,
        model,
        maxTokens: r.limits?.maxOutputTokens ?? 4096,
      });
      const sessionId = r.runId;
      await rpc.request("session/prompt", {
        sessionId,
        contentBlocks: [
          {
            type: "text",
            text:
              r.policy +
              "\n" +
              instruction +
              "\nContext:\n" +
              r.context +
              "\nTask:\n" +
              r.instruction,
          },
        ],
      });
      await rpc.request("session/wait", { sessionId });
      r.signal.throwIfAborted();
      if (terminalReason !== "completed")
        throw new Error("DSH turn did not complete successfully.");
      if (!text)
        throw new Error(
          "DSH returned no supported structured output. Verify the pinned protocol version.",
        );
      return parseResult(text);
    } finally {
      r.signal.removeEventListener("abort", abort);
      await rpc.close();
    }
  }
}
export class HermesAdapter implements EngineAdapter {
  readonly id = "hermes" as const;
  constructor(
    private command = runtimeCommand(process.env.HERMES_COMMAND) ??
      installedHermesCommand(),
  ) {}
  describeCapabilities() {
    return {
      configured: !!this.command,
      modelProviders: ["openai-compatible", "deepseek"],
      operations: [
        "discussion_to_minutes",
        "project_report",
        "revise_artifact",
        "revise_task",
        "manage_method",
        "review_artifact",
        "follow_up",
        "chat",
        "draft_reply",
        "configure_follow_up",
        "configure_policy",
        "manage_notifications",
        "usage_report",
        "manage_spending",
        "manage_brief",
        "assign_task",
        "directory_report",
        "manage_organization",
        "manage_communication",
        "manage_calendar",
        "share_attachment",
        "manage_decision",
        "query_knowledge",
        "plan_work",
        "read_file",
        "revise_file_reading",
      ],
      evidence: this.command ? "configured-unverified" : "not-configured",
    };
  }
  async execute(r: EngineRequest): Promise<EngineResult> {
    r.signal.throwIfAborted();
    if (!this.command)
      throw new Error(
        "Hermes 尚未安装。请运行 runtime/hermes/install.py，或设置经过验证的 HERMES_COMMAND。",
      );
    const rpc = new JsonRpcProcess(this.command, r.workdir, {
      HERMES_HOME: r.workdir,
      HYPER_MODEL_PROVIDER: r.model?.provider,
      HYPER_MODEL_ENDPOINT: r.model?.endpoint,
      HYPER_MODEL_NAME: r.model?.model,
      HYPER_MODEL_API_KEY: r.model?.apiKey,
      HYPER_MODEL_MAX_TOKENS: String(r.limits?.maxOutputTokens ?? 4096),
      HYPER_RUN_SECONDS: String(r.limits?.maxDurationSeconds ?? 180),
      HYPER_MODEL_POLICY:
        r.policy +
        "\n" +
        instruction +
        "\nAllowed actions: " +
        toolsForWorkflow(r.workflow).join(","),
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
    });
    const abort = () => {
      void rpc.close().catch(() => {});
    };
    r.signal.addEventListener("abort", abort, { once: true });
    rpc.onRequest = async (method) => {
      if (method === "approval") return { choice: "deny" };
      throw new Error("Native runtime request is not authorized.");
    };
    try {
      const ready = rpc.waitForNotification(
        "event",
        (p) => p?.type === "gateway.ready",
        r.signal,
        20000,
      );
      rpc.start();
      await ready;
      await rpc.request("client.capabilities", { server_requests: true });
      const session = await rpc.request("session.create", {
        cwd: r.workdir,
        cwd_explicit: true,
        close_on_disconnect: true,
        idempotency_key: r.runId,
        ...(r.model ? { model: r.model.model, provider: "custom:hyper" } : {}),
      });
      const sessionId = session.session_id ?? session.id;
      if (!sessionId)
        throw new Error("Hermes session protocol did not return an ID.");
      const completed = rpc.waitForNotification(
        "event",
        (p) => p?.type === "message.complete" && p?.session_id === sessionId,
        r.signal,
      );
      // Attach a handler immediately, even if prompt admission fails before awaiting completion.
      void completed.catch(() => {});
      const result = await rpc.request("prompt.submit", {
        session_id: sessionId,
        text:
          r.policy +
          "\n" +
          instruction +
          "\nContext:\n" +
          r.context +
          "\nTask:\n" +
          r.instruction,
      });
      if (result.status !== "streaming")
        throw new Error("Hermes did not admit a fresh isolated turn.");
      const final = (await completed).payload;
      if (final?.status !== "complete" || final?.error || final?.partial)
        throw new Error("Hermes turn did not complete successfully.");
      const text = final.text;
      r.signal.throwIfAborted();
      if (!text)
        throw new Error(
          "Hermes returned no supported final output. Verify the pinned protocol version.",
        );
      return parseResult(text);
    } finally {
      r.signal.removeEventListener("abort", abort);
      await rpc.close();
    }
  }
}
export function engineRegistry(): Map<EngineId, EngineAdapter> {
  return new Map<EngineId, EngineAdapter>([
    ["dsh", new DshAdapter()],
    ["hermes", new HermesAdapter()],
    ["fixture", new FixtureAdapter()],
  ]);
}
