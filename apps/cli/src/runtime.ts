import { EventEmitter } from "node:events";
import os from "node:os";
import type { FeatureCapabilities, FeedPost, Host, PendingAction, ServerMessage, Session, TaskCommand, TaskRecord, TrustedWorkspace, UnifiedEvent } from "@zimlo/protocol";
import { uuidV7 } from "@zimlo/adapters";
import { projectNameForCwd } from "./project-context.js";
import { sanitizeEventPayload } from "./sanitization.js";
import { ZimloStore } from "./store.js";
import { titleSessionFromInput } from "./task-title.js";
import { notificationSummaryForPost, PushService } from "./push-service.js";
import type { CloudService } from "./cloud-service.js";

export const FAILURE_PUSH_FALLBACK_DELAY_MS = 5_000;
export const STATUS_PUSH_COALESCE_DELAY_MS = 2_000;
export const APPROVAL_REMINDER_LEAD_MS = 5 * 60_000;
export const APPROVAL_REMINDER_MIN_DELAY_MS = 60_000;
export const APPROVAL_REMINDER_MIN_REMAINING_MS = 90_000;

export function approvalReminderDelayMs(action: PendingAction, now = Date.now()): number | null {
  if (action.state !== "pending") return null;
  const expiresAt = Date.parse(action.expiresAt);
  if (!Number.isFinite(expiresAt)) return null;
  const remaining = expiresAt - now;
  if (remaining < APPROVAL_REMINDER_MIN_REMAINING_MS) return null;
  const remindAt = Math.max(now + APPROVAL_REMINDER_MIN_DELAY_MS, expiresAt - APPROVAL_REMINDER_LEAD_MS);
  const delay = remindAt - now;
  return remindAt < expiresAt && delay <= 2_147_483_647 ? delay : null;
}

export class RuntimeHub extends EventEmitter {
  readonly store: ZimloStore;
  readonly host: Host;
  private readonly push: PushService;
  private readonly cloud: CloudService | undefined;
  private readonly failureFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failureFeedTaskIds = new Set<string>();
  private readonly failureFallbackNotifiedTaskIds = new Set<string>();
  private readonly statusPushes = new Map<string, {
    kind: "result" | "failure";
    taskTitle?: string;
    summary?: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly approvalReminderTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly approvalReminderNotifiedActionIds = new Set<string>();
  lanApprovalsEnabled: boolean;

  constructor(store: ZimloStore, cloud?: CloudService) {
    super();
    this.store = store;
    const existingHostId = store.getMetadata("host_identity_v1");
    const hostId = existingHostId || `host_${uuidV7()}`;
    if (!existingHostId) store.setMetadata("host_identity_v1", hostId);
    const configuredName = process.env.ZIMLO_HOST_NAME?.trim();
    this.host = {
      id: hostId,
      name: (configuredName || os.hostname() || "Mac").slice(0, 120),
      platform: "macos",
      lastSeenAt: new Date().toISOString(),
    };
    this.cloud = cloud;
    this.push = new PushService(store, cloud ?? {
      enabled: false,
      sendPush: async () => 503,
    });
    this.lanApprovalsEnabled = store.lanApprovalsEnabled();
  }

  send(message: ServerMessage): void {
    this.emit("message", message);
  }

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.on("message", listener);
    return () => this.off("message", listener);
  }

  upsertSession(session: Session): Session {
    const stored = this.store.upsertSession(session);
    const presented = this.withProject(stored);
    this.send({ type: "session.updated", session: presented });
    if (presented.projectId) {
      const project = this.store.getProject(presented.projectId);
      if (project) this.send({ type: "project.updated", project });
    }
    return presented;
  }

  ingestEvent(event: UnifiedEvent, action?: PendingAction): UnifiedEvent {
    const sanitized: UnifiedEvent = { ...event, payload: sanitizeEventPayload(event.payload) };
    const result = this.store.insertEvent(sanitized);
    if (!result.inserted) return result.event;
    const session = this.store.getSession(result.event.sessionId);
    if (session) {
      const status: Session["status"] = result.event.kind === "needs_input" || result.event.kind === "needs_approval"
        ? "waiting"
        : result.event.kind === "failed"
          ? "failed"
          : result.event.kind === "completed"
            ? "completed"
            : result.event.kind === "session_ended"
              ? "ended"
              : session.status;
      const decisionScopes = action?.availableDecisions.map((decision) => decision.scope) ?? [];
      const hasAttributedDiff = result.event.kind === "files_changed"
        && result.event.source !== "process"
        && this.payloadContainsDiff(result.event.payload);
      this.upsertSession({
        ...session,
        status,
        lastActivityAt: result.event.occurredAt,
        capabilities: {
          ...session.capabilities,
          diffAvailable: session.capabilities.diffAvailable || hasAttributedDiff,
          approvableOnce: session.capabilities.approvableOnce || decisionScopes.includes("once"),
          approvableSession: session.capabilities.approvableSession || decisionScopes.includes("session"),
          approvablePersistent: session.capabilities.approvablePersistent || decisionScopes.includes("persistent"),
        },
      });
    }
    this.send({ type: "event.upsert", event: result.event });
    return result.event;
  }

