import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES, type Session, type UnifiedEvent } from "@zimlo/protocol";
import { AgentToolService, type AgentToolRequest } from "../src/agent-tools.js";
import { stopFeedDecisionOutput } from "../src/hook-server.js";
import { RuntimeHub } from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";

const session: Session = {
  id: "session-a",
  provider: "codex",
  providerSessionId: "run-a",
  title: "Codex run",
  cwd: "/tmp/project-a",
  transcriptPath: null,
  status: "running",
  lastActivityAt: "2026-07-21T00:00:00.000Z",
  createdAt: "2026-07-21T00:00:00.000Z",
  activePid: 4242,
  processStartedAt: null,
  tty: null,
  correlationUncertain: false,
  capabilities: EMPTY_CAPABILITIES,
};

function request(name: AgentToolRequest["name"], args: unknown, id = crypto.randomUUID()): AgentToolRequest {
  return { type: "agent_tool", id, provider: "codex", parentPid: 4242, cwd: "/tmp/project-a", name, arguments: args };
}

describe("agent-authored feed protocol", () => {
  let store: ZimloStore;
  let runtime: RuntimeHub;
  let tools: AgentToolService;

  beforeEach(() => {
    store = new ZimloStore(":memory:");
    runtime = new RuntimeHub(store);
    runtime.upsertSession(session);
    store.beginFeedCheckpoint({ agentId: "codex", runId: "run-a", taskId: "task-a", sessionId: session.id, startedAt: "2026-07-21T00:00:00.000Z" });
    tools = new AgentToolService(runtime);
  });

  afterEach(() => store.close());

  it("stores only explicit posts and deduplicates retries", () => {
    const args = {
      task_id: "task-a",
      kind: "progress",
      title: "完成认证重构",
      body: "刷新竞态已修复，关键路径测试通过。",
      action_required: false,
      actions: [],
      dedupe_key: "task-a:auth-fixed",
    };
    expect(tools.handle(request("feed.post", args)).ok).toBe(true);
    expect(tools.handle(request("feed.post", args)).data).toMatchObject({ deduplicated: true });
    expect(store.listFeedPosts()).toHaveLength(1);
    expect(store.getFeedCheckpoint("codex", "run-a")?.decisionKind).toBe("post");
  });

  it("records feed.skip without creating a Timeline post", () => {
    const result = tools.handle(request("feed.skip", { task_id: "task-a", reason: "本轮只有普通读取，没有新判断。" }));
    expect(result.ok).toBe(true);
    expect(store.listFeedPosts()).toHaveLength(0);
    expect(store.getFeedCheckpoint("codex", "run-a")?.decisionKind).toBe("skip");
  });

  it("requires a matching post before critical task transitions", () => {
    const blocked = tools.handle(request("signal.transition", { task_id: "task-a", state: "waiting_input", reason: "需要选择兼容方案" }));
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("kind=attention");

    tools.handle(request("feed.post", {
      task_id: "task-a",
      kind: "attention",
      title: "需要选择兼容方案",
      body: "两种迁移策略会影响旧客户端，请确认。",
      action_required: true,
      actions: ["reply"],
      dedupe_key: "task-a:compat-choice",
    }));
    const allowed = tools.handle(request("signal.transition", { task_id: "task-a", state: "waiting_input", reason: "等待用户选择" }));
    expect(allowed.ok).toBe(true);
    expect(store.listTasks()[0]?.state).toBe("waiting_input");
  });

  it("never turns passive transcript events into Feed posts", () => {
    const event: UnifiedEvent = {
      id: "event-a",
      sequence: 0,
      provider: "codex",
      sessionId: session.id,
      providerSessionId: session.providerSessionId,
      kind: "completed",
      source: "transcript",
      occurredAt: "2026-07-21T00:01:00.000Z",
      payload: { message: "任务完成" },
      provenance: "agent_reported",
    };
    runtime.ingestEvent(event);
    expect(store.listFeedPosts()).toHaveLength(0);
    expect(runtime.snapshot().cards).toEqual([]);
  });
});

describe("feed decision Stop checkpoint", () => {
  it("blocks the turn until the Agent calls feed.post or feed.skip", () => {
    const localStore = new ZimloStore(":memory:");
    const localRuntime = new RuntimeHub(localStore);
    const localTools = new AgentToolService(localRuntime);
    try {
      localRuntime.upsertSession({ ...session, providerSessionId: "run-stop", id: "session-stop", cwd: "/tmp/project-stop", activePid: null });
      expect(stopFeedDecisionOutput(localRuntime, "codex", "run-stop")).toMatchObject({ decision: "block" });

      const skipped = localTools.handle({
        type: "agent_tool",
        id: "skip-1",
        provider: "codex",
        parentPid: 0,
        cwd: "/tmp/project-stop",
        name: "feed.skip",
        arguments: { task_id: "run-stop", reason: "没有新的用户可见信息。" },
      });
      expect(skipped.ok).toBe(true);
      expect(stopFeedDecisionOutput(localRuntime, "codex", "run-stop")).toBeNull();
    } finally {
      localStore.close();
    }
  });
});
