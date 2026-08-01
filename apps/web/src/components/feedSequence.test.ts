import { describe, expect, it } from "vitest";
import type { FeedPost } from "@zimlo/protocol";
import type { FeedItem } from "./feedItems";
import {
  applyDismissOverrides,
  captureAnchor,
  captureInitialAnchor,
  clearFresh,
  createFeedSequence,
  reconcileFeedSequence,
  restoreScrollTop,
  type FeedAnchor,
  type FeedPageLayout,
} from "./feedSequence";

function postItem(id: string, options: { unread?: boolean; needsAction?: boolean; priority?: number; createdAt?: string } = {}): FeedItem {
  const createdAt = options.createdAt ?? "2026-07-23T00:00:00.000Z";
  const post: FeedPost = {
    id, taskId: `task-${id}`, runId: "run-a", agentId: "codex", sessionId: null,
    kind: "result", template: "paper", headline: id, takeaway: "", highlights: [],
    dedupeKey: id, source: "agent", createdAt,
  };
  return {
    type: "post",
    id,
    createdAt,
    needsAction: options.needsAction ?? false,
    unread: options.unread ?? true,
    priority: options.priority ?? 2,
    post,
  };
}

describe("createFeedSequence", () => {
  it("puts actionable or unread items into the queue and the rest into history, preserving item order", () => {
    const sequence = createFeedSequence([
      postItem("a", { needsAction: true, priority: 0 }),
      postItem("b"),
      postItem("c", { unread: false }),
    ]);
    expect(sequence.queue).toEqual(["post:a", "post:b"]);
    expect(sequence.history).toEqual(["post:c"]);
    expect(sequence.fresh).toEqual([]);
  });
});

describe("reconcileFeedSequence", () => {
  it("does not move a queued card when it becomes seen or its action settles", () => {
    const initial = createFeedSequence([postItem("a"), postItem("b")]);
    const next = reconcileFeedSequence(initial, [
      postItem("a", { unread: false }),
      postItem("b", { unread: false, needsAction: false }),
    ]);
    expect(next.queue).toEqual(["post:a", "post:b"]);
    expect(next.history).toEqual([]);
  });

  it("appends a historical card that becomes actionable again to the queue tail and marks it fresh", () => {
    const initial = createFeedSequence([postItem("a"), postItem("c", { unread: false })]);
    const next = reconcileFeedSequence(initial, [postItem("a"), postItem("c", { unread: false, needsAction: true, priority: 0 })]);
    expect(next.queue).toEqual(["post:a", "post:c"]);
    expect(next.fresh).toEqual(["post:c"]);
    expect(next.history).toEqual([]);
  });

  it("appends newly arrived actionable cards in item order and accumulates fresh", () => {
    const initial = reconcileFeedSequence(createFeedSequence([postItem("a")]), [postItem("a"), postItem("b")]);
    const next = reconcileFeedSequence(initial, [postItem("a"), postItem("b"), postItem("c")]);
    expect(next.queue).toEqual(["post:a", "post:b", "post:c"]);
    expect(next.fresh).toEqual(["post:b", "post:c"]);
  });

  it("drops cards that disappear from the item list (explicit removal)", () => {
    const initial = reconcileFeedSequence(createFeedSequence([postItem("a")]), [postItem("a"), postItem("b")]);
    // b 是 fresh 卡：消失后同时从队列与 fresh 移除；a 保留
    const next = reconcileFeedSequence(initial, [postItem("a")]);
    expect(next.queue).toEqual(["post:a"]);
    expect(next.fresh).toEqual([]);
    // 队列中的非 fresh 卡消失也不影响其余 fresh 记录
    const stillFresh = reconcileFeedSequence(initial, [postItem("b")]);
    expect(stillFresh.queue).toEqual(["post:b"]);
    expect(stillFresh.fresh).toEqual(["post:b"]);
  });

  it("merges newly historical cards into history newest-first", () => {
    const initial = createFeedSequence([postItem("a"), postItem("old", { unread: false, createdAt: "2026-07-20T00:00:00.000Z" })]);
    const next = reconcileFeedSequence(initial, [
      postItem("a"),
      postItem("old", { unread: false, createdAt: "2026-07-20T00:00:00.000Z" }),
      postItem("newer-history", { unread: false, createdAt: "2026-07-22T00:00:00.000Z" }),
    ]);
    expect(next.history).toEqual(["post:newer-history", "post:old"]);
  });
});

