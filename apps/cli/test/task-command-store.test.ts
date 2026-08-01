import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES, type FeedPost, type TaskCommand } from "@zimlo/protocol";
import { RuntimeHub } from "../src/runtime.js";
import { isForeignKeyConstraintFailure, ZimloStore } from "../src/store.js";

const roots: string[] = [];

function createStore() {
  const root = mkdtempSync(join(tmpdir(), "zimlo-command-store-"));
  roots.push(root);
  return { root, store: new ZimloStore(join(root, "zimlo.db")) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("task command and per-device feed state", () => {
  it("classifies only SQLite foreign-key failures as stale receipt races", () => {
    expect(isForeignKeyConstraintFailure({ code: "ERR_SQLITE_ERROR", errcode: 787 })).toBe(true);
    expect(isForeignKeyConstraintFailure({ code: "ERR_SQLITE_ERROR", errcode: 5 })).toBe(false);
    expect(isForeignKeyConstraintFailure(new Error("foreign key"))).toBe(false);
  });

  it("persists queued work, recovers in-flight work, and deduplicates by device key", () => {
    const { root, store } = createStore();
    const command: TaskCommand = {
      id: "command-a",
      idempotencyKey: "device-a:same",
      kind: "create",
      provider: "codex",
      sessionId: null,
      workspaceId: "workspace-a",
      cwd: "/tmp/project",
      text: "修复登录问题",
      state: "running",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    expect(store.insertTaskCommand(command).inserted).toBe(true);
    expect(store.insertTaskCommand({ ...command, id: "command-b" }).inserted).toBe(false);
    store.close();

    const reopened = new ZimloStore(join(root, "zimlo.db"));
    expect(reopened.getTaskCommand("command-a")?.state).toBe("queued");
    reopened.close();
  });

  it("keeps read receipts and dismissals device-scoped and persists approval trust", () => {
    const { root, store } = createStore();
    const now = "2026-07-23T00:00:00.000Z";
    for (const id of ["device-a", "device-b"]) {
      store.upsertDevice({ id, name: id, keyBase64: "key", createdAt: now, lastSeenAt: now, revokedAt: null, isLocalAdmin: false, canApprove: false });
    }
    const post: FeedPost = {
      id: "post-a",
      taskId: "task-a",
      runId: "run-a",
      agentId: "codex",
      sessionId: null,
      kind: "result",
      template: "paper",
      headline: "完成",
      takeaway: "已经完成",
      highlights: [],
      actionRequired: false,
      actions: [],
      pendingActionIds: [],
      dedupeKey: "post-a",
      source: "agent",
      createdAt: now,
    };
    store.insertFeedPost(post);
    expect(store.markFeedSeen("device-a", "post-a")).toBe(true);
    expect(store.markFeedSeen("device-a", "post-a")).toBe(false);
    expect(store.markFeedSeen("device-a", "missing-post")).toBe(false);
    expect(store.markFeedSeen("missing-device", "post-a")).toBe(false);
    expect(store.listSeenPostIds("device-a")).toEqual(["post-a"]);
    expect(store.listSeenPostIds("device-b")).toEqual([]);
    expect(store.dismissFeedItem("device-a", "post:post-a")).toBe(true);
    expect(store.listDismissedFeedItemIds("device-a")).toEqual(["post:post-a"]);
    expect(store.listDismissedFeedItemIds("device-b")).toEqual([]);
    store.markTaskTimelineSeen("device-a", "session-a", "post:post-a");
    expect(store.listTaskTimelineCursors("device-a")).toEqual({ "session-a": "post:post-a" });
    expect(store.listTaskTimelineCursors("device-b")).toEqual({});
    store.setLanApprovalsEnabled(true);
    expect(store.setDeviceApproval("device-a", true)?.canApprove).toBe(true);
    store.close();

    const reopened = new ZimloStore(join(root, "zimlo.db"));
    expect(new RuntimeHub(reopened).lanApprovalsEnabled).toBe(true);
    expect(reopened.getDevice("device-a")?.canApprove).toBe(true);
    expect(reopened.getDevice("device-b")?.canApprove).toBe(false);
    expect(reopened.listDismissedFeedItemIds("device-a")).toEqual(["post:post-a"]);
    expect(reopened.snapshot(false, "device-a", []).dismissedFeedItemIds).toEqual(["post:post-a"]);
    expect(reopened.snapshot(false, "device-a", []).taskTimelineCursors).toEqual({ "session-a": "post:post-a" });
    reopened.close();
  });

  it("persists task pin and archive preferences across restarts", () => {
    const { root, store } = createStore();
    store.upsertSession({
      id: "session-a", provider: "codex", surface: "cli", providerSessionId: "provider-a", title: "Task A",
      cwd: "/tmp/project", transcriptPath: null, status: "idle", lastActivityAt: "2026-07-23T00:00:00.000Z",
      createdAt: "2026-07-23T00:00:00.000Z", activePid: null, processStartedAt: null, tty: null,
      correlationUncertain: false, capabilities: EMPTY_CAPABILITIES,
    });
    expect(store.setTaskPinned("session-a", true).pinnedAt).not.toBeNull();
    expect(store.setTaskArchived("session-a", true).archivedAt).not.toBeNull();
    store.close();

    const reopened = new ZimloStore(join(root, "zimlo.db"));
    expect(reopened.listTaskPreferences()).toEqual([
      expect.objectContaining({ sessionId: "session-a", pinnedAt: expect.any(String), archivedAt: expect.any(String) }),
    ]);
    expect(reopened.snapshot(false, "", []).taskPreferences).toHaveLength(1);
    reopened.close();
  });
});
