import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseClaudeLine, redactText, uuidV7, type ParserState } from "@zimlo/adapters";
import type { Session, UnifiedEvent } from "@zimlo/protocol";
import { ActionBroker } from "./action-broker.js";
import { CodexAppServer } from "./codex-app-server.js";
import { RuntimeHub } from "./runtime.js";

export class ResumeService {
  private readonly runtime: RuntimeHub;
  private readonly broker: ActionBroker;
  private readonly leases = new Set<string>();

  constructor(runtime: RuntimeHub, broker: ActionBroker) {
    this.runtime = runtime;
    this.broker = broker;
  }

  async sendMessage(sessionId: string, text: string): Promise<{ ok: boolean; message: string }> {
    const session = this.runtime.store.getSession(sessionId);
    if (!session) return { ok: false, message: "找不到 Session。" };
    if (session.activePid !== null) return { ok: false, message: "该 Session 正在其他终端运行，Zimlo 不会注入 TTY。" };
    if (this.leases.has(sessionId)) return { ok: false, message: "该 Session 已有一个 Zimlo turn 正在运行。" };
    if (!session.cwd) return { ok: false, message: "缺少工作目录，无法安全恢复 Session。" };

    this.leases.add(sessionId);
    try {
      return session.provider === "codex"
        ? await this.runCodex(session, text)
        : await this.runClaude(session, text);
    } catch (error) {
      this.finishSession(session, false);
      return { ok: false, message: redactText(error instanceof Error ? error.message : String(error), 800) };
    } finally {
      this.leases.delete(sessionId);
    }
  }

  private async runCodex(session: Session, text: string): Promise<{ ok: boolean; message: string }> {
    const appServer = new CodexAppServer(this.runtime, this.broker, session);
    this.beginSession(session, null);
    try {
      const turn = await appServer.runTurn(text);
      const ok = turn.status === "completed";
      this.finishSession(session, ok);
      if (ok) return { ok: true, message: "消息已通过 Codex app-server 发送，本轮执行已完成。" };
      const error = turn.error && typeof turn.error === "object" ? turn.error as Record<string, unknown> : {};
      return { ok: false, message: typeof error.message === "string" ? error.message : `Codex turn 状态：${String(turn.status)}` };
    } finally {
      await appServer.close();
    }
  }

  private async runClaude(session: Session, text: string): Promise<{ ok: boolean; message: string }> {
    const args = ["-p", text, "--resume", session.providerSessionId, "--output-format", "stream-json", "--verbose", "--include-hook-events"];
    const child = spawn("claude", args, { cwd: session.cwd!, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const parser: ParserState = { provider: "claude", providerSessionId: session.providerSessionId, toolCalls: new Map() };
    this.beginSession(session, child.pid ?? null);

    const stderr: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.ingestClaudeLine(session, parser, line));

    const code = await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(-1));
      child.once("exit", resolve);
    });
    const ok = code === 0;
    this.finishSession(session, ok);
    if (ok) return { ok: true, message: "消息已发送，任务已完成本轮执行。" };
    return { ok: false, message: redactText(stderr.join("").trim(), 800) || `Agent 退出码：${String(code)}` };
  }

  private beginSession(session: Session, pid: number | null): void {
    this.runtime.upsertSession({
      ...session,
      status: "running",
      activePid: pid,
      processStartedAt: new Date().toISOString(),
      capabilities: { ...session.capabilities, liveObserved: true, replyable: false, resumable: false },
    });
  }

  private finishSession(original: Session, ok: boolean): void {
    const latest = this.runtime.store.getSession(original.id) ?? original;
    this.runtime.upsertSession({
      ...latest,
      status: ok ? "idle" : "failed",
      activePid: null,
      processStartedAt: null,
      tty: null,
      lastActivityAt: new Date().toISOString(),
      capabilities: { ...latest.capabilities, liveObserved: false, replyable: true, resumable: true },
    });
  }

  private ingestClaudeLine(session: Session, parser: ParserState, line: string): void {
    const parsed = parseClaudeLine(line, parser);
    for (const draft of parsed.events) {
      const event: UnifiedEvent = {
        id: uuidV7(),
        sequence: 0,
        provider: "claude",
        sessionId: session.id,
        providerSessionId: session.providerSessionId,
        ...(draft.turnId ? { turnId: draft.turnId } : {}),
        ...(draft.itemId ? { itemId: draft.itemId } : {}),
        kind: draft.kind,
        source: "managed_runner",
        occurredAt: draft.occurredAt,
        payload: draft.payload,
        provenance: draft.provenance,
      };
      this.runtime.ingestEvent(event);
    }
  }
}
