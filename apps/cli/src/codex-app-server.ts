import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { isTestCommand, redactText, stableSessionId, uuidV7 } from "@zimlo/adapters";
import { EMPTY_CAPABILITIES, type Decision, type Session, type UnifiedEvent } from "@zimlo/protocol";
import { ActionBroker } from "./action-broker.js";
import { RuntimeHub } from "./runtime.js";

type JsonRecord = Record<string, unknown>;
type RequestId = string | number;

interface RpcMessage extends JsonRecord {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TurnWaiter {
  resolve: (value: JsonRecord) => void;
  reject: (error: Error) => void;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function riskForCommand(command: string): Decision["risk"] {
  if (/\b(?:rm\s+-rf|deploy|production|git\s+push|git\s+reset|drop\s+(?:table|database)|sudo)\b/iu.test(command)) return "high";
  if (/\b(?:write|edit|apply_patch|install|delete|remove)\b/iu.test(command)) return "medium";
  return "low";
}

function decisionFromUpstream(value: unknown, index: number, risk: Decision["risk"]): Decision | null {
  if (typeof value === "string") {
    switch (value) {
      case "accept":
        return {
          id: `upstream-${index}-accept`,
          label: "允许一次",
          scope: "once",
          value,
          risk,
          ...(risk === "high" ? { confirmationPhrase: "确认执行" } : {}),
        };
      case "acceptForSession":
        return {
          id: `upstream-${index}-session`,
          label: "本 Session 允许",
          scope: "session",
          value,
          risk: risk === "low" ? "medium" : risk,
          confirmationPhrase: "本次会话允许",
        };
      case "decline":
        return { id: `upstream-${index}-decline`, label: "拒绝", scope: "deny", value, risk: "low" };
      case "cancel":
        return { id: `upstream-${index}-cancel`, label: "取消任务", scope: "deny", value, risk: "low" };
      default:
        return null;
    }
  }
  const candidate = record(value);
  if (candidate.acceptWithExecpolicyAmendment) {
    return {
      id: `upstream-${index}-execpolicy`,
      label: "永久允许上游提出的精确命令规则",
      scope: "persistent",
      value,
      risk: "high",
      confirmationPhrase: "永久允许",
    };
  }
  if (candidate.applyNetworkPolicyAmendment) {
    return {
      id: `upstream-${index}-network-policy`,
      label: "永久应用上游提出的网络规则",
      scope: "persistent",
      value,
      risk: "high",
      confirmationPhrase: "永久允许",
    };
  }
  return null;
}

export function commandApprovalDecisions(params: JsonRecord): Decision[] {
  const command = stringValue(params.command) ?? JSON.stringify(params.commandActions ?? params.networkApprovalContext ?? "");
  const risk = riskForCommand(command);
  const supplied = Array.isArray(params.availableDecisions) ? params.availableDecisions : null;
  const upstream: unknown[] = supplied ?? ["accept", "acceptForSession", "decline", "cancel"];

  if (!supplied && params.proposedExecpolicyAmendment) {
    upstream.splice(2, 0, {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment },
    });
  }
  if (!supplied && Array.isArray(params.proposedNetworkPolicyAmendments)) {
    for (const amendment of params.proposedNetworkPolicyAmendments) {
      upstream.splice(2, 0, {
        applyNetworkPolicyAmendment: { network_policy_amendment: amendment },
      });
    }
  }
  return upstream.map((value, index) => decisionFromUpstream(value, index, risk)).filter((value): value is Decision => value !== null);
}

export function fileApprovalDecisions(): Decision[] {
  return ["accept", "acceptForSession", "decline", "cancel"]
    .map((value, index) => decisionFromUpstream(value, index, "medium"))
    .filter((value): value is Decision => value !== null);
}

function permissionApprovalDecisions(params: JsonRecord): Decision[] {
  const permissions = record(params.permissions);
  return [
    {
      id: "permissions-turn",
      label: "本轮允许所请求的权限",
      scope: "once",
      value: { permissions, scope: "turn" },
      risk: "medium",
    },
    {
      id: "permissions-session",
      label: "本 Session 允许所请求的权限",
      scope: "session",
      value: { permissions, scope: "session" },
      risk: "high",
      confirmationPhrase: "本次会话允许",
    },
    {
      id: "permissions-deny",
      label: "拒绝",
      scope: "deny",
      value: { permissions: {}, scope: "turn" },
      risk: "low",
    },
  ];
}

export class CodexAppServer {
  private readonly runtime: RuntimeHub;
  private readonly broker: ActionBroker;
  private session: Session;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private nextId = 1;
  private activeTurnId: string | null = null;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly completedTurns = new Map<string, JsonRecord>();
  private readonly serverActions = new Map<string, string>();
  private stderr = "";

