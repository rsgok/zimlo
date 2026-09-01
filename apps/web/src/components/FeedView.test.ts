import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FeedPost } from "@zimlo/protocol";
import { FeedView } from "./FeedView";

const post: FeedPost = {
  id: "post-a", taskId: "task-a", runId: "run-a", agentId: "codex", sessionId: "session-a",
  kind: "result", presentation: { system: "editorial", theme: "ink_classic", layout: "feature", typography: "serif", density: "balanced", mediaPlacement: "none" },
  headline: "结果", takeaway: "完成", highlights: [], blocks: [],
  dedupeKey: "result", source: "agent",
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
    ...(overrides.interactionMode ? { interactionMode: overrides.interactionMode } : {}),
  }));
}

describe("FeedView", () => {
  it("partitions unseen posts into the queue and seen posts into history", () => {
    const historical = { ...post, id: "post-history", createdAt: "2026-07-22T00:00:00.000Z" };
    const markup = renderFeed({ posts: [post, historical], seenPostIds: [historical.id] });

    expect(markup).not.toContain("post-position");
    expect(markup).toContain('post-task-hint">历史');
    expect(markup).not.toContain("history-label");
    expect(markup).toContain('data-feed-key="post:post-a"');
    expect(markup).toContain('data-feed-key="post:post-history"');
  });

  it("renders a quiet caught-up page without consumption counts or a large task CTA", () => {
    const markup = renderFeed({ seenPostIds: [post.id] });

    expect(markup).toContain('data-feed-key="__caught_up__"');
    expect(markup).toContain("暂时没有新内容");
    expect(markup).toContain('class="feed-history-button"');
    expect(markup).not.toContain("继续看历史 ↓");
    expect(markup).not.toContain("新任务");
  });

  it("does not show the new-updates pill on first render", () => {
    expect(renderFeed()).not.toContain("feed-new-updates");
  });

  it("renders quiet directional icon actions in the macOS shell mode", () => {
    const markup = renderFeed({ interactionMode: "desktop" });

    expect(markup).toContain("desktop-feed-item");
    expect(markup).toContain("desktop-feed-action-dismiss");
    expect(markup).toContain("desktop-feed-action-profile");
    expect(markup).not.toContain(">查看任务<");
    expect(markup).not.toContain(">移出 Feed<");
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
    }));
    expect(markup).toContain("暂时没有新内容");
    expect(markup).not.toContain("post-position");
  });
});