  postFeed(post: FeedPost, coalesceProgressWithinMs = 0): { post: FeedPost; inserted: boolean; coalesced: boolean } {
    const result = this.store.insertFeedPost(post, coalesceProgressWithinMs);
    if (result.inserted || result.coalesced) {
      this.send({ type: "feed.posted", post: result.post });
      if (result.post.projectId) {
        const project = this.store.getProject(result.post.projectId);
        if (project) this.send({ type: "project.updated", project });
      }
    }
    if (result.inserted && result.post.sessionId && (result.post.kind === "result" || result.post.kind === "failure")) {
      const fallbackAlreadyNotified = result.post.kind === "failure"
        && this.failureFallbackNotifiedTaskIds.delete(result.post.taskId);
      if (result.post.kind === "failure") {
        this.cancelFailureFallback(result.post.taskId);
        this.failureFeedTaskIds.add(result.post.taskId);
      }
      if (!fallbackAlreadyNotified) {
        this.scheduleStatusPush(
          result.post.kind,
          result.post.sessionId,
          this.store.getSession(result.post.sessionId)?.title,
          notificationSummaryForPost(result.post),
        );
      }
    }
    return result;
  }

  updateTask(task: TaskRecord): TaskRecord {
    const previous = this.store.getTask(task.id);
    const stored = this.store.upsertTask(task);
    this.send({ type: "task.updated", task: stored });
    const becameNotifiableFailure = stored.state === "failed" && (
      previous?.state !== "failed" || (!previous.sessionId && Boolean(stored.sessionId))
    );
    if (becameNotifiableFailure) {
      this.failureFallbackNotifiedTaskIds.delete(stored.id);
      if (!this.failureFeedTaskIds.delete(stored.id)) this.scheduleFailureFallback(stored);
    } else if (stored.state !== "failed") {
      this.cancelFailureFallback(stored.id);
      this.failureFeedTaskIds.delete(stored.id);
      this.failureFallbackNotifiedTaskIds.delete(stored.id);
    }
    return stored;
  }

  updateTaskCommand(command: TaskCommand): TaskCommand {
    const stored = this.store.updateTaskCommand(command);
    this.send({ type: "task.command.updated", command: stored });
    return stored;
  }

  upsertAction(action: PendingAction): PendingAction {
    const previous = this.store.getAction(action.actionId);
    const stored = this.store.upsertAction(action);
    this.send({ type: "action.upsert", action: stored });
    if (
      (stored.state === "pending" || stored.state === "submitted")
      && previous?.state !== "pending"
      && previous?.state !== "submitted"
    ) {
      this.push.notify("approval", stored.sessionId, this.store.getSession(stored.sessionId)?.title, stored);
    }
    if (stored.state === "pending") this.scheduleApprovalReminder(stored);
    else this.cancelApprovalReminder(stored.actionId);
    return stored;
  }

  resolveAction(action: PendingAction): void {
    const stored = this.store.upsertAction(action);
    this.cancelApprovalReminder(stored.actionId);
    this.send({ type: "action.upsert", action: stored });
  }

  setLanApprovals(enabled: boolean): void {
    this.lanApprovalsEnabled = enabled;
    this.store.setLanApprovalsEnabled(enabled);
    this.send({ type: "lan.approvals.changed", enabled });
  }

  workspaces(): TrustedWorkspace[] {
    return this.store.listProjects()
      .filter((project) => project.primaryPath)
      .map((project) => ({
        id: project.id,
        hostId: this.host.id,
        label: project.name,
        path: project.primaryPath,
        providers: project.providers,
        lastUsedAt: project.lastUsedAt,
      }));
  }

