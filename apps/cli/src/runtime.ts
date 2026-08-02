import { EventEmitter } from "node:events";
import os from "node:os";
import type { FeatureCapabilities, FeedPost, Host, PendingAction, ServerMessage, Session, TaskCommand, TaskRecord, TrustedWorkspace, UnifiedEvent } from "@zimlo/protocol";
import { uuidV7 } from "@zimlo/adapters";
import { projectNameForCwd } from "./project-context.js";
import { sanitizeEventPayload } from "./sanitization.js";
import { ZimloStore } from "./store.js";
import { titleSessionFromInput } from "./task-title.js";
import { PushService } from "./push-service.js";
import type { CloudService } from "./cloud-service.js";

export class RuntimeHub extends EventEmitter {
  readonly store: ZimloStore;
  readonly host: Host;
  private readonly push: PushService;
  private readonly cloud: CloudService | undefined;
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

  postFeed(post: FeedPost): { post: FeedPost; inserted: boolean } {
    const result = this.store.insertFeedPost(post);
    if (result.inserted) {
      this.send({ type: "feed.posted", post: result.post });
      if (result.post.projectId) {
        const project = this.store.getProject(result.post.projectId);
        if (project) this.send({ type: "project.updated", project });
      }
    }
    return result;
  }

  updateTask(task: TaskRecord): TaskRecord {
    const stored = this.store.upsertTask(task);
    this.send({ type: "task.updated", task: stored });
    if (stored.sessionId && stored.state === "failed") {
      this.push.notify("failure", stored.sessionId, this.store.getSession(stored.sessionId)?.title);
    }
    return stored;
  }

  updateTaskCommand(command: TaskCommand): TaskCommand {
    const stored = this.store.updateTaskCommand(command);
    this.send({ type: "task.command.updated", command: stored });
    return stored;
  }

  upsertAction(action: PendingAction): PendingAction {
    const stored = this.store.upsertAction(action);
    this.send({ type: "action.upsert", action: stored });
    if (stored.state === "pending" || stored.state === "submitted") {
      this.push.notify("approval", stored.sessionId, this.store.getSession(stored.sessionId)?.title, stored);
    }
    return stored;
  }

  resolveAction(action: PendingAction): void {
    const stored = this.store.upsertAction(action);
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

}
