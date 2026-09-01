import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CAPABILITIES, type PendingAction, type Session, type TaskRecord } from "@zimlo/protocol";
import { createKeyPair, openPushRoute } from "@zimlo/protocol/crypto";
import type { CloudService } from "../src/cloud-service.js";
import {
  notificationSummaryForAction,
  notificationSummaryForPost,
  PushService,
  QUICK_APPROVE_PUSH_CATEGORY,
  shouldDeliverPush,
} from "../src/push-service.js";
import {
  approvalReminderDelayMs,
  FAILURE_PUSH_FALLBACK_DELAY_MS,
  RuntimeHub,
  STATUS_PUSH_COALESCE_DELAY_MS,
} from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";

function setup(showTaskTitle = false) {
  const store = new ZimloStore(":memory:");
  const now = "2026-07-28T00:00:00.000Z";
  store.upsertDevice({
    id: "device_phone",
    name: "iPhone",
    keyBase64: "unused",
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
    isLocalAdmin: false,
    canApprove: false,
    canManageTrust: false,
  });
  const routeKeys = createKeyPair();
  store.upsertPushDevice(
    "device_phone",
    "device_phone",
    Buffer.from(routeKeys.publicKey).toString("base64url"),
  );
  store.updateNotificationSettings("device_phone", {
    enabled: true,
    approvals: true,
    results: true,
    failures: true,
    criticalOnly: false,
    quietHoursEnabled: false,
    timeZoneOffsetMinutes: 0,
    showTaskTitle,
  });
  const sent: Array<Record<string, unknown>> = [];
  const service = new PushService(store, {
    enabled: true,
    sendPush: async (input) => {
      sent.push(input as unknown as Record<string, unknown>);
      return 200;
    },
  });
  return { store, routeKeys, sent, service };
}

