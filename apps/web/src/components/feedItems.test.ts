import { describe, expect, it } from "vitest";
import type { FeedPost, PendingAction, TaskCommand } from "@zimlo/protocol";
import { compareFeedItems, isPostCovered, postPriority } from "@zimlo/protocol";
import feedMergeVector from "../../../../packages/protocol/test-vectors/feed-merge.json";
import feedPriorityVector from "../../../../packages/protocol/test-vectors/feed-priority.json";
import { buildFeedItems, mergeRoutinePosts } from "./feedItems";

const post: FeedPost = {
  id: "post-a",
  taskId: "task-a",
  runId: "run-a",
  agentId: "codex",
  sessionId: "session-a",
  kind: "attention",
  presentation: { system: "swiss", theme: "safety_orange", layout: "alert", typography: "sans", density: "balanced", mediaPlacement: "none" },
  headline: "需要处理",
  takeaway: "等待用户决定。",
  highlights: [],
  blocks: [],
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
  it("keeps real approvals as independent cards", () => {
    const items = buildFeedItems([post], [action("linked"), action("standalone")]);
    expect(items.map((item) => `${item.type}:${item.id}`)).toEqual(["action:linked", "action:standalone", "post:post-a"]);
  });

  it("sorts pending attention first, then unread posts, then seen history", () => {
    const result = { ...post, id: "result", kind: "result" as const, createdAt: "2026-07-21T00:03:00.000Z" };
    const seen = { ...result, id: "seen", createdAt: "2026-07-21T00:04:00.000Z" };
    const items = buildFeedItems([seen, result, post], [action("linked")], ["seen"]);
    expect(items.map((item) => item.id)).toEqual(["linked", "result", "post-a", "seen"]);
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
    const history = { ...post, id: "history", createdAt: "2026-07-20T00:00:00.000Z" };
    const items = buildFeedItems([post, history], [], ["history"], [], ["post:post-a", "post:history"]);
    expect(items).toEqual([]);
  });

  it("merges nearby routine updates while preserving higher-value results", () => {
    const older = { ...post, id: "progress-old", kind: "progress" as const, highlights: ["旧事实"], createdAt: "2026-07-23T00:00:00.000Z" };
    const newer = { ...older, id: "progress-new", highlights: ["新事实"], createdAt: "2026-07-23T03:00:00.000Z" };
    const result = { ...older, id: "result", kind: "result" as const, createdAt: "2026-07-23T02:00:00.000Z" };
    const merged = mergeRoutinePosts([older, newer, result]);
    expect(merged.map((item) => item.id)).toEqual(["progress-new", "result"]);
    expect(merged[0]?.highlights).toEqual(["新事实", "旧事实"]);
    expect(buildFeedItems([newer, result], []).map((item) => item.id)).toEqual(["result", "progress-new"]);
  });

  it("never turns editorial posts into approvals", () => {
    expect(buildFeedItems([post], [])[0]).toMatchObject({ type: "post", needsAction: false });
  });
});

describe("protocol feed policy vectors", () => {
  it("matches feed-priority.json for needsAction / covered / priority / ordering", () => {
    for (const testCase of feedPriorityVector.cases) {
      const input = testCase.input;
      if ("items" in input) {
        const order = [...input.items].sort(compareFeedItems).map((item) => item.id);
        expect(order, testCase.name).toEqual((testCase.expected as { order: string[] }).order);
        continue;
      }
      const kind = input.kind as FeedPost["kind"];
      const needsAction = false;
      const covered = isPostCovered({ kind, createdAt: input.createdAt, latestOutcomeCreatedAt: input.latestOutcomeCreatedAt });
      const priority = postPriority({ kind, needsAction, covered, unread: input.unread });
      expect({ covered, priority }, testCase.name).toEqual({ covered: testCase.expected.covered, priority });
    }
  });

  it("matches feed-merge.json for routine post merging", () => {
    const toPost = (value: { id: string; kind: string; taskId: string; sessionId: string | null; createdAt: string; highlights: string[] }): FeedPost => ({
      id: value.id,
      taskId: value.taskId,
      runId: "run-a",
      agentId: "codex",
      sessionId: value.sessionId,
      kind: value.kind as FeedPost["kind"],
      presentation: { system: "editorial", theme: "ink_classic", layout: "feature", typography: "serif", density: "balanced", mediaPlacement: "none" },
      headline: value.id,
      takeaway: "",
      highlights: value.highlights,
      blocks: [],
      dedupeKey: value.id,
      source: "agent",
      createdAt: value.createdAt,
    });
    const toShape = (item: FeedPost) => ({
      id: item.id,
      kind: item.kind,
      taskId: item.taskId,
      sessionId: item.sessionId,
      createdAt: item.createdAt,
      highlights: item.highlights,
    });
    for (const testCase of feedMergeVector.cases) {
      const merged = mergeRoutinePosts(testCase.input.posts.map(toPost)).map(toShape);
      expect(merged, testCase.name).toEqual(testCase.expected.merged);
    }
  });
});
