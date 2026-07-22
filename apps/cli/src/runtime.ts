import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { FeedPost, PendingAction, ServerMessage, Session, TaskCommand, TaskRecord, TrustedWorkspace, UnifiedEvent } from "@zimlo/protocol";
import { projectContextForCwd, projectNameForCwd } from "./project-context.js";
import { sanitizeEventPayload } from "./sanitization.js";
import { ZimloStore } from "./store.js";
import { titleSessionFromInput } from "./task-title.js";

export class RuntimeHub extends EventEmitter {
  readonly store: ZimloStore;
  lanApprovalsEnabled: boolean;

  constructor(store: ZimloStore) {
    super();
    this.store = store;
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
    if (result.inserted) this.send({ type: "feed.posted", post: result.post });
    return result;
  }

  updateTask(task: TaskRecord): TaskRecord {
    const stored = this.store.upsertTask(task);
    this.send({ type: "task.updated", task: stored });
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
      const post = this.store.linkPendingAction(action.sessionId, action.actionId);
      if (post) this.send({ type: "feed.posted", post });
    }
    return stored;
  }

  resolveAction(action: PendingAction): void {
    const stored = this.store.upsertAction(action);
    this.send({ type: "action.upsert", action: stored });
    for (const post of this.store.unlinkPendingAction(action.actionId)) {
      this.send({ type: "feed.posted", post });
    }
  }

  setLanApprovals(enabled: boolean): void {
    this.lanApprovalsEnabled = enabled;
    this.store.setLanApprovalsEnabled(enabled);
    this.send({ type: "lan.approvals.changed", enabled });
  }

  workspaces(): TrustedWorkspace[] {
    const byRoot = new Map<string, TrustedWorkspace>();
    for (const session of this.store.listSessions()) {
      if (!session.cwd) continue;
      const project = projectContextForCwd(session.cwd);
      const path = resolve(project?.root ?? session.cwd);
      if (["/", homedir(), dirname(homedir())].includes(path)) continue;
      const existing = byRoot.get(path);
      const providers = existing ? new Set(existing.providers) : new Set<Session["provider"]>();
      providers.add(session.provider);
      byRoot.set(path, {
        id: `workspace:${createHash("sha256").update(path).digest("hex").slice(0, 20)}`,
        label: project?.name ?? path.split("/").filter(Boolean).at(-1) ?? path,
        path,
        providers: [...providers],
        lastUsedAt: existing && existing.lastUsedAt > session.lastActivityAt ? existing.lastUsedAt : session.lastActivityAt,
      });
    }
    return [...byRoot.values()].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt)).slice(0, 50);
  }

  snapshot(deviceId = "") {
    const snapshot = this.store.snapshot(this.lanApprovalsEnabled, deviceId, this.workspaces());
    return { ...snapshot, sessions: snapshot.sessions.map((session) => this.withProject(session)) };
  }

  private withProject(session: Session): Session {
    const titled = titleSessionFromInput(session, this.store.firstTaskInput(session.id));
    return { ...titled, projectName: projectNameForCwd(session.cwd) };
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
