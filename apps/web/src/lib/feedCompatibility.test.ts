import { describe, expect, it } from "vitest";
import { normalizeFeedPost, normalizeSnapshot } from "./feedCompatibility";

describe("Feed compatibility", () => {
  it("maps a legacy Agent post to the V2 reading model", () => {
    expect(normalizeFeedPost({
      id: "legacy-agent",
      taskId: "task-a",
      runId: "run-a",
      agentId: "codex",
      sessionId: "session-a",
      kind: "progress",
      title: "旧标题",
      body: "旧正文",
      actionRequired: false,
      actions: [],
      pendingActionIds: [],
      dedupeKey: "legacy-agent",
      source: "agent",
      createdAt: "2026-07-21T00:00:00.000Z",
    })).toMatchObject({
      template: "grid",
      headline: "旧标题",
      takeaway: "旧正文",
      highlights: [],
      source: "agent",
    });
  });

  it("removes legacy user instructions and fills missing snapshot collections", () => {
    const snapshot = normalizeSnapshot({
      sessions: [],
      cards: [],
      posts: [
        { id: "prompt", source: "user", kind: "instruction", title: "原始 Prompt" },
        { id: "agent", source: "agent", kind: "result", title: "完成", body: "已经完成" },
      ],
      actions: [],
      sequence: 1,
      lanApprovalsEnabled: false,
    } as never);

    expect(snapshot.posts).toHaveLength(1);
    expect(snapshot.posts[0]).toMatchObject({ id: "agent", headline: "完成", template: "paper" });
    expect(snapshot.tasks).toEqual([]);
  });
});
