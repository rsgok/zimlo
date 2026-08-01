import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_CAPABILITIES, type Session, type UnifiedEvent } from "@zimlo/protocol";
import { AgentToolService, type AgentToolRequest } from "../src/agent-tools.js";
import { finalizeStopFeedDecision, hookClientTimeoutMs, ingestUserInstruction } from "../src/hook-server.js";
import { RuntimeHub } from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";

const session: Session = {
  id: "session-a",
  provider: "codex",
  surface: "cli",
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
      template: "grid",
      headline: "完成认证重构",
      takeaway: "刷新竞态已修复，用户不会再被重复登出。",
      highlights: ["刷新请求只保留一个在途实例"],
      proof: "关键路径测试通过",
      dedupe_key: "task-a:auth-fixed",
    };
    expect(tools.handle(request("feed.post", args)).ok).toBe(true);
    expect(tools.handle(request("feed.post", args)).data).toMatchObject({ deduplicated: true });
    expect(store.listFeedPosts()).toHaveLength(1);
    expect(store.getFeedCheckpoint("codex", "run-a")?.decisionKind).toBe("post");
    expect(store.listFeedPosts()[0]).toMatchObject({ template: "grid", headline: "完成认证重构", highlights: ["刷新请求只保留一个在途实例"] });
  });

  it("rejects removed V2 action fields without storing partial content", () => {
    const legacyAction = tools.handle(request("feed.post", {
      task_id: "task-a",
      kind: "attention",
      template: "marker",
      headline: "需要选择兼容方案",
      takeaway: "旧客户端无法读取新记录。",
      highlights: [],
      action_required: true,
      dedupe_key: "task-a:invalid",
    }));
    expect(legacyAction.ok).toBe(false);
    expect(store.listFeedPosts()).toHaveLength(0);
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
      template: "marker",
      headline: "需要选择兼容方案",
      takeaway: "两种迁移策略会影响旧客户端。",
      highlights: ["旧客户端仍在使用"],
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

  it("publishes a generated workspace file before referencing it from a media card", () => {
    const root = mkdtempSync(join(tmpdir(), "zimlo-material-tool-"));
    const localStore = new ZimloStore(join(root, "zimlo.db"));
    try {
      const file = join(root, "result.png");
      writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kZkAAAAASUVORK5CYII=", "base64"));
      const localRuntime = new RuntimeHub(localStore);
      localRuntime.upsertSession({ ...session, cwd: root });
      localStore.beginFeedCheckpoint({ agentId: "codex", runId: "run-a", taskId: "task-a", sessionId: session.id, startedAt: "2026-07-21T00:00:00.000Z" });
      const localTools = new AgentToolService(localRuntime);
      const published = localTools.handle({ ...request("material.publish", { path: "result.png" }), cwd: root });
      expect(published.ok).toBe(true);
      const materialId = (published.data as { material_id: string }).material_id;
      expect(localStore.getMaterial(materialId)).toMatchObject({ kind: "image", status: "ready", origin: "agent" });

      const posted = localTools.handle({ ...request("feed.post", {
        task_id: "task-a", kind: "result", template: "paper", headline: "效果图已生成",
        takeaway: "可以直接查看最终画面。", highlights: [],
        content: { type: "image_album", materialIds: [materialId] }, dedupe_key: "task-a:image-result",
      }), cwd: root });
      expect(posted.ok).toBe(true);
      expect(localStore.listFeedPosts()[0]?.content).toEqual({ type: "image_album", materialIds: [materialId] });

      const disguised = join(root, "disguised.png");
      writeFileSync(disguised, Buffer.from("not actually an image"));
      const rejected = localTools.handle({ ...request("material.publish", { path: "disguised.png" }), cwd: root });
      expect(rejected.ok).toBe(false);
      expect(rejected.message).toContain("图片内容与声明格式不一致");
    } finally {
      localStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("feed decision Stop checkpoint", () => {
  it("uses a unique open hook checkpoint before considering cwd", () => {
    const localStore = new ZimloStore(":memory:");
    try {
      const localRuntime = new RuntimeHub(localStore);
      const localTools = new AgentToolService(localRuntime);
      const hookSession = localStore.upsertSession({ ...session, activePid: null });
      localStore.beginFeedCheckpoint({
        agentId: "codex",
        runId: hookSession.providerSessionId,
        taskId: `run:${hookSession.providerSessionId}`,
        sessionId: hookSession.id,
        startedAt: new Date().toISOString(),
      });
      expect(localStore.findSessionForAgentTool("codex", 0, "/", "editor-task")?.id).toBe(hookSession.id);
      const result = localTools.handle({
        type: "agent_tool",
        id: "post-from-mcp-helper",
        provider: "codex",
        parentPid: 0,
        cwd: "/",
        name: "feed.post",
        arguments: {
          task_id: "editor-task",
          kind: "result",
          template: "paper",
          headline: "归属完成",
          takeaway: "卡片继承真实 Session 的项目。",
          highlights: [],
          dedupe_key: "editor-task:result",
        },
      });
      expect(result.ok).toBe(true);
      expect(localStore.listFeedPosts()[0]).toMatchObject({ sessionId: hookSession.id, projectId: hookSession.projectId });
    } finally {
      localStore.close();
    }
  });

  it("does not attach a new Agent task to an uncertain PID or cwd match", () => {
    const localStore = new ZimloStore(":memory:");
    try {
      localStore.upsertSession({ ...session, correlationUncertain: true });
      expect(localStore.findSessionForAgentTool("codex", 4242, "/tmp/project-a", "new-task")).toBeNull();

      const direct = { ...session, id: "tool-session", providerSessionId: "new-task", correlationUncertain: true };
      localStore.upsertSession(direct);
      expect(localStore.findSessionForAgentTool("codex", 0, "/tmp/other", "new-task")?.id).toBe("tool-session");
    } finally {
      localStore.close();
    }
  });

  it("stores user prompts as Task events without creating Feed posts", () => {
    const localStore = new ZimloStore(":memory:");
    const localRuntime = new RuntimeHub(localStore);
    try {
      localRuntime.upsertSession(session);
      ingestUserInstruction(localRuntime, "codex", session, "请修复登录问题", "turn-a");
      expect(localStore.listFeedPosts()).toHaveLength(0);
      expect(localStore.listEvents(session.id)).toEqual([
        expect.objectContaining({ kind: "user_instruction", turnId: "turn-a", payload: { prompt: "请修复登录问题" } }),
      ]);
    } finally {
      localStore.close();
    }
  });

  it("silently records implicit_skip instead of blocking the turn", () => {
    const localStore = new ZimloStore(":memory:");
    const localRuntime = new RuntimeHub(localStore);
    try {
      localRuntime.upsertSession({ ...session, providerSessionId: "run-stop", id: "session-stop", cwd: "/tmp/project-stop", activePid: null });
      localStore.beginFeedCheckpoint({ agentId: "codex", runId: "run-stop", taskId: "task-stop", sessionId: "session-stop", startedAt: "2026-07-21T00:00:00.000Z" });
      finalizeStopFeedDecision(localRuntime, "codex", "run-stop");
      expect(localStore.getFeedCheckpoint("codex", "run-stop")).toMatchObject({
        decisionKind: "implicit_skip",
        decisionRef: "stop:implicit",
      });
      finalizeStopFeedDecision(localRuntime, "codex", "run-stop");
      expect(localStore.getFeedCheckpoint("codex", "run-stop")?.decisionKind).toBe("implicit_skip");
    } finally {
      localStore.close();
    }
  });

  it("preserves an explicit decision and finalizes stale checkpoints on restart", () => {
    const localStore = new ZimloStore(":memory:");
    try {
      localStore.beginFeedCheckpoint({ agentId: "codex", runId: "explicit", taskId: "task-explicit", sessionId: null, startedAt: "2026-07-21T00:00:00.000Z" });
      localStore.recordFeedDecision({ agentId: "codex", runId: "explicit", taskId: "task-explicit", kind: "post", at: "2026-07-21T00:00:01.000Z", ref: "post-1" });
      localStore.beginFeedCheckpoint({ agentId: "codex", runId: "stale", taskId: "task-stale", sessionId: null, startedAt: "2026-07-21T00:00:00.000Z" });
      expect(localStore.finalizeOpenFeedCheckpoints("2026-07-21T00:02:00.000Z", "bridge:restart")).toBe(1);
      expect(localStore.getFeedCheckpoint("codex", "explicit")?.decisionKind).toBe("post");
      expect(localStore.getFeedCheckpoint("codex", "stale")).toMatchObject({ decisionKind: "implicit_skip", decisionRef: "bridge:restart" });
    } finally {
      localStore.close();
    }
  });

  it("only lets approval and user-input hooks wait for a human", () => {
    expect(hookClientTimeoutMs({ hook_event_name: "Stop" })).toBe(2_500);
    expect(hookClientTimeoutMs({ hook_event_name: "PermissionRequest" })).toBe(481_000);
    expect(hookClientTimeoutMs({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" })).toBe(481_000);
    expect(hookClientTimeoutMs({ hook_event_name: "PreToolUse", tool_name: "Bash" })).toBe(2_500);
  });
});
