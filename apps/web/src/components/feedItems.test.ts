import { describe, expect, it } from "vitest";
import type { FeedPost, PendingAction, TaskCommand } from "@zimlo/protocol";
import { buildFeedItems } from "./feedItems";

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
});
