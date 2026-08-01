import { redactText, uuidV7 } from "@zimlo/adapters";
import { isCommandCancelable, type Material, type Provider, type TaskCommand } from "@zimlo/protocol";
import { ResumeService } from "./resume-service.js";
import { RuntimeHub } from "./runtime.js";

interface CreateCommandInput {
  deviceId: string;
  idempotencyKey: string;
  provider: Provider;
  workspaceId: string;
  text: string;
  materialIds?: string[];
}

interface FollowUpCommandInput {
  deviceId: string;
  idempotencyKey: string;
  sessionId: string;
  text: string;
  materialIds?: string[];
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
      materialIds: input.materialIds ?? [],
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
      materialIds: input.materialIds ?? [],
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

  // task.command.cancel：按 commandId 或设备作用域的 idempotencyKey 定位；
  // 仅 queued 可取消（protocol 的 isCommandCancelable），已取消的重复取消
  // 幂等返回当前状态，不报错也不二次执行。
  cancel(input: { deviceId: string; commandId?: string; idempotencyKey?: string }):
    | { ok: true; command: TaskCommand }
    | { ok: false; code: "task_command_not_found" | "command_not_cancelable"; command: TaskCommand | null } {
    const command = input.commandId
      ? this.runtime.store.getTaskCommand(input.commandId)
      : this.runtime.store.getTaskCommandByIdempotencyKey(`${input.deviceId}:${input.idempotencyKey ?? ""}`);
    if (!command) return { ok: false, code: "task_command_not_found", command: null };
    if (command.state === "canceled") return { ok: true, command };
    if (!isCommandCancelable(command.state)) return { ok: false, code: "command_not_cancelable", command };
    const updated = this.runtime.updateTaskCommand({
      ...command,
      state: "canceled",
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, command: updated };
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
      const materials = await this.waitForMaterials(command.materialIds ?? []);
      if (materials.some((value) => value === null)) throw new Error("有物料尚未上传完成，请在物料卡片中重试。");
      const totalBytes = materials.reduce((sum, value) => sum + (value?.material.sizeBytes ?? 0), 0);
      if (materials.length > 10 || totalBytes > 80 * 1024 * 1024) throw new Error("单个任务最多 10 个物料，总大小不能超过 80MB。");
      const result: { ok: boolean; message: string; sessionId?: string } = command.kind === "create"
        ? await this.resume.createTask(command.provider, command.cwd, command.text, (sessionId) => {
            current = this.runtime.updateTaskCommand({
              ...current,
              sessionId,
              updatedAt: new Date().toISOString(),
            });
          }, materials.flatMap((value) => value ? [value] : []))
        : await this.resume.sendMessage(command.sessionId!, command.text, materials.flatMap((value) => value ? [value] : []));
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

  private async waitForMaterials(ids: string[]): Promise<Array<{ material: Material; path: string } | null>> {
    const deadline = Date.now() + 30_000;
    while (true) {
      const values = ids.map((id) => {
        const material = this.runtime.store.getMaterial(id);
        const path = this.runtime.store.materialLocalPath(id);
        return material?.status === "ready" && path ? { material, path } : null;
      });
      if (values.every((value) => value !== null)) return values;
      if (ids.some((id) => this.runtime.store.getMaterial(id)?.status === "failed") || Date.now() >= deadline) return values;
      await new Promise((resolve) => setTimeout(resolve, 100));
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
