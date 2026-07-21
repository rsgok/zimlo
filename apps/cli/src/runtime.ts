import { EventEmitter } from "node:events";
import type { FeedPost, PendingAction, ServerMessage, Session, TaskRecord, UnifiedEvent } from "@zimlo/protocol";
import { sanitizeEventPayload } from "./sanitization.js";
import { ZimloStore } from "./store.js";

export class RuntimeHub extends EventEmitter {
  readonly store: ZimloStore;
  lanApprovalsEnabled = false;

  constructor(store: ZimloStore) {
    super();
    this.store = store;
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
    this.send({ type: "session.updated", session: stored });
    return stored;
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

  upsertAction(action: PendingAction): PendingAction {
    const stored = this.store.upsertAction(action);
    this.send({ type: "action.upsert", action: stored });
    const post = this.store.linkPendingAction(action.sessionId, action.actionId);
    if (post) this.send({ type: "feed.posted", post });
    return stored;
  }

  resolveAction(action: PendingAction): void {
    this.upsertAction(action);
  }

  setLanApprovals(enabled: boolean): void {
    this.lanApprovalsEnabled = enabled;
    this.send({ type: "lan.approvals.changed", enabled });
  }

  snapshot() {
    return this.store.snapshot(this.lanApprovalsEnabled);
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