describe("PushService", () => {
  it("sends actionable, result, and failure notifications with stable collapse ids", () => {
    const { store, sent, service } = setup();
    service.notify("approval", "session-a", "Private task");
    service.notify("result", "session-a", "Private task");
    service.notify("failure", "session-a", "Private task");

    expect(sent.map((input) => input.kind)).toEqual(["approval", "result", "failure"]);
    expect(sent.map((input) => input.collapseId)).toEqual([
      "session-a:action",
      "session-a:status",
      "session-a:status",
    ]);
    expect(sent.every((input) => JSON.stringify(input.alert).includes("Private task") === false)).toBe(true);
    store.close();
  });

  it("keeps the task title inside the encrypted route and hides it by default", () => {
    const hidden = setup(false);
    hidden.service.notify("failure", "session-a", "Private task");
    expect(openPushRoute(
      hidden.routeKeys.privateKey,
      hidden.sent[0]!.route as Parameters<typeof openPushRoute>[1],
    )).toEqual({ sessionId: "session-a" });
    hidden.store.close();

    const visible = setup(true);
    visible.service.notify("failure", "session-a", "Private task");
    expect(openPushRoute(
      visible.routeKeys.privateKey,
      visible.sent[0]!.route as Parameters<typeof openPushRoute>[1],
    )).toEqual({ sessionId: "session-a", taskTitle: "Private task" });
    visible.store.close();
  });

  it("keeps an editorial summary encrypted and never copies it into the APNs alert", () => {
    const hidden = setup(false);
    hidden.service.notify("result", "session-a", "Private task", undefined, "发布完成：测试全部通过");
    expect(openPushRoute(
      hidden.routeKeys.privateKey,
      hidden.sent[0]!.route as Parameters<typeof openPushRoute>[1],
    )).toEqual({ sessionId: "session-a" });
    hidden.store.close();

    const visible = setup(true);
    visible.service.notify("result", "session-a", "Private task", undefined, "发布完成：测试全部通过");
    expect(openPushRoute(
      visible.routeKeys.privateKey,
      visible.sent[0]!.route as Parameters<typeof openPushRoute>[1],
    )).toEqual({
      sessionId: "session-a",
      taskTitle: "Private task",
      summary: "发布完成：测试全部通过",
    });
    expect(JSON.stringify(visible.sent[0]!.alert)).not.toContain("发布完成");
    visible.store.close();
  });

  it("builds short redacted summaries only from editorial or structured fields", () => {
    const summary = notificationSummaryForPost({
      headline: "通知系统完成",
      takeaway: `测试通过，OPENAI_API_KEY=sk-proj_${"a".repeat(40)} ${"结果".repeat(80)}`,
    });
    expect(summary).toContain("通知系统完成：测试通过，OPENAI_API_KEY=[REDACTED]");
    expect(summary).not.toContain("sk-proj_");
    expect(Array.from(summary ?? "")).toHaveLength(120);
    expect(summary?.endsWith("…")).toBe(true);

    expect(notificationSummaryForAction(quickActionFixture({
      approvalContext: {
        category: "git_publish", projectId: null, cwd: "/tmp/project", segments: ["git push"],
        withinProject: true, reason: "识别为 git_publish", command: "git push",
      },
    }))).toBe("需要批准：发布 Git 变更");
  });

  it("respects the global and per-kind notification switches", () => {
    const { store, sent, service } = setup();
    store.updateNotificationSettings("device_phone", {
      enabled: true,
      approvals: false,
      results: false,
      failures: true,
      criticalOnly: false,
      quietHoursEnabled: false,
      timeZoneOffsetMinutes: 0,
      showTaskTitle: false,
    });
    service.notify("approval", "session-a");
    service.notify("result", "session-a");
    service.notify("failure", "session-a");
    expect(sent.map((input) => input.kind)).toEqual(["failure"]);

    store.updateNotificationSettings("device_phone", {
      enabled: false,
      approvals: true,
      results: true,
      failures: true,
      criticalOnly: false,
      quietHoursEnabled: false,
      timeZoneOffsetMinutes: 0,
      showTaskTitle: false,
    });
    service.notify("failure", "session-b");
    expect(sent).toHaveLength(1);
    store.close();
  });

  it("applies quiet hours and critical-only mode without hiding approvals or failures", () => {
    const { store } = setup();
    const settings = store.getNotificationSettings("device_phone");
    const quiet = { ...settings, enabled: true, quietHoursEnabled: true, timeZoneOffsetMinutes: 8 * 60 };
    const local2300 = new Date("2026-08-26T15:00:00.000Z");
    expect(shouldDeliverPush("result", quiet, local2300)).toBe(false);
    expect(shouldDeliverPush("approval", quiet, local2300)).toBe(true);
    expect(shouldDeliverPush("failure", quiet, local2300)).toBe(true);
    expect(shouldDeliverPush("result", { ...quiet, quietHoursEnabled: false, criticalOnly: true }, local2300)).toBe(false);
    store.close();
  });

  it("sends the real unread badge and records the latest APNs delivery", async () => {
    const { store, sent, service } = setup();
    store.upsertSession({
      id: "session-a", provider: "codex", surface: "cli", providerSessionId: "run-a",
      title: "Private task", cwd: "/tmp/project", transcriptPath: null, status: "waiting",
      lastActivityAt: "2026-07-28T00:00:00.000Z", createdAt: "2026-07-28T00:00:00.000Z",
      activePid: null, processStartedAt: null, tty: null, correlationUncertain: false,
      capabilities: EMPTY_CAPABILITIES,
    });
    const action = quickActionFixture();
    store.upsertAction(action);
    store.insertFeedPost({
      id: "post-unread", taskId: "task-a", runId: "run-a", agentId: "codex",
      sessionId: "session-a", kind: "result",
      presentation: { system: "editorial", theme: "ink_classic", layout: "field_note", typography: "serif", density: "airy", mediaPlacement: "none" },
      headline: "完成", takeaway: "结果可查看", highlights: [], blocks: [], dedupeKey: "unread-a", source: "agent",
      createdAt: "2026-07-28T00:00:01.000Z",
    });
    expect(store.notificationUnreadCount("device_phone")).toBe(2);
    store.markFeedSeen("device_phone", "post-unread");
    expect(store.notificationUnreadCount("device_phone")).toBe(1);
    service.notify("approval", action.sessionId, "Private task", action);
    expect(sent[0]!.badge).toBe(1);
    await Promise.resolve();
    expect(store.getPushDevice("device_phone")).toEqual(expect.objectContaining({
      environment: "production",
      lastDeliveryKind: "approval",
      lastDeliveryStatus: 200,
    }));
    store.close();
  });
});

