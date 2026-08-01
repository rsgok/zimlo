import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ClientCommand, FeedPost, FeedPostKind, PendingAction, TaskCommandState } from "../src/index.js";
import {
  BACKOFF_DELAYS_MS,
  BACKOFF_JITTER_RATIO,
  CANCELABLE_COMMAND_STATES,
  FEED_MERGE_WINDOW_MS,
  POST_VALUE,
  backoffDelayMs,
  compareFeedItems,
  isCommandCancelable,
  isPostCovered,
  isQuickApprovable,
  mergeRoutinePosts,
  postPriority,
  semanticCommandKey,
} from "../src/index.js";

function readVectors<T>(name: string): { version: number; cases: T[] } {
  return JSON.parse(readFileSync(new URL(`../test-vectors/${name}`, import.meta.url), "utf8")) as { version: number; cases: T[] };
}

interface VectorPost {
  id: string;
  kind: string;
  taskId: string;
  sessionId: string | null;
  createdAt: string;
  highlights: string[];
}

function toFeedPost(post: VectorPost): FeedPost {
  return {
    id: post.id,
    taskId: post.taskId,
    runId: "run-1",
    agentId: "agent-1",
    sessionId: post.sessionId,
    kind: post.kind as FeedPostKind,
    template: "paper",
    headline: post.id,
    takeaway: post.id,
    highlights: [...post.highlights],
    dedupeKey: post.id,
    source: "agent",
    createdAt: post.createdAt,
  };
}

function toCompact(post: FeedPost): VectorPost {
  return { id: post.id, kind: post.kind, taskId: post.taskId, sessionId: post.sessionId, createdAt: post.createdAt, highlights: post.highlights };
}

describe("feed-merge vectors", () => {
  interface MergeCase { name: string; input: { posts: VectorPost[] }; expected: { merged: VectorPost[] } }
  const { version, cases } = readVectors<MergeCase>("feed-merge.json");
  it("declares version 1", () => expect(version).toBe(1));
  for (const testCase of cases) {
    it(testCase.name, () => {
      const merged = mergeRoutinePosts(testCase.input.posts.map(toFeedPost));
      expect(merged.map(toCompact)).toEqual(testCase.expected.merged);
    });
  }
});

describe("feed-priority vectors", () => {
  interface PriorityInput {
    kind: FeedPostKind;
    createdAt: string;
    latestOutcomeCreatedAt: string | null;
    unread: boolean;
  }
  interface SortItem { id: string; priority: number; createdAt: string }
  interface PriorityCase {
    name: string;
    input: PriorityInput | { items: SortItem[] };
    expected: { covered?: boolean; priority?: number; order?: string[] };
  }
  const { version, cases } = readVectors<PriorityCase>("feed-priority.json");
  it("declares version 3", () => expect(version).toBe(3));
  for (const testCase of cases) {
    it(testCase.name, () => {
      if ("items" in testCase.input) {
        const sorted = [...testCase.input.items].sort(compareFeedItems);
        expect(sorted.map((item) => item.id)).toEqual(testCase.expected.order);
        return;
      }
      const input = testCase.input;
      expect(isPostCovered(input)).toBe(testCase.expected.covered);
      expect(postPriority({
        kind: input.kind,
        needsAction: false,
        covered: isPostCovered(input),
        unread: input.unread,
      })).toBe(testCase.expected.priority);
    });
  }
});

describe("outbox-keys vectors", () => {
  interface KeyCase { name: string; input: Record<string, unknown> & { type: string }; expected: { key: string } }
  const { version, cases } = readVectors<KeyCase>("outbox-keys.json");
  it("declares version 1", () => expect(version).toBe(1));
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(semanticCommandKey(testCase.input)).toBe(testCase.expected.key);
    });
  }
});

describe("backoff vectors", () => {
  interface BackoffCase { name: string; input: { attempt: number; randomValue: number }; expected: { delayMs: number } }
  const { version, cases } = readVectors<BackoffCase>("backoff.json");
  it("declares version 1", () => expect(version).toBe(1));
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(backoffDelayMs(testCase.input.attempt, () => testCase.input.randomValue)).toBe(testCase.expected.delayMs);
    });
  }
});

