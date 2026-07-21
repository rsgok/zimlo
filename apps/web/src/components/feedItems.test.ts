import { describe, expect, it } from "vitest";
import type { FeedPost, PendingAction } from "@zimlo/protocol";
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
});
