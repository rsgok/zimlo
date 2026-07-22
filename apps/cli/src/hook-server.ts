import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  findExitCode,
  isTestCommand,
  readCommand,
  redactText,
  stableSessionId,
  uuidV7,
} from "@zimlo/adapters";
import { EMPTY_CAPABILITIES, type Decision, type Provider, type Session, type UnifiedEvent } from "@zimlo/protocol";
import { ActionBroker, type DecisionResolution } from "./action-broker.js";
import { AgentToolService, type AgentToolRequest, type AgentToolResult } from "./agent-tools.js";
import { RuntimeHub } from "./runtime.js";

interface HookRequest {
  type?: "hook";
  id: string;
  provider: Provider;
  payload: Record<string, unknown>;
}

interface HookResponse {
  id: string;
  output: unknown | null;
}

interface BridgeInfoRequest {
  type: "bridge_info";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const TRUSTED_ZIMLO_TOOLS = new Set([
  "mcp__zimlo__feed_post",
  "mcp__zimlo__feed_skip",
  "mcp__zimlo__signal_transition",
]);

export function isTrustedZimloPermission(payload: Record<string, unknown>): boolean {
  return payload.hook_event_name === "PermissionRequest"
    && typeof payload.tool_name === "string"
    && TRUSTED_ZIMLO_TOOLS.has(payload.tool_name);
}

export function actionDetailFor(payload: Record<string, unknown>): string {
  const input = record(payload.tool_input);
  if (payload.tool_name === "AskUserQuestion" && Array.isArray(input.questions)) {
    const questions = input.questions.map((question) => {
      const value = record(question);
      return [value.header, value.question].filter((part) => typeof part === "string").join(": ");
    }).filter(Boolean);
    if (questions.length > 0) return redactText(questions.join("\n"), 800);
  }
  const lines: string[] = [];
  const reason = input.description ?? input.reason ?? payload.reason ?? payload.message;
  if (typeof reason === "string" && reason.trim()) lines.push(`目的：${reason.trim()}`);
  if (typeof input.command === "string" && input.command.trim()) lines.push(`命令：${input.command.trim()}`);
  if (typeof input.file_path === "string" && input.file_path.trim()) lines.push(`文件：${input.file_path.trim()}`);
  if (typeof input.headline === "string" && input.headline.trim()) lines.push(`内容：${input.headline.trim()}`);
  if (typeof input.state === "string" && input.state.trim()) lines.push(`目标状态：${input.state.trim()}`);
  if (typeof payload.tool_name === "string" && !["Bash", "AskUserQuestion"].includes(payload.tool_name)) {
    lines.push(`工具：${payload.tool_name}`);
  }
  if (lines.length === 0) {
    const value = Object.keys(input).length > 0 ? input : payload.tool_name;
    lines.push(typeof value === "string" ? value : JSON.stringify(value));
  }
  return redactText(lines.join("\n"), 800);
}

export function approvalTitleFor(payload: Record<string, unknown>): string {
  const tool = String(payload.tool_name ?? "");
  if (tool === "Bash") return "批准执行命令";
  if (/^(?:Edit|Write|apply_patch)$/u.test(tool)) return "批准修改文件";
  if (tool) return `批准使用 ${tool.replace(/^mcp__/u, "")}`;
  return "批准受保护操作";
}

function riskFor(payload: Record<string, unknown>): Decision["risk"] {
  const detail = actionDetailFor(payload);
  if (/\b(?:rm\s+-rf|deploy|production|git\s+push|git\s+reset|drop\s+(?:table|database)|sudo)\b/iu.test(detail)) return "high";
  if (/\b(?:write|edit|apply_patch|install|delete|remove)\b/iu.test(detail)) return "medium";
  return "low";
}

function decisionsFor(provider: Provider, payload: Record<string, unknown>): Decision[] {
  const risk = riskFor(payload);
  const confirm = risk === "high" ? "确认执行" : undefined;
  const base: Decision[] = [
    {
      id: "allow-once",
      label: "允许一次",
      scope: "once",
      value: { behavior: "allow" },
      risk,
      ...(confirm ? { confirmationPhrase: confirm } : {}),
    },
    { id: "deny", label: "拒绝", scope: "deny", value: { behavior: "deny" }, risk: "low" },
  ];
  if (provider !== "claude") return base;
  const suggestions = Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : [];
  suggestions.forEach((suggestion, index) => {
    const value = record(suggestion);
    const destination = value.destination;
    const scope: Decision["scope"] = destination === "session" ? "session" : "persistent";
    base.splice(base.length - 1, 0, {
      id: `upstream-${index}`,
      label: scope === "session" ? "本 Session 允许" : "永久允许此规则",
      scope,
      value: { behavior: "allow", updatedPermissions: [suggestion] },
      risk: scope === "persistent" ? "high" : "medium",
      confirmationPhrase: scope === "persistent" ? "永久允许" : "本次会话允许",
    });
  });
  return base;
}

function eventKind(payload: Record<string, unknown>): UnifiedEvent["kind"] | null {
  const hook = String(payload.hook_event_name ?? "");
  const tool = String(payload.tool_name ?? "");
  if (hook === "SessionStart") return "session_started";
  if (hook === "SessionEnd") return "session_ended";
  if (hook === "PermissionRequest") return "needs_approval";
  if (hook === "Stop") return "completed";
  if (hook === "PostToolUseFailure") return "failed";
  if (hook === "PreToolUse" && tool === "AskUserQuestion") return "needs_input";
  if (hook === "PreToolUse" && tool === "Bash") return "command_started";
  if (hook === "PreToolUse" && /Edit|Write|apply_patch/u.test(tool)) return "files_changed";
  if (hook === "PostToolUse" && tool === "Bash") {
    const command = readCommand(record(payload.tool_input));
    const exitCode = findExitCode(payload.tool_response);
    if (command && isTestCommand(command) && exitCode !== null) return exitCode === 0 ? "tests_passed" : "tests_failed";
    return "command_completed";
  }
  if (hook === "PostToolUse" && /Edit|Write|apply_patch/u.test(tool)) return "files_changed";
  return null;
}

const LEGACY_FEED_DECISION_REASON = "本轮尚未做 Feed 编辑决策。请调用 Zimlo 的 feed.post 发布值得说的内容，或调用 feed.skip 明确保持沉默，然后再结束。";

export function finalizeStopFeedDecision(runtime: RuntimeHub, provider: Provider, runId: string): void {
  const checkpoint = runtime.store.getFeedCheckpoint(provider, runId);
  if (checkpoint?.decisionKind) return;
  const now = new Date().toISOString();
  runtime.store.recordFeedDecision({
    agentId: provider,
    runId,
    taskId: checkpoint?.taskId ?? `run:${runId}`,
    kind: "implicit_skip",
    at: now,
    ref: "stop:implicit",
  });
}

export function ingestUserInstruction(
  runtime: RuntimeHub,
  provider: Provider,
  session: Session,
  prompt: string,
  turnId?: string,
): UnifiedEvent {
  return runtime.ingestEvent({
    id: uuidV7(),
    sequence: 0,
    provider,
    sessionId: session.id,
    providerSessionId: session.providerSessionId,
    ...(turnId ? { turnId } : {}),
    kind: "user_instruction",
    source: "hook",
    occurredAt: new Date().toISOString(),
    payload: { prompt: redactText(prompt.trim(), 4_000) },
    provenance: "verified",
  });
}

export class HookServer {
  private readonly runtime: RuntimeHub;
  private readonly broker: ActionBroker;
  private readonly socketPath: string;
  private readonly agentTools: AgentToolService;
  private server: Server | null = null;

