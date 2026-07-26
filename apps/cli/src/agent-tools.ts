import { createConnection } from "node:net";
import { redactText, stableSessionId, uuidV7 } from "@zimlo/adapters";
import {
  EMPTY_CAPABILITIES,
  FeedPostInputSchema,
  FeedSkipInputSchema,
  SignalTransitionInputSchema,
  type FeedPost,
  type Provider,
  type Session,
} from "@zimlo/protocol";
import { detectHookSurface } from "./hook-surface.js";
import { RuntimeHub } from "./runtime.js";

export interface AgentToolRequest {
  type: "agent_tool";
  id: string;
  provider: Provider;
  parentPid: number;
  cwd: string;
  name: "feed.post" | "feed.skip" | "signal.transition";
  arguments: unknown;
}

export interface AgentToolResult {
  id: string;
  ok: boolean;
  message: string;
  data?: unknown;
}

const EDITORIAL_POLICY = `只在信息会改变用户判断、行动或信心时发布。每帖按“结论 → 用户影响 → 关键事实 → 证据 → 下一步”编辑；不要发布普通工具调用、文件读取、编译过程、原始日志、心跳或重复状态。`;

function toolDefinitions() {
  return [
    {
      name: "feed.post",
      description: `向 Zimlo 发布一条由你主动编辑、给人看的 Feed 帖子。平台不会替你 scrape 日志或生成摘要。${EDITORIAL_POLICY} 普通轮次没有值得说的内容时可以直接保持沉默；关键状态由 signal.transition 校验。`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "kind", "template", "headline", "takeaway", "highlights", "action_required", "actions", "dedupe_key"],
        properties: {
          task_id: { type: "string", minLength: 1, maxLength: 160, description: "本次任务的稳定标识；同一任务后续帖子保持一致。" },
          kind: { type: "string", enum: ["progress", "decision", "attention", "result", "failure"] },
          template: { type: "string", enum: ["paper", "grid", "sticky", "marker", "poster"], description: "选择有限的文字卡模板；不能传颜色、字体或 CSS。" },
          headline: { type: "string", minLength: 1, maxLength: 72, description: "直接表达已经发生的结果，禁止使用“阶段进展”等空标题。" },
          takeaway: { type: "string", minLength: 1, maxLength: 320, description: "用一到两句话解释为什么这件事值得用户现在读。" },
          highlights: { type: "array", maxItems: 3, items: { type: "string", minLength: 1, maxLength: 100 }, description: "最多三条可验证事实，每条只表达一件事。" },
          proof: { type: "string", minLength: 1, maxLength: 160, description: "可选的一项测试、检查或一手证据，不得粘贴原始日志。" },
          action_required: { type: "boolean" },
          action_prompt: { type: "string", minLength: 1, maxLength: 240, description: "仅在需要用户处理时提供，直接说明用户要决定或输入什么。" },
          actions: { type: "array", maxItems: 4, items: { type: "string", enum: ["approve", "reject", "reply", "open_diff"] } },
          dedupe_key: { type: "string", minLength: 1, maxLength: 240, description: "同一语义帖重试时保持不变，避免重复发布。" },
        },
      },
    },
    {
      name: "feed.skip",
      description: `显式记录当前受控检查点没有值得发布的新增信息。${EDITORIAL_POLICY} 这不是心跳帖，不会出现在 Timeline；普通聊天轮次无需为了结束而调用。`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "reason"],
        properties: {
          task_id: { type: "string", minLength: 1, maxLength: 160 },
          reason: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    {
      name: "signal.transition",
      description: "更新可靠的机器任务状态。它是 source of truth，和给人看的 Feed 分开。waiting_input、user_review、failed 等关键状态会校验本轮是否已有匹配的 feed.post。",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["task_id", "state", "reason"],
        properties: {
          task_id: { type: "string", minLength: 1, maxLength: 160 },
          state: { type: "string", enum: ["running", "waiting_input", "reviewing", "user_review", "failed", "completed"] },
          reason: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
  ];
}

export class AgentToolService {
  constructor(private readonly runtime: RuntimeHub) {}

  handle(request: AgentToolRequest): AgentToolResult {
    try {
      if (request.name === "feed.post") return this.post(request);
      if (request.name === "feed.skip") return this.skip(request);
      return this.transition(request);
    } catch (error) {
      return { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private post(request: AgentToolRequest): AgentToolResult {
    const parsed = FeedPostInputSchema.safeParse(request.arguments);
    if (!parsed.success) throw new Error(`feed.post 字段无效：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
    const input = parsed.data;
    const session = this.resolveSession(request, input.task_id);
    const now = new Date().toISOString();
    const post: FeedPost = {
      id: uuidV7(),
      projectId: session.projectId ?? null,
      taskId: input.task_id,
      runId: session.providerSessionId,
      agentId: request.provider,
      sessionId: session.id,
      kind: input.kind,
      template: input.template,
      headline: redactText(input.headline, 72),
      takeaway: redactText(input.takeaway, 320),
      highlights: input.highlights.map((highlight) => redactText(highlight, 100)),
      ...(input.proof ? { proof: redactText(input.proof, 160) } : {}),
      actionRequired: input.action_required,
      ...(input.action_prompt ? { actionPrompt: redactText(input.action_prompt, 240) } : {}),
      actions: input.actions,
      pendingActionIds: [],
      dedupeKey: input.dedupe_key,
      source: "agent" as const,
      createdAt: now,
    };
    const stored = this.runtime.postFeed(post);
    this.runtime.store.recordFeedDecision({
      agentId: request.provider,
      runId: session.providerSessionId,
      taskId: input.task_id,
      kind: "post",
      at: now,
      ref: stored.post.id,
    });
    return {
      id: request.id,
      ok: true,
      message: stored.inserted ? "Feed 已发布。" : "重复调用已去重，返回原帖。",
      data: { post_id: stored.post.id, created_at: stored.post.createdAt, deduplicated: !stored.inserted },
    };
  }

  private skip(request: AgentToolRequest): AgentToolResult {
    const parsed = FeedSkipInputSchema.safeParse(request.arguments);
    if (!parsed.success) throw new Error(`feed.skip 字段无效：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
    const session = this.resolveSession(request, parsed.data.task_id);
    const now = new Date().toISOString();
    this.runtime.store.recordFeedDecision({
      agentId: request.provider,
      runId: session.providerSessionId,
      taskId: parsed.data.task_id,
      kind: "skip",
      at: now,
      ref: redactText(parsed.data.reason, 500),
    });
    return { id: request.id, ok: true, message: "本轮已记录为不发帖，可以结束。" };
  }

  private transition(request: AgentToolRequest): AgentToolResult {
    const parsed = SignalTransitionInputSchema.safeParse(request.arguments);
    if (!parsed.success) throw new Error(`signal.transition 字段无效：${parsed.error.issues.map((issue) => issue.message).join("；")}`);
    const input = parsed.data;
    const session = this.resolveSession(request, input.task_id);
    const checkpoint = this.runtime.store.getFeedCheckpoint(request.provider, session.providerSessionId);
    const requiredKind = input.state === "waiting_input"
      ? "attention"
      : input.state === "user_review"
        ? "result"
        : input.state === "failed"
          ? "failure"
          : null;
    if (requiredKind) {
      const latest = this.runtime.store.latestFeedPost(request.provider, session.providerSessionId, checkpoint?.startedAt ?? "");
      if (!latest || latest.kind !== requiredKind) {
        throw new Error(`进入 ${input.state} 前必须先 feed.post(kind=${requiredKind})。`);
      }
    }
    if (input.state === "completed" && !checkpoint?.decisionKind) {
      throw new Error("任务完成前必须先调用 feed.post 或 feed.skip。");
    }
    const task = this.runtime.updateTask({
      id: input.task_id,
      runId: session.providerSessionId,
      agentId: request.provider,
      sessionId: session.id,
      state: input.state,
      reason: redactText(input.reason, 500),
      updatedAt: new Date().toISOString(),
    });
    return { id: request.id, ok: true, message: `任务状态已更新为 ${task.state}。`, data: task };
  }

  private resolveSession(request: AgentToolRequest, taskId: string): Session {
    const found = this.runtime.store.findSessionForAgentTool(request.provider, request.parentPid, request.cwd, taskId);
    if (found) {
      if (found.surface !== "unknown") return found;
      const detectedSurface = detectHookSurface(request.parentPid);
      return detectedSurface === "unknown" ? found : this.runtime.upsertSession({ ...found, surface: detectedSurface });
    }
    const providerSessionId = `tool:${taskId}`;
    const sessionId = stableSessionId(request.provider, providerSessionId);
    return this.runtime.upsertSession({
      id: sessionId,
      provider: request.provider,
      surface: detectHookSurface(request.parentPid),
      providerSessionId,
      title: `${request.provider === "codex" ? "Codex" : "Claude"} · ${taskId}`,
      cwd: request.cwd || null,
      transcriptPath: null,
      status: "running",
      lastActivityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      activePid: request.parentPid > 0 ? request.parentPid : null,
      processStartedAt: null,
      tty: null,
      correlationUncertain: true,
      capabilities: { ...EMPTY_CAPABILITIES, liveObserved: true },
    });
  }
}

async function callBridge(socketPath: string, request: AgentToolRequest): Promise<AgentToolResult> {
  return new Promise<AgentToolResult>((resolve) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ id: request.id, ok: false, message: "Zimlo Bridge 未响应；请先运行 zimlo start。" });
    }, 5_000);
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as AgentToolResult);
      } catch {
        resolve({ id: request.id, ok: false, message: "Zimlo Bridge 返回了无效响应。" });
      }
      socket.end();
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve({ id: request.id, ok: false, message: "无法连接 Zimlo Bridge；请先运行 zimlo start。" });
    });
  });
}

