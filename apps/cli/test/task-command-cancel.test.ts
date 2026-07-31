import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskCommand, TaskCommandState } from "@zimlo/protocol";
import { EMPTY_CAPABILITIES } from "@zimlo/protocol";
import { ActionBroker } from "../src/action-broker.js";
import { ResumeService } from "../src/resume-service.js";
import { RuntimeHub } from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";
import { TaskCommandService } from "../src/task-command-service.js";

const roots: string[] = [];

function createService() {
  const root = mkdtempSync(join(tmpdir(), "zimlo-cancel-"));
  roots.push(root);
  const store = new ZimloStore(join(root, "zimlo.db"));
  // task_commands.session_id references sessions(id): seed the session the
  // fixtures point at.
  store.upsertSession({
    id: "session-a",
    provider: "codex",
    surface: "cli",
    providerSessionId: "provider-a",
    title: "Task A",
    cwd: "/tmp/project",
    transcriptPath: null,
    status: "idle",
    lastActivityAt: "2026-07-29T00:00:00.000Z",
    createdAt: "2026-07-29T00:00:00.000Z",
    activePid: null,
    processStartedAt: null,
    tty: null,
    correlationUncertain: false,
    capabilities: EMPTY_CAPABILITIES,
  });
  const runtime = new RuntimeHub(store);
  const broker = new ActionBroker(runtime);
  const resume = new ResumeService(runtime, broker);
  const service = new TaskCommandService(runtime, resume);
  const emissions: TaskCommand[] = [];
  runtime.onMessage((message) => {
    if (message.type === "task.command.updated") emissions.push(message.command);
  });
  return { store, runtime, service, emissions };
}

function command(id: string, state: TaskCommandState, idempotencyKey = `device-a:key-${id}`): TaskCommand {
  return {
    id,
    idempotencyKey,
    kind: "follow_up",
    provider: "codex",
    sessionId: "session-a",
    workspaceId: null,
    cwd: "/tmp/project",
    text: "继续",
    state,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("task.command.cancel", () => {
  it("cancels a queued command by commandId and broadcasts the update", () => {
    const { store, service, emissions } = createService();
    store.insertTaskCommand(command("cmd-1", "queued"));
    const result = service.cancel({ deviceId: "device-a", commandId: "cmd-1" });
    expect(result.ok).toBe(true);
    expect(store.getTaskCommand("cmd-1")?.state).toBe("canceled");
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.state).toBe("canceled");
  });

  it("locates a command by device-scoped idempotencyKey", () => {
    const { store, service } = createService();
    store.insertTaskCommand(command("cmd-2", "queued"));
    const result = service.cancel({ deviceId: "device-a", idempotencyKey: "key-cmd-2" });
    expect(result.ok).toBe(true);
    expect(store.getTaskCommand("cmd-2")?.state).toBe("canceled");
  });

  it("scopes idempotencyKey lookup to the requesting device", () => {
    const { store, service } = createService();
    store.insertTaskCommand(command("cmd-3", "queued"));
    const result = service.cancel({ deviceId: "device-b", idempotencyKey: "key-cmd-3" });
    expect(result.ok).toBe(false);
    expect(store.getTaskCommand("cmd-3")?.state).toBe("queued");
  });

  it("is idempotent: re-canceling a canceled command succeeds without re-emitting", () => {
    const { store, service, emissions } = createService();
    store.insertTaskCommand(command("cmd-4", "queued"));
    const first = service.cancel({ deviceId: "device-a", idempotencyKey: "key-cmd-4" });
    expect(first.ok).toBe(true);
    const second = service.cancel({ deviceId: "device-a", idempotencyKey: "key-cmd-4" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.command.state).toBe("canceled");
    expect(emissions).toHaveLength(1);
  });

  it("rejects dispatching/running/terminal commands as not cancelable", () => {
    const { store, service } = createService();
    for (const [index, state] of (["dispatching", "running", "completed", "failed"] as const).entries()) {
      store.insertTaskCommand(command(`cmd-${index}`, state));
      const result = service.cancel({ deviceId: "device-a", commandId: `cmd-${index}` });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("command_not_cancelable");
      expect(store.getTaskCommand(`cmd-${index}`)?.state).toBe(state);
    }
  });

  it("reports unknown commands", () => {
    const { service } = createService();
    const byId = service.cancel({ deviceId: "device-a", commandId: "missing" });
    expect(byId.ok).toBe(false);
    if (!byId.ok) expect(byId.code).toBe("task_command_not_found");
    const byKey = service.cancel({ deviceId: "device-a", idempotencyKey: "missing" });
    expect(byKey.ok).toBe(false);
    if (!byKey.ok) expect(byKey.code).toBe("task_command_not_found");
  });

  it("never dispatches a canceled command", () => {
    const { store, service } = createService();
    store.insertTaskCommand(command("cmd-5", "queued"));
    service.cancel({ deviceId: "device-a", commandId: "cmd-5" });
    expect(store.listQueuedTaskCommands()).toHaveLength(0);
  });
});
