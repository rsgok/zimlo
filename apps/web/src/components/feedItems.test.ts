import { describe, expect, it } from "vitest";
import type { FeedPost, PendingAction, TaskCommand } from "@zimlo/protocol";
import { buildFeedItems, mergeRoutinePosts } from "./feedItems";

const post: FeedPost = {
  id: "post-a",
  taskId: "task-a",
  runId: "run-a",
  agentId: "codex",
  sessionId: "session-a",
  kind: "attention",
  template: "marker",
  headline: "需要处理",
  takeaway: "等待用户决定。",
  highlights: [],
  actionRequired: true,
  actionPrompt: "请确认。",
  actions: ["approve"],
  pendingActionIds: ["linked"],
  dedupeKey: "post-a",
  source: "agent",
  createdAt: "2026-07-21T00:00:00.000Z",
};

function action(actionId: string): PendingAction {
  return {
    actionId,
    sessionId: "session-a",
    kind: "approval",
    title: "需要批准操作",
    detail: "受保护操作",
    availableDecisions: [],
    expiresAt: "2026-07-21T01:00:00.000Z",
    state: "pending",
    createdAt: "2026-07-21T00:01:00.000Z",
  };
}

describe("Feed item composition", () => {
  it("keeps linked actions inside their Agent post and creates standalone cards for unmatched actions", () => {
    const items = buildFeedItems([post], [action("linked"), action("standalone")]);
    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual(["action:standalone", "post:post-a"]);
  });

  it("sorts pending attention first, then unread posts, then seen history", () => {
    const result = { ...post, id: "result", kind: "result" as const, actionRequired: false, actionPrompt: undefined, pendingActionIds: [], createdAt: "2026-07-21T00:03:00.000Z" };
    const seen = { ...result, id: "seen", createdAt: "2026-07-21T00:04:00.000Z" };
    const items = buildFeedItems([seen, result, post], [], ["seen"]);
    expect(items.map((item) => item.id)).toEqual(["post-a", "result", "seen"]);
  });

  it("surfaces a failed create command with no session as retryable attention", () => {
    const failed: TaskCommand = {
      id: "command-failed",
      idempotencyKey: "device:failed",
      kind: "create",
      provider: "codex",
      sessionId: null,
      workspaceId: "workspace-a",
      cwd: "/Users/kai/Code/zimlo",
      text: "启动新任务",
      state: "failed",
      createdAt: "2026-07-23T01:00:00.000Z",
      updatedAt: "2026-07-23T01:00:00.000Z",
      error: "app-server unavailable",
    };
    const items = buildFeedItems([], [], [], [failed]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "command", id: "command-failed", needsAction: true });
  });

  it("shows a queued create command immediately as a neutral placeholder", () => {
    const queued: TaskCommand = {
      id: "command-queued", idempotencyKey: "device:queued", kind: "create", provider: "claude", sessionId: null,
      workspaceId: "workspace-a", cwd: "/Projects/stocks", text: "分析财报", state: "queued",
      createdAt: "2026-07-23T01:00:00.000Z", updatedAt: "2026-07-23T01:00:00.000Z",
    };
    expect(buildFeedItems([], [], [], [queued])[0]).toMatchObject({ type: "command", needsAction: false, priority: 5 });
  });

  it("removes dismissed cards from both current and historical composition", () => {
    const history = { ...post, id: "history", actionRequired: false, pendingActionIds: [], createdAt: "2026-07-20T00:00:00.000Z" };
    const items = buildFeedItems([post, history], [], ["history"], [], ["post:post-a", "post:history"]);
    expect(items).toEqual([]);
  });

  it("merges nearby routine updates while preserving higher-value results", () => {
    const older = { ...post, id: "progress-old", kind: "progress" as const, actionRequired: false, pendingActionIds: [], highlights: ["旧事实"], createdAt: "2026-07-23T00:00:00.000Z" };
    const newer = { ...older, id: "progress-new", highlights: ["新事实"], createdAt: "2026-07-23T03:00:00.000Z" };
    const result = { ...older, id: "result", kind: "result" as const, createdAt: "2026-07-23T02:00:00.000Z" };
    const merged = mergeRoutinePosts([older, newer, result]);
    expect(merged.map((item) => item.id)).toEqual(["progress-new", "result"]);
    expect(merged[0]?.highlights).toEqual(["新事实", "旧事实"]);
    expect(buildFeedItems([newer, result], []).map((item) => item.id)).toEqual(["result", "progress-new"]);
  });
});
