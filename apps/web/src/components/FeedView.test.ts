import { describe, expect, it } from "vitest";
import type { FeedPost } from "@zimlo/protocol";
import { currentSessionPriority, updateCurrentCohort } from "./FeedView";

const post: FeedPost = {
  id: "post-a", taskId: "task-a", runId: "run-a", agentId: "codex", sessionId: "session-a",
  kind: "result", template: "paper", headline: "结果", takeaway: "完成", highlights: [],
  actionRequired: false, actions: [], pendingActionIds: [], dedupeKey: "result", source: "agent",
  createdAt: "2026-07-23T00:00:00.000Z",
};

describe("Feed session ordering", () => {
  it("does not reorder the visible cohort only because a post became seen", () => {
    expect(currentSessionPriority({ type: "post", id: post.id, createdAt: post.createdAt, needsAction: false, unread: true, priority: 2, post })).toBe(2);
    expect(currentSessionPriority({ type: "post", id: post.id, createdAt: post.createdAt, needsAction: false, unread: false, priority: 12, post })).toBe(2);
  });

  it("resurfaces a seen post when it gains a pending user action", () => {
    const cohort = new Map([["post:post-a", false]]);
    updateCurrentCohort(cohort, [{ type: "post", id: post.id, createdAt: post.createdAt, needsAction: true, unread: false, priority: 0, post: { ...post, actionRequired: true } }]);
    expect(cohort.get("post:post-a")).toBe(true);
  });
});