  snapshot(deviceId = "") {
    const snapshot = this.store.snapshot(this.lanApprovalsEnabled, deviceId, this.workspaces());
    return {
      ...snapshot,
      host: { ...this.host, lastSeenAt: new Date().toISOString() },
      features: this.features(),
      projects: snapshot.projects.map((project) => ({ ...project, hostId: this.host.id })),
      sessions: snapshot.sessions.map((session) => ({ ...this.withProject(session), hostId: this.host.id })),
      posts: snapshot.posts.map((post) => ({ ...post, hostId: this.host.id })),
      materials: snapshot.materials.map((material) => ({ ...material, hostId: this.host.id })),
      tasks: snapshot.tasks.map((task) => ({ ...task, hostId: this.host.id })),
      commands: snapshot.commands.map((command) => ({ ...command, hostId: this.host.id })),
      actions: snapshot.actions.map((action) => ({ ...action, hostId: this.host.id })),
      taskPreferences: snapshot.taskPreferences.map((preference) => ({ ...preference, hostId: this.host.id })),
      trustPolicies: snapshot.trustPolicies.map((policy) => ({ ...policy, hostId: this.host.id })),
      trustAudit: snapshot.trustAudit.map((entry) => ({ ...entry, hostId: this.host.id })),
    };
  }

  features(): FeatureCapabilities {
    return {
      projectTrustPolicy: true,
      pushNotifications: this.cloud?.pushNotificationsAvailable === true,
      remoteSync: this.cloud?.enabled === true,
      multiHost: true,
    };
  }

  private withProject(session: Session): Session {
    const titled = titleSessionFromInput(session, this.store.firstTaskInput(session.id));
    const project = titled.projectId ? this.store.getProject(titled.projectId) : null;
    return { ...titled, projectName: project?.name ?? projectNameForCwd(session.cwd) };
  }

  private payloadContainsDiff(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    if (Array.isArray(payload)) return payload.some((value) => this.payloadContainsDiff(value));
    const value = payload as Record<string, unknown>;
    return Object.entries(value).some(([key, child]) => {
      return /^(?:diff|patch|changes)$/iu.test(key) || this.payloadContainsDiff(child);
    });
  }

  private scheduleFailureFallback(task: TaskRecord): void {
    if (!task.sessionId) return;
    this.cancelFailureFallback(task.id);
    const timer = setTimeout(() => {
      this.failureFallbackTimers.delete(task.id);
      const current = this.store.getTask(task.id);
      if (!current?.sessionId || current.state !== "failed" || this.failureFeedTaskIds.has(task.id)) return;
      this.failureFallbackNotifiedTaskIds.add(task.id);
      this.scheduleStatusPush(
        "failure",
        current.sessionId,
        this.store.getSession(current.sessionId)?.title,
      );
    }, FAILURE_PUSH_FALLBACK_DELAY_MS);
    timer.unref();
    this.failureFallbackTimers.set(task.id, timer);
  }

  private cancelFailureFallback(taskId: string): void {
    const timer = this.failureFallbackTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.failureFallbackTimers.delete(taskId);
  }

  private scheduleStatusPush(
    kind: "result" | "failure",
    sessionId: string,
    taskTitle?: string,
    summary?: string,
  ): void {
    const existing = this.statusPushes.get(sessionId);
    if (existing) {
      if (kind === "failure") {
        existing.kind = "failure";
        if (summary) existing.summary = summary;
      } else if (existing.kind !== "failure" && summary) {
        existing.summary = summary;
      }
      if (taskTitle) existing.taskTitle = taskTitle;
      return;
    }
    const timer = setTimeout(() => {
      const pending = this.statusPushes.get(sessionId);
      if (!pending) return;
      this.statusPushes.delete(sessionId);
      this.push.notify(pending.kind, sessionId, pending.taskTitle, undefined, pending.summary);
    }, STATUS_PUSH_COALESCE_DELAY_MS);
    timer.unref();
    this.statusPushes.set(sessionId, {
      kind,
      ...(taskTitle ? { taskTitle } : {}),
      ...(summary ? { summary } : {}),
      timer,
    });
  }

  private scheduleApprovalReminder(action: PendingAction): void {
    if (this.approvalReminderNotifiedActionIds.has(action.actionId)) return;
    if (this.approvalReminderTimers.has(action.actionId)) return;
    const delay = approvalReminderDelayMs(action);
    if (delay === null) return;
    const timer = setTimeout(() => {
      this.approvalReminderTimers.delete(action.actionId);
      const current = this.store.getAction(action.actionId);
      if (!current || current.state !== "pending" || Date.parse(current.expiresAt) <= Date.now()) return;
      this.approvalReminderNotifiedActionIds.add(action.actionId);
      this.push.notify(
        "approval_reminder",
        current.sessionId,
        this.store.getSession(current.sessionId)?.title,
        current,
      );
    }, delay);
    timer.unref();
    this.approvalReminderTimers.set(action.actionId, timer);
  }

  private cancelApprovalReminder(actionId: string): void {
    const timer = this.approvalReminderTimers.get(actionId);
    if (timer) clearTimeout(timer);
    this.approvalReminderTimers.delete(actionId);
  }

}