  constructor(runtime: RuntimeHub, broker: ActionBroker, session: Session) {
    this.runtime = runtime;
    this.broker = broker;
    this.session = session;
  }

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd: this.session.cwd ?? undefined,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    child.once("exit", (code, signal) => this.handleExit(code, signal));
    child.once("error", (error) => this.handleExit(-1, error.message));

    await this.request("initialize", {
      clientInfo: { name: "zimlo", title: "Zimlo", version: "0.2.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  async inspectThread(): Promise<JsonRecord> {
    await this.start();
    const result = record(await this.request("thread/read", {
      threadId: this.session.providerSessionId,
      includeTurns: false,
    }));
    return record(result.thread);
  }

  async runTurn(text: string): Promise<JsonRecord> {
    const thread = await this.inspectThread();
    if (record(thread.status).type === "active") {
      throw new Error("Codex app-server 报告该 Session 仍处于活跃状态，Zimlo 不会并发恢复。" );
    }
    await this.request("thread/resume", {
      threadId: this.session.providerSessionId,
      ...(this.session.cwd ? { cwd: this.session.cwd } : {}),
    });
    const response = record(await this.request("turn/start", {
      threadId: this.session.providerSessionId,
      input: [{ type: "text", text }],
      ...(this.session.cwd ? { cwd: this.session.cwd } : {}),
    }));
    const turn = record(response.turn);
    const turnId = stringValue(turn.id);
    if (!turnId) throw new Error("Codex app-server 未返回 turn id。" );
    this.activeTurnId = turnId;
    return this.waitForTurn(turnId);
  }

  async runNewThread(text: string, onSession?: (sessionId: string) => void): Promise<{ session: Session; turn: JsonRecord }> {
    await this.start();
    const response = record(await this.request("thread/start", {
      model: null,
      modelProvider: null,
      profile: null,
      cwd: this.session.cwd,
      approvalPolicy: null,
      sandbox: null,
      config: null,
      baseInstructions: null,
      developerInstructions: null,
      compactPrompt: null,
      includeApplyPatchTool: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    }));
    const thread = record(response.thread);
    const threadId = stringValue(thread.id) ?? stringValue(response.threadId);
    if (!threadId) throw new Error("Codex app-server 未返回新 thread id。");

    const now = new Date().toISOString();
    this.session = this.runtime.upsertSession({
      ...this.session,
      id: stableSessionId("codex", threadId),
      providerSessionId: threadId,
      surface: "managed",
      title: text.replace(/\s+/gu, " ").trim().slice(0, 72) || "Codex 新任务",
      status: "running",
      lastActivityAt: now,
      createdAt: now,
      activePid: null,
      processStartedAt: now,
      correlationUncertain: false,
      capabilities: { ...EMPTY_CAPABILITIES, liveObserved: true, replyable: false, resumable: false },
    });
    this.runtime.ingestEvent({
      id: uuidV7(),
      sequence: 0,
      provider: "codex",
      sessionId: this.session.id,
      providerSessionId: threadId,
      kind: "user_instruction",
      source: "app_server",
      occurredAt: now,
      payload: { prompt: text, source: "zimlo" },
      provenance: "verified",
    });
    onSession?.(this.session.id);
    const turnResponse = record(await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      ...(this.session.cwd ? { cwd: this.session.cwd } : {}),
    }));
    const turn = record(turnResponse.turn);
    const turnId = stringValue(turn.id);
    if (!turnId) throw new Error("Codex app-server 未返回 turn id。");
    this.activeTurnId = turnId;
    return { session: this.session, turn: await this.waitForTurn(turnId) };
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    for (const actionId of this.serverActions.values()) this.broker.expire(actionId);
    this.serverActions.clear();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  private request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex app-server 请求超时：${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(String(id), { resolve, reject, timer });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: RpcMessage): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("Codex app-server 未运行。" );
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.handleNotification(message.method, record(message.params));
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.id));
    if (message.error) {
      const error = record(message.error);
      pending.reject(new Error(stringValue(error.message) ?? JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(method: string, params: JsonRecord): void {
    const threadId = stringValue(params.threadId);
    if (threadId && threadId !== this.session.providerSessionId) return;
    const turn = record(params.turn);
    const turnId = stringValue(params.turnId) ?? stringValue(turn.id) ?? this.activeTurnId;

    if (method === "turn/started") {
      if (turnId) this.activeTurnId = turnId;
      this.ingest("session_started", params, turnId);
      return;
    }
    if (method === "turn/plan/updated") {
      this.ingest("plan_updated", params, turnId);
      return;
    }
    if (method === "turn/diff/updated") {
      this.ingest("files_changed", params, turnId);
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      this.ingestItem(method, params, turnId);
      return;
    }
    if (method === "turn/completed") {
      const status = stringValue(turn.status);
      this.ingest(status === "completed" ? "completed" : "failed", params, turnId);
      if (turnId) {
        const waiter = this.turnWaiters.get(turnId);
        if (waiter) {
          this.turnWaiters.delete(turnId);
          waiter.resolve(turn);
        } else {
          this.completedTurns.set(turnId, turn);
        }
      }
      return;
    }
    if (method === "error" && this.activeTurnId) this.ingest("failed", params, this.activeTurnId);
    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (requestId !== undefined) {
        const key = String(requestId);
        const actionId = this.serverActions.get(key);
        if (actionId) this.broker.expire(actionId);
        this.serverActions.delete(key);
      }
    }
  }

  private ingestItem(method: string, params: JsonRecord, turnId: string | null): void {
    const item = record(params.item);
    const itemId = stringValue(item.id);
    const itemType = stringValue(item.type);
    if (itemType === "commandExecution") {
      const completed = method === "item/completed";
      this.ingest(completed ? "command_completed" : "command_started", item, turnId, itemId);
      const command = stringValue(item.command);
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      if (completed && command && exitCode !== null && isTestCommand(command)) {
        this.ingest(exitCode === 0 ? "tests_passed" : "tests_failed", item, turnId, itemId);
      }
    } else if (itemType === "fileChange") {
      this.ingest("files_changed", item, turnId, itemId);
    }
  }

  private ingest(kind: UnifiedEvent["kind"], payload: unknown, turnId: string | null, itemId: string | null = null): void {
    this.runtime.ingestEvent({
      id: uuidV7(),
      sequence: 0,
      provider: "codex",
      sessionId: this.session.id,
      providerSessionId: this.session.providerSessionId,
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
      kind,
      source: "app_server",
      occurredAt: new Date().toISOString(),
      payload,
      provenance: "verified",
    });
  }

  private async handleServerRequest(message: RpcMessage): Promise<void> {
    const id = message.id;
    if (id === undefined || !message.method) return;
    const params = record(message.params);
    if (stringValue(params.threadId) !== this.session.providerSessionId) {
      this.write({ id, error: { code: -32602, message: "Session mismatch" } });
      return;
    }
    try {
      if (message.method === "item/commandExecution/requestApproval") {
        await this.resolveApproval(id, params, commandApprovalDecisions(params), "命令执行审批", "decision");
      } else if (message.method === "item/fileChange/requestApproval") {
        await this.resolveApproval(id, params, fileApprovalDecisions(), "文件修改审批", "decision");
      } else if (message.method === "item/permissions/requestApproval") {
        await this.resolveApproval(id, params, permissionApprovalDecisions(params), "额外能力审批", "direct");
      } else if (message.method === "item/tool/requestUserInput") {
        await this.resolveInput(id, params);
      } else {
        this.write({ id, error: { code: -32601, message: `Zimlo 不支持服务端请求：${message.method}` } });
      }
    } catch (error) {
      this.write({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private async resolveApproval(
    id: RequestId,
    params: JsonRecord,
    decisions: Decision[],
    title: string,
    responseShape: "decision" | "direct",
  ): Promise<void> {
    const network = record(params.networkApprovalContext);
    const detail = stringValue(network.host)
      ? `网络访问：${String(network.protocol ?? "network")}://${network.host}${network.port ? `:${String(network.port)}` : ""}`
      : redactText(stringValue(params.command) ?? stringValue(params.reason) ?? JSON.stringify(params.permissions ?? params), 800);
    const pending = this.broker.create({
      sessionId: this.session.id,
      upstreamRequestId: String(id),
      kind: "approval",
      title,
      detail,
      availableDecisions: decisions,
    });
    this.serverActions.set(String(id), pending.action.actionId);
    this.runtime.ingestEvent({
      id: uuidV7(),
      sequence: 0,
      provider: "codex",
      sessionId: this.session.id,
      providerSessionId: this.session.providerSessionId,
      ...(stringValue(params.turnId) ? { turnId: stringValue(params.turnId)! } : {}),
      ...(stringValue(params.itemId) ? { itemId: stringValue(params.itemId)! } : {}),
      kind: "needs_approval",
      source: "app_server",
      occurredAt: new Date().toISOString(),
      payload: params,
      provenance: "verified",
    }, pending.action);
    const resolution = await pending.result;
    this.serverActions.delete(String(id));
    const fallback = decisions.find((decision) => decision.value === "cancel")
      ?? decisions.find((decision) => decision.scope === "deny");
    const value = resolution?.decision.value ?? fallback?.value ?? { permissions: {}, scope: "turn" };
    this.write({ id, result: responseShape === "decision" ? { decision: value } : value });
  }

  private async resolveInput(id: RequestId, params: JsonRecord): Promise<void> {
    const questions = Array.isArray(params.questions) ? params.questions.map(record) : [];
    const detail = questions.map((question) => {
      return [stringValue(question.header), stringValue(question.question)].filter(Boolean).join(": ");
    }).filter(Boolean).join("\n") || "Codex 正在等待输入。";
    const pending = this.broker.create({
      sessionId: this.session.id,
      upstreamRequestId: String(id),
      kind: "input",
      title: "Agent 正在等待输入",
      detail: redactText(detail, 800),
      availableDecisions: [{ id: "submit-input", label: "提交回复", scope: "input", value: {}, risk: "low" }],
      ...(typeof params.autoResolutionMs === "number" ? { timeoutMs: Math.min(params.autoResolutionMs, 8 * 60 * 1000) } : {}),
    });
    this.serverActions.set(String(id), pending.action.actionId);
    this.runtime.ingestEvent({
      id: uuidV7(),
      sequence: 0,
      provider: "codex",
      sessionId: this.session.id,
      providerSessionId: this.session.providerSessionId,
      ...(stringValue(params.turnId) ? { turnId: stringValue(params.turnId)! } : {}),
      ...(stringValue(params.itemId) ? { itemId: stringValue(params.itemId)! } : {}),
      kind: "needs_input",
      source: "app_server",
      occurredAt: new Date().toISOString(),
      payload: params,
      provenance: "verified",
    }, pending.action);
    const resolution = await pending.result;
    this.serverActions.delete(String(id));
    const answer = resolution?.input?.answer ?? "";
    const answers = Object.fromEntries(questions.map((question, index) => {
      const questionId = stringValue(question.id) ?? `question-${index + 1}`;
      return [questionId, { answers: [answer] }];
    }));
    this.write({ id, result: { answers } });
  }

  private waitForTurn(turnId: string): Promise<JsonRecord> {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }
    return new Promise<JsonRecord>((resolve, reject) => {
      this.turnWaiters.set(turnId, { resolve, reject });
    });
  }

  private handleExit(code: number | null, signal: string | null): void {
    const detail = this.stderr.trim() || `exit=${String(code)} signal=${String(signal)}`;
    const error = new Error(`Codex app-server 已退出：${detail}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) waiter.reject(error);
    this.turnWaiters.clear();
    for (const actionId of this.serverActions.values()) this.broker.expire(actionId);
    this.serverActions.clear();
  }
}