  constructor(runtime: RuntimeHub, broker: ActionBroker, socketPath: string, agentTools: AgentToolService) {
    this.runtime = runtime;
    this.broker = broker;
    this.socketPath = socketPath;
    this.agentTools = agentTools;
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await unlink(this.socketPath).catch(() => undefined);
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    await chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await unlink(this.socketPath).catch(() => undefined);
  }

  private handleSocket(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let responseStarted = false;
    const cancellation = new AbortController();
    socket.once("close", () => {
      if (!responseStarted) cancellation.abort();
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(line) as HookRequest | AgentToolRequest | BridgeInfoRequest;
      if (request.type === "bridge_info") {
        responseStarted = true;
        socket.end(`${JSON.stringify({ type: "bridge_info", version: "0.2.0", protocolVersion: 2 })}\n`);
        return;
      }
      if (request.type === "agent_tool") {
        const response: AgentToolResult = this.agentTools.handle(request);
        responseStarted = true;
        socket.end(`${JSON.stringify(response)}\n`);
        return;
      }
      void this.handleRequest(request, cancellation.signal).then((response) => {
        if (cancellation.signal.aborted || socket.destroyed) return;
        responseStarted = true;
        socket.end(`${JSON.stringify(response)}\n`);
      }).catch(() => {
        if (cancellation.signal.aborted || socket.destroyed) return;
        responseStarted = true;
        socket.end(`${JSON.stringify({ id: "unknown", output: null })}\n`);
      });
    });
  }