describe("quick-approve vectors", () => {
  interface DecisionInput { scope: string; risk: "low" | "medium" | "high"; confirmationPhrase?: string }
  interface QuickApproveCase { name: string; input: { kind: string; decisions: DecisionInput[] }; expected: { quickApprovable: boolean } }
  const { version, cases } = readVectors<QuickApproveCase>("quick-approve.json");
  it("declares version 1", () => expect(version).toBe(1));
  for (const testCase of cases) {
    it(testCase.name, () => {
      const action = {
        kind: testCase.input.kind as PendingAction["kind"],
        availableDecisions: testCase.input.decisions.map((decision, index) => ({
          id: `d-${index}`,
          label: decision.scope,
          scope: decision.scope as PendingAction["availableDecisions"][number]["scope"],
          value: null,
          risk: decision.risk,
          ...(decision.confirmationPhrase === undefined ? {} : { confirmationPhrase: decision.confirmationPhrase }),
        })),
      };
      expect(isQuickApprovable(action)).toBe(testCase.expected.quickApprovable);
    });
  }
});

describe("cancelable-states vectors", () => {
  interface CancelableCase { name: string; input: { state: string }; expected: { cancelable: boolean } }
  const { version, cases } = readVectors<CancelableCase>("cancelable-states.json");
  it("declares version 1", () => expect(version).toBe(1));
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(isCommandCancelable(testCase.input.state as TaskCommandState)).toBe(testCase.expected.cancelable);
    });
  }
});

describe("feed policy", () => {
  it("keeps the documented constants", () => {
    expect(FEED_MERGE_WINDOW_MS).toBe(6 * 60 * 60 * 1_000);
    expect(POST_VALUE).toEqual({ failure: 1, result: 2, decision: 3, attention: 3, progress: 4 });
    expect(CANCELABLE_COMMAND_STATES).toEqual(["queued"]);
    expect(BACKOFF_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(BACKOFF_JITTER_RATIO).toBe(0.2);
  });

  it("does not mutate the input posts array", () => {
    const posts = [
      toFeedPost({ id: "p2", kind: "progress", taskId: "t1", sessionId: null, createdAt: "2026-07-20T08:00:00.000Z", highlights: ["b"] }),
      toFeedPost({ id: "p1", kind: "progress", taskId: "t1", sessionId: null, createdAt: "2026-07-20T10:00:00.000Z", highlights: ["a"] }),
    ];
    const merged = mergeRoutinePosts(posts);
    expect(posts.map((post) => post.id)).toEqual(["p2", "p1"]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.highlights).toEqual(["a", "b"]);
  });

  it("compareFeedItems returns zero for equal keys", () => {
    expect(compareFeedItems(
      { priority: 3, createdAt: "2026-07-20T10:00:00.000Z" },
      { priority: 3, createdAt: "2026-07-20T10:00:00.000Z" },
    )).toBe(0);
  });
});

describe("backoff policy", () => {
  it("keeps jittered delays within ±20% of the scheduled base", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const base = BACKOFF_DELAYS_MS[Math.min(attempt, BACKOFF_DELAYS_MS.length - 1)]!;
      for (let sample = 0; sample < 50; sample += 1) {
        const delay = backoffDelayMs(attempt, random);
        expect(delay).toBeGreaterThanOrEqual(Math.round(base * (1 - BACKOFF_JITTER_RATIO)));
        expect(delay).toBeLessThanOrEqual(Math.round(base * (1 + BACKOFF_JITTER_RATIO)));
      }
    }
  });

  it("defaults to Math.random", () => {
    const delay = backoffDelayMs(0);
    expect(delay).toBeGreaterThanOrEqual(800);
    expect(delay).toBeLessThanOrEqual(1_200);
  });
});

describe("outbox policy", () => {
  it("accepts typed client commands", () => {
    const command: ClientCommand = { type: "task.follow_up", sessionId: "s-1", text: "继续", idempotencyKey: "k" };
    expect(semanticCommandKey(command)).toBe("task.follow_up:s-1:继续");
  });

  it("produces the same key for semantically equal action.decide commands", () => {
    const left: ClientCommand = { type: "action.decide", actionId: "a", sessionId: "s", decisionId: "approve", idempotencyKey: "1", input: { z: "2", a: "1" } };
    const right: ClientCommand = { ...left, idempotencyKey: "2", input: { a: "1", z: "2" } };
    expect(semanticCommandKey(left)).toBe(semanticCommandKey(right));
  });
});
