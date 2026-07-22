import { describe, expect, it } from "vitest";
import { isInternalZimloAction, normalizeFeedPost, normalizeSnapshot } from "./feedCompatibility";

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
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.dismissedFeedItemIds).toEqual([]);
    expect(snapshot.taskTimelineCursors).toEqual({});
  });

  it("marks sessions from an older Bridge with an unknown surface", () => {
    const snapshot = normalizeSnapshot({ sessions: [{ id: "legacy" }] } as never);
    expect(snapshot.sessions[0]?.surface).toBe("unknown");
  });

  it("hides stale recursive approvals for Zimlo's own control tools", () => {
    expect(isInternalZimloAction({ kind: "approval", detail: "mcp__zimlo__feed_post" })).toBe(true);
    expect(isInternalZimloAction({ kind: "approval", detail: "工具：mcp__zimlo__signal_transition" })).toBe(true);
    expect(isInternalZimloAction({ kind: "approval", detail: "命令：git push" })).toBe(false);
  });
});