function quickActionFixture(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    actionId: "action-1",
    sessionId: "session-a",
    kind: "approval",
    title: "允许执行命令？",
    detail: "git push",
    availableDecisions: [
      { id: "allow-once", label: "允许一次", scope: "once", value: null, risk: "low" },
      { id: "deny-1", label: "拒绝", scope: "deny", value: null, risk: "low" },
    ],
    expiresAt: "2099-01-01T00:00:00.000Z",
    state: "pending",
    createdAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("PushService quick approve", () => {
  function quickAction(overrides: Partial<PendingAction> = {}): PendingAction {
    return quickActionFixture(overrides);
  }

  function openRoute(routeKeys: ReturnType<typeof createKeyPair>, input: Record<string, unknown>) {
    return openPushRoute(routeKeys.privateKey, input.route as Parameters<typeof openPushRoute>[1]);
  }

  it("seals both decision ids and a plaintext category for quick-approvable actions", () => {
    const { store, routeKeys, sent, service } = setup();
    service.notify("approval", "session-a", "Private task", quickAction());
    expect(sent[0]!.category).toBe(QUICK_APPROVE_PUSH_CATEGORY);
    expect(openRoute(routeKeys, sent[0]!)).toEqual({
      version: 1,
      sessionId: "session-a",
      actionId: "action-1",
      decision: "allow-once",
      denyDecision: "deny-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.close();
  });

  it("falls back to the plain route when a phrase is required, expired, resolved, or not an approval", () => {
    const cases: Array<Partial<PendingAction>> = [
      { availableDecisions: [
        { id: "allow-once", label: "允许一次", scope: "once", value: null, risk: "high", confirmationPhrase: "我确认" },
        { id: "deny-1", label: "拒绝", scope: "deny", value: null, risk: "low" },
      ] },
      { expiresAt: "2020-01-01T00:00:00.000Z" },
      { state: "resolved" },
    ];
    for (const overrides of cases) {
      const { store, routeKeys, sent, service } = setup();
      service.notify("approval", "session-a", "Private task", quickAction(overrides));
      expect(sent[0]!.category).toBeUndefined();
      expect(openRoute(routeKeys, sent[0]!)).toEqual({ sessionId: "session-a" });
      store.close();
    }
    // Failure/result pushes never carry a category even if an action leaks in.
    const { store, sent, service } = setup();
    service.notify("failure", "session-a", "Private task", quickAction());
    expect(sent[0]!.category).toBeUndefined();
    store.close();
  });
});

describe("notification event policy", () => {
  afterEach(() => vi.useRealTimers());

  function runtimeSetup() {
    const store = new ZimloStore(":memory:");
    const now = "2026-08-26T00:00:00.000Z";
    const session: Session = {
      id: "session-a",
      provider: "codex",
      surface: "cli",
      providerSessionId: "run-a",
      title: "Private task",
      cwd: "/tmp/project-a",
      transcriptPath: null,
      status: "running",
      lastActivityAt: now,
      createdAt: now,
      activePid: null,
      processStartedAt: null,
      tty: null,
      correlationUncertain: false,
      capabilities: EMPTY_CAPABILITIES,
    };
    store.upsertSession(session);
    store.upsertDevice({
      id: "device_phone", name: "iPhone", keyBase64: "unused",
      createdAt: now, lastSeenAt: now, revokedAt: null,
      isLocalAdmin: false, canApprove: false, canManageTrust: false,
    });
    const keys = createKeyPair();
    store.upsertPushDevice("device_phone", "device_phone", Buffer.from(keys.publicKey).toString("base64url"));
    store.updateNotificationSettings("device_phone", {
      enabled: true, approvals: true, results: true, failures: true,
      criticalOnly: false, quietHoursEnabled: false, timeZoneOffsetMinutes: 0, showTaskTitle: false,
    });
    const sent: Array<Record<string, unknown>> = [];
    const cloud = {
      enabled: true,
      pushNotificationsAvailable: true,
      sendPush: async (input: unknown) => { sent.push(input as Record<string, unknown>); return 200; },
    } as unknown as CloudService;
    return { store, runtime: new RuntimeHub(store, cloud), sent };
  }

  it("coalesces newly inserted result and failure posts for the same task", async () => {
    vi.useFakeTimers();
    const { store, runtime, sent } = runtimeSetup();
    const post = {
      id: "post-result",
      taskId: "task-a",
      runId: "run-a",
      agentId: "codex",
      sessionId: "session-a",
      kind: "result" as const,
      presentation: { system: "editorial", theme: "ink_classic", layout: "field_note", typography: "serif", density: "airy", mediaPlacement: "none" } as const,
      headline: "任务完成",
      takeaway: "结果已经可以查看。",
      highlights: [],
      blocks: [],
      dedupeKey: "result-a",
      source: "agent" as const,
      createdAt: "2026-08-26T00:00:01.000Z",
    };
    runtime.postFeed(post);
    runtime.postFeed({ ...post, id: "post-result-retry" });
    runtime.postFeed({ ...post, id: "post-progress", kind: "progress", dedupeKey: "progress-a" });
    runtime.postFeed({ ...post, id: "post-failure", kind: "failure", dedupeKey: "failure-a" });

    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_COALESCE_DELAY_MS);
    expect(sent.map((input) => input.kind)).toEqual(["failure"]);
    store.close();
  });

  it("does not notify twice when the same action moves from pending to submitted", () => {
    const { store, runtime, sent } = runtimeSetup();
    const action: PendingAction = {
      actionId: "action-a",
      sessionId: "session-a",
      kind: "approval",
      title: "允许执行命令？",
      detail: "git push",
      availableDecisions: [],
      expiresAt: "2099-01-01T00:00:00.000Z",
      state: "pending",
      createdAt: "2026-08-26T00:00:01.000Z",
    };
    runtime.upsertAction(action);
    runtime.upsertAction({ ...action, state: "submitted" });

    expect(sent.map((input) => input.kind)).toEqual(["approval"]);
    store.close();
  });

  it("falls back to a failure notification when a failed task has no failure post", async () => {
    vi.useFakeTimers();
    const { store, runtime, sent } = runtimeSetup();
    const task: TaskRecord = {
      id: "task-a", runId: "run-a", agentId: "codex", sessionId: "session-a",
      state: "failed", reason: "process exited", updatedAt: "2026-08-26T00:00:01.000Z",
    };

    runtime.updateTask(task);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FAILURE_PUSH_FALLBACK_DELAY_MS + STATUS_PUSH_COALESCE_DELAY_MS);
    expect(sent.map((input) => input.kind)).toEqual(["failure"]);
    store.close();
  });

  it("uses the failure post instead of duplicating the delayed task-state fallback", async () => {
    vi.useFakeTimers();
    const { store, runtime, sent } = runtimeSetup();
    const task: TaskRecord = {
      id: "task-a", runId: "run-a", agentId: "codex", sessionId: "session-a",
      state: "failed", reason: "process exited", updatedAt: "2026-08-26T00:00:01.000Z",
    };
    const failurePost = {
      id: "post-failure", taskId: "task-a", runId: "run-a", agentId: "codex",
      sessionId: "session-a", kind: "failure" as const,
      presentation: { system: "swiss", theme: "safety_orange", layout: "alert", typography: "sans", density: "airy", mediaPlacement: "none" } as const,
      headline: "任务失败", takeaway: "请查看错误详情。", highlights: [], blocks: [],
      dedupeKey: "failure-a", source: "agent" as const, createdAt: "2026-08-26T00:00:02.000Z",
    };

    runtime.updateTask(task);
    runtime.postFeed(failurePost);
    await vi.advanceTimersByTimeAsync(FAILURE_PUSH_FALLBACK_DELAY_MS);
    expect(sent.map((input) => input.kind)).toEqual(["failure"]);

    runtime.updateTask({ ...task, state: "running", updatedAt: "2026-08-26T00:00:03.000Z" });
    runtime.updateTask({ ...task, updatedAt: "2026-08-26T00:00:04.000Z" });
    await vi.advanceTimersByTimeAsync(FAILURE_PUSH_FALLBACK_DELAY_MS);
    runtime.postFeed({ ...failurePost, id: "post-failure-late", dedupeKey: "failure-b" });
    await vi.advanceTimersByTimeAsync(STATUS_PUSH_COALESCE_DELAY_MS);
    expect(sent.map((input) => input.kind)).toEqual(["failure", "failure"]);
    store.close();
  });

  it("reminds an unresolved approval once near expiry and cancels after resolution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    const { store, runtime, sent } = runtimeSetup();
    const action = quickActionFixture({
      actionId: "action-reminder",
      expiresAt: "2026-08-26T00:10:00.000Z",
      createdAt: "2026-08-26T00:00:00.000Z",
    });
    expect(approvalReminderDelayMs(action)).toBe(5 * 60_000);
    runtime.upsertAction(action);
    expect(sent.map((input) => input.kind)).toEqual(["approval"]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sent.map((input) => input.kind)).toEqual(["approval", "approval_reminder"]);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sent.map((input) => input.kind)).toEqual(["approval", "approval_reminder"]);

    const second = { ...action, actionId: "action-cancelled", expiresAt: "2026-08-26T00:20:00.000Z" };
    runtime.upsertAction(second);
    runtime.resolveAction({ ...second, state: "resolved", resolvedAt: "2026-08-26T00:10:01.000Z" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent.filter((input) => input.kind === "approval_reminder")).toHaveLength(1);
    store.close();
  });
});
