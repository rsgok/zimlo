import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionBroker } from "../src/action-broker.js";
import { AgentToolService } from "../src/agent-tools.js";
import { actionDetailFor, approvalTitleFor, HookServer, isTrustedZimloPermission } from "../src/hook-server.js";
import { RuntimeHub } from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "zimlo-hook-test-"));
  temporaryDirectories.push(directory);
  const store = new ZimloStore(join(directory, "zimlo.db"));
  const runtime = new RuntimeHub(store);
  const broker = new ActionBroker(runtime);
  const socketPath = join(directory, "run", "bridge.sock");
  const server = new HookServer(runtime, broker, socketPath, new AgentToolService(runtime));
  return { store, runtime, socketPath, server };
}

interface TestableHookServer {
  handleRequest(request: { id: string; provider: "codex"; surface: "gui" | "cli"; payload: Record<string, unknown> }, cancellation?: AbortSignal): Promise<Record<string, unknown>>;
}

function handleRequest(server: HookServer, request: Parameters<TestableHookServer["handleRequest"]>[0], cancellation?: AbortSignal) {
  return (server as unknown as TestableHookServer).handleRequest(request, cancellation);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Hook approval routing", () => {
  it("keeps the reason and target in approval context", () => {
    const payload = {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "git push", description: "发布已经验证的修复" },
    };
    expect(approvalTitleFor(payload)).toBe("批准执行命令");
    expect(actionDetailFor(payload)).toBe("目的：发布已经验证的修复\n命令：git push");
  });

  it("auto-allows only Zimlo's non-destructive control tools without creating an action", async () => {
    const { store, server } = setup();
    try {
      const payload = {
        session_id: "thread-a",
        cwd: "/tmp/project",
        hook_event_name: "PermissionRequest",
        tool_name: "mcp__zimlo__feed_post",
        tool_input: { headline: "完成" },
      };
      expect(isTrustedZimloPermission(payload)).toBe(true);
      const response = await handleRequest(server, { id: "trusted", provider: "codex", surface: "gui", payload });
      expect(response).toMatchObject({
        id: "trusted",
        output: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } },
      });
      expect(store.listPendingActions()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("expires a pending action as soon as the original Hook client disconnects", async () => {
    const { store, runtime, server } = setup();
    try {
      const pending = new Promise<string>((resolve) => {
        const listener = (message: unknown) => {
          const value = message as { type?: string; action?: { actionId: string; state: string } };
          if (value.type === "action.upsert" && value.action?.state === "pending") {
            runtime.off("message", listener);
            resolve(value.action.actionId);
          }
        };
        runtime.on("message", listener);
      });
      const expired = new Promise<string>((resolve) => {
        const listener = (message: unknown) => {
          const value = message as { type?: string; action?: { actionId: string; state: string } };
          if (value.type === "action.upsert" && value.action?.state === "expired") {
            runtime.off("message", listener);
            resolve(value.action.actionId);
          }
        };
        runtime.on("message", listener);
      });
      const cancellation = new AbortController();
      const response = handleRequest(server, {
        id: "cancelled",
        provider: "codex",
        surface: "cli",
        payload: {
          session_id: "thread-b",
          cwd: "/tmp/project",
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "git push", description: "发布修复" },
        },
      }, cancellation.signal);
      const actionId = await pending;
      cancellation.abort();
      expect(await expired).toBe(actionId);
      expect(store.getAction(actionId)?.state).toBe("expired");
      await response;
    } finally {
      store.close();
    }
  });
});