export async function runMcpServer(provider: Provider, socketPath: string): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  const respond = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const handle = async (message: Record<string, unknown>) => {
    const id = message.id;
    const method = String(message.method ?? "");
    if (id === undefined) return;
    if (method === "initialize") {
      respond({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "zimlo", version: "0.2.0" } } });
      return;
    }
    if (method === "ping") {
      respond({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      respond({ jsonrpc: "2.0", id, result: { tools: toolDefinitions() } });
      return;
    }
    if (method === "tools/call") {
      const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {};
      const name = String(params.name ?? "") as AgentToolRequest["name"];
      if (!(["feed.post", "feed.skip", "signal.transition"] as string[]).includes(name)) {
        respond({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "未知的 Zimlo 工具。" }] } });
        return;
      }
      const result = await callBridge(socketPath, {
        type: "agent_tool",
        id: uuidV7(),
        provider,
        parentPid: process.ppid,
        cwd: process.cwd(),
        name,
        arguments: params.arguments ?? {},
      });
      respond({
        jsonrpc: "2.0",
        id,
        result: {
          isError: !result.ok,
          content: [{ type: "text", text: JSON.stringify({ ok: result.ok, message: result.message, data: result.data ?? null }) }],
        },
      });
      return;
    }
    respond({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  };
  for await (const chunk of process.stdin) {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        await handle(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        process.stderr.write(`Zimlo MCP error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
}
