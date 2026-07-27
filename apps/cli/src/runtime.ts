import { EventEmitter } from "node:events";
import type { FeedPost, PendingAction, ReviewBundle, ServerMessage, Session, TaskCommand, TaskRecord, TaskReview, TrustedWorkspace, UnifiedEvent } from "@zimlo/protocol";
import { projectNameForCwd } from "./project-context.js";
import { sanitizeEventPayload } from "./sanitization.js";
import { ZimloStore } from "./store.js";
import { titleSessionFromInput } from "./task-title.js";
import { PushService } from "./push-service.js";
import type { CloudService } from "./cloud-service.js";

export class RuntimeHub extends EventEmitter {
  readonly store: ZimloStore;
  private readonly push: PushService;
  lanApprovalsEnabled: boolean;

  constructor(store: ZimloStore, cloud?: CloudService) {
    super();
    this.store = store;
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
      if (result.post.kind === "result" && result.post.sessionId) {
        const reviewable = this.store.listTasks().some((task) => (
          task.sessionId === result.post.sessionId
          && (task.state === "user_review" || task.state === "completed")
        ));
        if (reviewable) this.ensureReview(result.post);
      }
    }
    return result;
  }

  updateTask(task: TaskRecord): TaskRecord {
    const stored = this.store.upsertTask(task);
    this.send({ type: "task.updated", task: stored });
    if (stored.sessionId && (stored.state === "user_review" || stored.state === "completed")) {
      const post = this.store.latestResultFeedPost(stored.sessionId);
      if (post) this.ensureReview(post);
    }
    if (stored.sessionId && stored.state === "failed") {
      this.push.notify("failure", stored.sessionId, this.store.getSession(stored.sessionId)?.title);
    }
    return stored;
  }

  updateReview(review: TaskReview): TaskReview {
    this.send({ type: "review.updated", review });
    return review;
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
      this.push.notify("approval", stored.sessionId, this.store.getSession(stored.sessionId)?.title);
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
    return this.store.listProjects()
      .filter((project) => project.primaryPath)
      .map((project) => ({
        id: project.id,
        label: project.name,
        path: project.primaryPath,
        providers: project.providers,
        lastUsedAt: project.lastUsedAt,
      }));
  }

  snapshot(deviceId = "") {
    const snapshot = this.store.snapshot(this.lanApprovalsEnabled, deviceId, this.workspaces());
    return { ...snapshot, sessions: snapshot.sessions.map((session) => this.withProject(session)) };
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

  private ensureReview(post: FeedPost): TaskReview | null {
    if (!post.sessionId) return null;
    const existing = this.store.getTaskReviewByPost(post.id);
    if (existing) return existing;
    const previous = this.store.listTaskReviews(post.sessionId)[0];
    const created = this.store.createTaskReview({
      taskId: post.taskId,
      sessionId: post.sessionId,
      postId: post.id,
      bundle: this.reviewBundle(post, previous?.createdAt),
      createdAt: post.createdAt,
    });
    this.send({ type: "review.updated", review: created });
    this.push.notify("review", created.sessionId, this.store.getSession(created.sessionId)?.title);
    return created;
  }

  private reviewBundle(post: FeedPost, after?: string): ReviewBundle {
    const events = post.sessionId ? this.store.listEvents(post.sessionId, 200) : [];
    const relevant = events.filter((event) => event.occurredAt <= post.createdAt && (!after || event.occurredAt > after));
    const sourceRank = { agent_reported: 0, hook: 1, app_server: 2 } as const;
    let evidenceSource: ReviewBundle["evidenceSource"] = "agent_reported";
    const changedFiles = new Set<string>();
    const tests: ReviewBundle["tests"] = [];
    let diffSummary: string | undefined;
    for (const event of relevant) {
      const source = event.source === "app_server" ? "app_server" : event.source === "hook" ? "hook" : "agent_reported";
      if (event.kind === "files_changed" && event.source !== "process") {
        if (sourceRank[source] > sourceRank[evidenceSource]) evidenceSource = source;
        for (const file of this.extractFilePaths(event.payload)) changedFiles.add(file);
        if (!diffSummary && this.payloadContainsDiff(event.payload)) diffSummary = "已捕获可归因的代码差异。";
      }
      if (event.kind === "tests_passed" || event.kind === "tests_failed") {
        if (sourceRank[source] > sourceRank[evidenceSource]) evidenceSource = source;
        tests.push({
          source,
          label: event.kind === "tests_passed" ? "验证通过" : "验证失败",
          detail: this.eventDetail(event.payload, event.kind === "tests_passed" ? "测试或构建已通过。" : "测试或构建未通过。"),
        });
      }
    }
    if (tests.length === 0 && post.proof) {
      tests.push({ source: "agent_reported", label: "Agent 报告", detail: post.proof });
    }
    const linkText = [post.takeaway, ...post.highlights, post.proof ?? ""].join(" ");
    const links = [...new Set(linkText.match(/https?:\/\/[^\s)\]}]+/gu) ?? [])].slice(0, 6)
      .flatMap((url) => {
        try {
          return [{ label: new URL(url).hostname, url }];
        } catch {
          return [];
        }
      });
    return {
      conclusion: post.headline,
      impact: post.takeaway,
      changedFiles: [...changedFiles].sort(),
      ...(diffSummary ? { diffSummary } : {}),
      tests,
      links,
      evidenceSource,
    };
  }

  private extractFilePaths(payload: unknown): string[] {
    if (!payload || typeof payload !== "object") return [];
    if (Array.isArray(payload)) return payload.flatMap((item) => this.extractFilePaths(item));
    const paths: string[] = [];
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (/^(?:path|file|filePath)$/u.test(key) && typeof value === "string" && value.length <= 500) paths.push(value);
      if (/^(?:files|changedFiles|paths)$/u.test(key) && Array.isArray(value)) {
        paths.push(...value.filter((item): item is string => typeof item === "string" && item.length <= 500));
      } else if (value && typeof value === "object") {
        paths.push(...this.extractFilePaths(value));
      }
    }
    return paths;
  }

  private eventDetail(payload: unknown, fallback: string): string {
    if (typeof payload === "string") return payload.slice(0, 500);
    if (!payload || typeof payload !== "object") return fallback;
    const value = payload as Record<string, unknown>;
    for (const key of ["summary", "result", "command", "detail"]) {
      if (typeof value[key] === "string") return value[key].slice(0, 500);
    }
    return fallback;
  }

}