  private async handleRequest(request: HookRequest, cancellation?: AbortSignal): Promise<HookResponse> {
    const payload = request.payload;
    const providerSessionId = String(payload.session_id ?? payload.thread_id ?? `hook-${request.id}`);
    const sessionId = stableSessionId(request.provider, providerSessionId);
    const existing = this.runtime.store.getSession(sessionId);
    const hookName = String(payload.hook_event_name ?? "");
    const isApproval = hookName === "PermissionRequest";
    const isInput = hookName === "PreToolUse" && payload.tool_name === "AskUserQuestion";
    const trustedZimloPermission = request.provider === "codex" && isTrustedZimloPermission(payload);
    const session: Session = {
      id: sessionId,
      provider: request.provider,
      providerSessionId,
      title: existing?.title ?? `${request.provider === "codex" ? "Codex" : "Claude"} · ${providerSessionId.slice(0, 8)}`,
      cwd: typeof payload.cwd === "string" ? payload.cwd : (existing?.cwd ?? null),
      transcriptPath: typeof payload.transcript_path === "string" ? payload.transcript_path : (existing?.transcriptPath ?? null),
      status: (isApproval && !trustedZimloPermission) || isInput ? "waiting" : (existing?.status ?? "running"),
      lastActivityAt: new Date().toISOString(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      activePid: existing?.activePid ?? null,
      processStartedAt: existing?.processStartedAt ?? null,
      tty: existing?.tty ?? null,
      correlationUncertain: false,
      capabilities: {
        ...(existing?.capabilities ?? EMPTY_CAPABILITIES),
        liveObserved: true,
        approvableOnce: true,
        approvableSession: request.provider === "claude" && Array.isArray(payload.permission_suggestions),
        approvablePersistent: request.provider === "claude" && Array.isArray(payload.permission_suggestions),
      },
    };
    this.runtime.upsertSession(session);

    if (trustedZimloPermission) {
      return {
        id: request.id,
        output: {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        },
      };
    }

    if (hookName === "SessionStart" || hookName === "UserPromptSubmit") {
      this.runtime.store.beginFeedCheckpoint({
        agentId: request.provider,
        runId: session.providerSessionId,
        taskId: `run:${session.providerSessionId}`,
        sessionId: session.id,
        startedAt: new Date().toISOString(),
      });
    }

    if (hookName === "UserPromptSubmit") {
      const prompt = payload.prompt ?? payload.message;
      if (typeof prompt === "string" && prompt.trim() && prompt.trim() !== LEGACY_FEED_DECISION_REASON) {
        ingestUserInstruction(this.runtime, request.provider, session, prompt, typeof payload.turn_id === "string" ? payload.turn_id : undefined);
      }
      return { id: request.id, output: null };
    }

    if (hookName === "Stop") {
      finalizeStopFeedDecision(this.runtime, request.provider, session.providerSessionId);
    }

    const kind = eventKind(payload);
    if (!kind) return { id: request.id, output: null };

    if (isApproval || isInput) {
      const availableDecisions: Decision[] = isInput
        ? [{ id: "submit-input", label: "提交回复", scope: "input", value: {}, risk: "low" }]
        : decisionsFor(request.provider, payload);
      const pending = this.broker.create({
        sessionId,
        upstreamRequestId: String(payload.tool_use_id ?? request.id),
        kind: isInput ? "input" : "approval",
        title: isInput ? "Agent 正在等待输入" : approvalTitleFor(payload),
        detail: actionDetailFor(payload),
        availableDecisions,
      });
      const expireOnCancellation = () => this.broker.expire(pending.action.actionId);
      cancellation?.addEventListener("abort", expireOnCancellation, { once: true });
      if (cancellation?.aborted) expireOnCancellation();
      this.ingestHookEvent(request, session, kind, pending.action);
      try {
        const resolution = await pending.result;
        return { id: request.id, output: this.formatDecision(request.provider, payload, resolution) };
      } finally {
        cancellation?.removeEventListener("abort", expireOnCancellation);
      }
    }

    this.ingestHookEvent(request, session, kind);
    return { id: request.id, output: null };
  }

  private ingestHookEvent(
    request: HookRequest,
    session: Session,
    kind: UnifiedEvent["kind"],
    action?: ReturnType<ActionBroker["create"]>["action"],
  ): void {
    this.runtime.ingestEvent({
      id: uuidV7(),
      sequence: 0,
      provider: request.provider,
      sessionId: session.id,
      providerSessionId: session.providerSessionId,
      ...(typeof request.payload.turn_id === "string" ? { turnId: request.payload.turn_id } : {}),
      ...(typeof request.payload.tool_use_id === "string" ? { itemId: request.payload.tool_use_id } : {}),
      kind,
      source: "hook",
      occurredAt: new Date().toISOString(),
      payload: request.payload,
      provenance: "verified",
    }, action);
  }

  private formatDecision(provider: Provider, payload: Record<string, unknown>, resolution: DecisionResolution | null): unknown | null {
    if (!resolution) return null;
    const hookEventName = String(payload.hook_event_name ?? "PermissionRequest");
    if (hookEventName === "PreToolUse" && payload.tool_name === "AskUserQuestion") {
      const toolInput = record(payload.tool_input);
      const answer = resolution.input?.answer;
      const answers = answer && Array.isArray(toolInput.questions)
        ? Object.fromEntries(toolInput.questions.map((question, index) => {
          const value = record(question);
          const key = typeof value.question === "string" ? value.question : `question-${index + 1}`;
          return [key, answer];
        }))
        : (resolution.input ?? {});
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...toolInput, answers },
        },
      };
    }
    const value = record(resolution.decision.value);
    if (value.behavior === "deny") {
      value.message = "Denied from Zimlo";
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: value,
      },
      ...(provider === "codex" ? {} : {}),
    };
  }
}

export async function runHookClient(provider: Provider, socketPath: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const request: HookRequest = { type: "hook", id: uuidV7(), provider, payload };
  const response = await new Promise<HookResponse | null>((resolve) => {
    const socket = createConnection(socketPath);
    let responseBuffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, hookClientTimeoutMs(payload));
    timer.unref();
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      responseBuffer += chunk;
      const newline = responseBuffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(responseBuffer.slice(0, newline)) as HookResponse);
      } catch {
        resolve(null);
      }
      socket.end();
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  if (response?.output !== null && response?.output !== undefined) {
    process.stdout.write(`${JSON.stringify(response.output)}\n`);
  }
}

export function hookClientTimeoutMs(payload: Record<string, unknown>): number {
  const event = String(payload.hook_event_name ?? "");
  const waitsForHuman = event === "PermissionRequest"
    || (event === "PreToolUse" && payload.tool_name === "AskUserQuestion");
  return waitsForHuman ? 481_000 : 2_500;
}