describe("clearFresh", () => {
  it("clears the fresh count once the user reaches the caught-up page", () => {
    const initial = reconcileFeedSequence(createFeedSequence([postItem("a")]), [postItem("a"), postItem("b")]);
    expect(initial.fresh).toEqual(["post:b"]);
    const cleared = clearFresh(initial);
    expect(cleared.fresh).toEqual([]);
    expect(cleared.queue).toEqual(initial.queue);
  });
});

describe("feed scroll anchor", () => {
  const pages: FeedPageLayout[] = [
    { key: "post:a", top: 0, height: 100 },
    { key: "post:b", top: 100, height: 100 },
    { key: "post:c", top: 200, height: 100 },
  ];

  it("captures the visible card and its pixel offset, including mid-card fast scrolls", () => {
    expect(captureAnchor(0, pages)).toEqual({ key: "post:a", offset: 0, index: 0 });
    expect(captureAnchor(250, pages)).toEqual({ key: "post:c", offset: -50, index: 2 });
    expect(captureAnchor(0, [])).toBeNull();
  });

  it("does not anchor an empty startup frame to caught-up before an async snapshot arrives", () => {
    const emptyFrame = [{ key: "__caught_up__", top: 0, height: 100 }];
    expect(captureInitialAnchor(false, emptyFrame)).toBeNull();

    const delayedSnapshot = [
      { key: "post:new", top: 0, height: 100 },
      { key: "__caught_up__", top: 100, height: 100 },
    ];
    expect(captureInitialAnchor(true, delayedSnapshot)).toEqual({ key: "post:new", offset: 0, index: 0 });
  });

  it("restores the anchor card to its offset after cards above it change height", () => {
    const anchor: FeedAnchor = { key: "post:c", offset: -50, index: 2 };
    const grown: FeedPageLayout[] = [
      { key: "post:a", top: 0, height: 260 },
      { key: "post:b", top: 260, height: 100 },
      { key: "post:c", top: 360, height: 100 },
    ];
    // 恢复后 scrollTop 与锚卡偏移误差为 0（≤2px 容差内，组件层不再修正）
    expect(restoreScrollTop(anchor, grown)).toBe(410);
  });

  it("falls back to the original index when the anchor card was removed", () => {
    const anchor: FeedAnchor = { key: "post:gone", offset: -50, index: 1 };
    expect(restoreScrollTop(anchor, pages)).toBe(150);
    expect(restoreScrollTop(anchor, [])).toBeNull();
  });
});

describe("applyDismissOverrides", () => {
  it("applies dismiss intents in both directions and reports intents settled by the snapshot", () => {
    const withNewIntent = applyDismissOverrides(["post:x"], new Map([["post:y", true]]));
    expect(withNewIntent.effective).toEqual(["post:x", "post:y"]);
    expect(withNewIntent.settled).toEqual([]);

    const absorbed = applyDismissOverrides(["post:x", "post:y"], new Map([["post:y", true]]));
    expect(absorbed.effective).toEqual(["post:x", "post:y"]);
    expect(absorbed.settled).toEqual(["post:y"]);

    const undone = applyDismissOverrides(["post:x"], new Map([["post:x", false]]));
    expect(undone.effective).toEqual([]);
    expect(undone.settled).toEqual([]);

    const undoAbsorbed = applyDismissOverrides([], new Map([["post:x", false]]));
    expect(undoAbsorbed.effective).toEqual([]);
    expect(undoAbsorbed.settled).toEqual(["post:x"]);
  });
});
