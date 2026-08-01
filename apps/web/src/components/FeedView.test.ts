import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FeedPost } from "@zimlo/protocol";
import { FeedView } from "./FeedView";

const post: FeedPost = {
  id: "post-a", taskId: "task-a", runId: "run-a", agentId: "codex", sessionId: "session-a",
  kind: "result", template: "paper", headline: "结果", takeaway: "完成", highlights: [],
  actionRequired: false, actions: [], pendingActionIds: [], dedupeKey: "result", source: "agent",
  createdAt: "2026-07-23T00:00:00.000Z",
};

function renderFeed(overrides: { posts?: FeedPost[]; seenPostIds?: string[]; interactionMode?: "swipe" | "desktop" } = {}) {
  return renderToStaticMarkup(createElement(FeedView, {
    projects: [],
    posts: overrides.posts ?? [post],
    sessions: [],
    actions: [],
    commands: [],
    tasks: [],
    seenPostIds: overrides.seenPostIds ?? [],
    dismissedFeedItemIds: [],
    send: vi.fn(() => true),
    onOpen: vi.fn(),
    onOpenProject: vi.fn(),
    onNewTask: vi.fn(),
    ...(overrides.interactionMode ? { interactionMode: overrides.interactionMode } : {}),
  }));
}

describe("FeedView", () => {
  it("partitions unseen posts into the queue and seen posts into history", () => {
    const historical = { ...post, id: "post-history", createdAt: "2026-07-22T00:00:00.000Z" };
    const markup = renderFeed({ posts: [post, historical], seenPostIds: [historical.id] });

    // 队列卡带编号，历史卡带"历史"标签且无编号
    expect(markup).toContain("01 / 01");
    expect(markup.match(/class="post-position"/gu)).toHaveLength(1);
    expect(markup).toContain("history-label");
    expect(markup).toContain('data-feed-key="post:post-a"');
    expect(markup).toContain('data-feed-key="post:post-history"');
  });

  it("renders the caught-up page and keeps the new-task action concise", () => {
    const markup = renderFeed();

    expect(markup).toContain('data-feed-key="__caught_up__"');
    expect(markup).toContain("当前更新已经看完");
    expect(markup).toContain("＋ 新任务");
    expect(markup).not.toContain("现在可以布置一个新任务");
  });

  it("does not show the new-updates pill on first render", () => {
    expect(renderFeed()).not.toContain("feed-new-updates");
  });

  it("renders desktop card actions without swipe affordances in the macOS shell mode", () => {
    const markup = renderFeed({ interactionMode: "desktop" });

    expect(markup).toContain("desktop-feed-item");
    expect(markup).toContain("查看任务");
    expect(markup).toContain("移出 Feed");
    expect(markup).not.toContain("左滑查看 Task Profile");
  });

  it("shows the empty state when every card was dismissed", () => {
    const markup = renderToStaticMarkup(createElement(FeedView, {
      projects: [],
      posts: [post],
      sessions: [],
      actions: [],
      commands: [],
      tasks: [],
      seenPostIds: [],
      dismissedFeedItemIds: ["post:post-a"],
      send: vi.fn(() => true),
      onOpen: vi.fn(),
      onOpenProject: vi.fn(),
      onNewTask: vi.fn(),
    }));
    expect(markup).toContain("Feed 已经清空");
    expect(markup).not.toContain("post-position");
  });
});
