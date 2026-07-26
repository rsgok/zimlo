import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FeedPost, TaskReview } from "@zimlo/protocol";
import { currentSessionPriority, FeedView, updateCurrentCohort } from "./FeedView";
import { buildFeedItems } from "./feedItems";

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

  it("moves an accepted result into history while an unreviewed result stays actionable", () => {
    const baseReview: TaskReview = {
      id: "review-a",
      taskId: post.taskId,
      sessionId: post.sessionId!,
      postId: post.id,
      version: 1,
      state: "unreviewed",
      bundle: { conclusion: "完成", changedFiles: [], tests: [], links: [], evidenceSource: "agent_reported" },
      createdAt: post.createdAt,
      updatedAt: post.createdAt,
      legacy: false,
    };
    const unreviewed = buildFeedItems([post], [], [post.id], [], [], [], [baseReview])[0]!;
    const accepted = buildFeedItems([post], [], [], [], [], [], [{ ...baseReview, state: "accepted" }])[0]!;
    expect(unreviewed).toMatchObject({ needsAction: true, unread: false });
    expect(accepted).toMatchObject({ needsAction: false, unread: false, settledReview: true });
    const cohort = new Map([["post:post-a", true]]);
    updateCurrentCohort(cohort, [accepted]);
    expect(cohort.get("post:post-a")).toBe(false);
  });

  it("numbers only the current cohort and keeps the caught-up action concise", () => {
    const historical = { ...post, id: "post-history", createdAt: "2026-07-22T00:00:00.000Z" };
    const markup = renderToStaticMarkup(createElement(FeedView, {
      projects: [],
      posts: [post, historical],
      sessions: [],
      actions: [],
      commands: [],
      tasks: [],
      seenPostIds: [historical.id],
      dismissedFeedItemIds: [],
      send: vi.fn(() => true),
      onOpen: vi.fn(),
      onOpenProject: vi.fn(),
      onNewTask: vi.fn(),
    }));

    expect(markup).toContain("01 / 01");
    expect(markup.match(/class="post-position"/gu)).toHaveLength(1);
    expect(markup).not.toContain("02 / 02");
    expect(markup).not.toContain("现在可以布置一个新任务");
    expect(markup).toContain("＋ 新任务");
  });
});
