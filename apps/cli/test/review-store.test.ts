import { describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES, type FeedPost, type ReviewBundle, type Session } from "@zimlo/protocol";
import { ZimloStore } from "../src/store.js";

const bundle: ReviewBundle = {
  conclusion: "结果完成",
  impact: "用户现在可以审阅结果。",
  changedFiles: ["src/a.ts"],
  tests: [{ source: "app_server", label: "Tests", detail: "1 passed" }],
  links: [],
  evidenceSource: "app_server",
};

function seedReviewSource(store: ZimloStore, postId: string, createdAt: string) {
  if (!store.getSession("session-a")) {
    const session: Session = {
      id: "session-a",
      provider: "codex",
      surface: "cli",
      providerSessionId: "run-a",
      title: "Review",
      cwd: "/tmp",
      transcriptPath: null,
      status: "waiting",
      lastActivityAt: createdAt,
      createdAt,
      activePid: null,
      processStartedAt: null,
      tty: null,
      correlationUncertain: false,
      capabilities: EMPTY_CAPABILITIES,
    };
    store.upsertSession(session);
  }
  const post: FeedPost = {
    id: postId,
    taskId: "task-a",
    runId: "run-a",
    agentId: "codex",
    sessionId: "session-a",
    kind: "result",
    template: "paper",
    headline: "结果完成",
    takeaway: "可以审阅",
    highlights: [],
    actionRequired: false,
    actions: [],
    pendingActionIds: [],
    dedupeKey: postId,
    source: "agent",
    createdAt,
  };
  store.insertFeedPost(post);
}

describe("task review persistence", () => {
  it("supersedes an unreviewed version and keeps prior decisions", () => {
    const store = new ZimloStore(":memory:");
    seedReviewSource(store, "post-a", "2026-07-26T00:00:00.000Z");
    const first = store.createTaskReview({
      taskId: "task-a",
      sessionId: "session-a",
      postId: "post-a",
      bundle,
      createdAt: "2026-07-26T00:00:00.000Z",
    });
    const accepted = store.respondToTaskReview({
      reviewId: first.id,
      decision: "accept",
      deviceId: "device-a",
      updatedAt: "2026-07-26T00:01:00.000Z",
    });
    seedReviewSource(store, "post-b", "2026-07-26T00:02:00.000Z");
    const second = store.createTaskReview({
      taskId: "task-a",
      sessionId: "session-a",
      postId: "post-b",
      bundle: { ...bundle, conclusion: "结果更新" },
      createdAt: "2026-07-26T00:02:00.000Z",
    });
    seedReviewSource(store, "post-c", "2026-07-26T00:03:00.000Z");
    const third = store.createTaskReview({
      taskId: "task-a",
      sessionId: "session-a",
      postId: "post-c",
      bundle: { ...bundle, conclusion: "再次更新" },
      createdAt: "2026-07-26T00:03:00.000Z",
    });

    expect(accepted).toMatchObject({ state: "accepted", version: 1 });
    expect(store.getTaskReview(second.id)).toMatchObject({ state: "superseded", version: 2 });
    expect(third).toMatchObject({ state: "unreviewed", version: 3 });
    expect(store.listTaskReviews("session-a").map((review) => review.state)).toEqual([
      "unreviewed",
      "superseded",
      "accepted",
    ]);
    store.close();
  });

  it("uses private conservative notification defaults", () => {
    const store = new ZimloStore(":memory:");
    expect(store.getNotificationSettings("device-a")).toMatchObject({
      enabled: false,
      approvals: true,
      failures: true,
      reviews: true,
      showTaskTitle: false,
    });
    store.close();
  });
});
