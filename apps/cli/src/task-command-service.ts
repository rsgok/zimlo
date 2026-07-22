import { redactText, uuidV7 } from "@zimlo/adapters";
import type { Provider, TaskCommand } from "@zimlo/protocol";
import { ResumeService } from "./resume-service.js";
import { RuntimeHub } from "./runtime.js";

interface CreateCommandInput {
  deviceId: string;
  idempotencyKey: string;
  provider: Provider;
  workspaceId: string;
  text: string;
}

interface FollowUpCommandInput {
  deviceId: string;
  idempotencyKey: string;
  sessionId: string;
  text: string;
}

export class TaskCommandService {
  private readonly active = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly runtime: RuntimeHub,
    private readonly resume: ResumeService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.dispatchQueued(), 2_000);
    this.timer.unref();
    this.dispatchQueued();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  create(input: CreateCommandInput): TaskCommand {
    const workspace = this.runtime.workspaces().find((candidate) => candidate.id === input.workspaceId);
    const now = new Date().toISOString();
    const command: TaskCommand = {
      id: uuidV7(),
      idempotencyKey: `${input.deviceId}:${input.idempotencyKey}`,
      kind: "create",
      provider: input.provider,
      sessionId: null,
      workspaceId: input.workspaceId,
      cwd: workspace?.path ?? "",
      text: input.text.trim(),
      state: workspace ? "queued" : "failed",
      createdAt: now,
      updatedAt: now,
      ...(workspace ? {} : { error: "所选项目不在 Mac 的可信 workspace 列表中。" }),
    };
    const stored = this.runtime.store.insertTaskCommand(command).command;
    this.runtime.send({ type: "task.command.updated", command: stored });
    this.dispatchQueued();
    return stored;
  }

  followUp(input: FollowUpCommandInput): TaskCommand {
    const session = this.runtime.store.getSession(input.sessionId);
    const now = new Date().toISOString();
    const invalidReason = this.followUpInvalidReason(input.sessionId);
    const command: TaskCommand = {
      id: uuidV7(),
      idempotencyKey: `${input.deviceId}:${input.idempotencyKey}`,
      kind: "follow_up",
      provider: session?.provider ?? "codex",
      sessionId: session?.id ?? input.sessionId,
      workspaceId: null,
      cwd: session?.cwd ?? "",
      text: input.text.trim(),
      state: invalidReason ? "failed" : "queued",
      createdAt: now,
      updatedAt: now,
      ...(invalidReason ? { error: invalidReason } : {}),
    };
    const stored = this.runtime.store.insertTaskCommand(command).command;
    this.runtime.send({ type: "task.command.updated", command: stored });
    this.dispatchQueued();
    return stored;
  }

  retry(commandId: string): TaskCommand | null {
    const command = this.runtime.store.getTaskCommand(commandId);
    if (!command || command.state !== "failed") return command;
    const invalidReason = command.kind === "create"
      ? this.runtime.workspaces().some((workspace) => workspace.id === command.workspaceId)
        ? null
        : "所选项目已不在 Mac 的可信 workspace 列表中。"
      : this.followUpInvalidReason(command.sessionId);
    if (invalidReason) {
      return this.runtime.updateTaskCommand({
        ...command,
        updatedAt: new Date().toISOString(),
        error: invalidReason,
      });
    }
    const next = this.runtime.updateTaskCommand({
      ...command,
      state: "queued",
      updatedAt: new Date().toISOString(),
      error: undefined,
    });
    this.dispatchQueued();
    return next;
  }

  private dispatchQueued(): void {
    for (const command of this.runtime.store.listQueuedTaskCommands()) {
      if (this.active.has(command.id)) continue;
      if (command.kind === "follow_up") {
        const session = command.sessionId ? this.runtime.store.getSession(command.sessionId) : null;
        if (session && (session.activePid !== null || session.status === "running" || session.status === "waiting")) continue;
      }
      this.active.add(command.id);
      void this.dispatch(command).finally(() => this.active.delete(command.id));
    }
  }

  private async dispatch(command: TaskCommand): Promise<void> {
    let current = this.runtime.updateTaskCommand({
      ...command,
      state: "dispatching",
      updatedAt: new Date().toISOString(),
      error: undefined,
    });
    current = this.runtime.updateTaskCommand({ ...current, state: "running", updatedAt: new Date().toISOString() });
    try {
      const result: { ok: boolean; message: string; sessionId?: string } = command.kind === "create"
        ? await this.resume.createTask(command.provider, command.cwd, command.text, (sessionId) => {
            current = this.runtime.updateTaskCommand({
              ...current,
              sessionId,
              updatedAt: new Date().toISOString(),
            });
          })
        : await this.resume.sendMessage(command.sessionId!, command.text);
      this.runtime.updateTaskCommand({
        ...current,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        state: result.ok ? "completed" : "failed",
        updatedAt: new Date().toISOString(),
        ...(result.ok ? {} : { error: redactText(result.message, 800) }),
      });
    } catch (error) {
      this.runtime.updateTaskCommand({
        ...current,
        state: "failed",
        updatedAt: new Date().toISOString(),
        error: redactText(error instanceof Error ? error.message : String(error), 800),
      });
    }
  }

  private followUpInvalidReason(sessionId: string | null): string | null {
    const session = sessionId ? this.runtime.store.getSession(sessionId) : null;
    if (!session) return "找不到要继续的任务。";
    if (session.correlationUncertain || session.providerSessionId.startsWith("pending:")) {
      return "任务关联仍不确定，无法安全发送指令。";
    }
    if (!session.cwd) return "任务缺少工作目录，无法安全恢复。";
    return null;
  }
}
