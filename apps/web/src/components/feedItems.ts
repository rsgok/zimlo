import type { FeedPost, PendingAction, TaskCommand, TaskRecord } from "@zimlo/protocol";

export type FeedItem =
  | { type: "post"; id: string; createdAt: string; needsAction: boolean; unread: boolean; priority: number; post: FeedPost }
  | { type: "action"; id: string; createdAt: string; needsAction: true; unread: true; priority: 0; action: PendingAction }
  | { type: "command"; id: string; createdAt: string; needsAction: boolean; unread: true; priority: number; command: TaskCommand };

export function feedItemId(item: Pick<FeedItem, "type" | "id">): string {
  return `${item.type}:${item.id}`;
}

const POST_VALUE: Record<FeedPost["kind"], number> = { failure: 1, result: 2, decision: 3, attention: 3, progress: 4 };

export function mergeRoutinePosts(posts: FeedPost[]): FeedPost[] {
  const merged: FeedPost[] = [];
  const latestByKey = new Map<string, number>();
  for (const post of [...posts].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    if (!(["progress", "decision"] as FeedPost["kind"][]).includes(post.kind)) {
      merged.push(post);
      continue;
    }
    const key = `${post.sessionId ?? post.taskId}:${post.kind}`;
    const existingIndex = latestByKey.get(key);
    const existing = existingIndex === undefined ? undefined : merged[existingIndex];
    const withinWindow = existing && new Date(existing.createdAt).getTime() - new Date(post.createdAt).getTime() <= 6 * 60 * 60 * 1_000;
    if (!existing || !withinWindow) {
      latestByKey.set(key, merged.length);
      merged.push(post);
      continue;
    }
    merged[existingIndex!] = { ...existing, highlights: [...existing.highlights, ...post.highlights].filter((value, index, all) => all.indexOf(value) === index).slice(0, 2) };
  }
  return merged;
}

export function buildFeedItems(
  posts: FeedPost[],
  actions: PendingAction[],
  seenPostIds: string[] = [],
  commands: TaskCommand[] = [],
  dismissedFeedItemIds: string[] = [],
  tasks: TaskRecord[] = [],
): FeedItem[] {
  const linkedActionIds = new Set(posts.flatMap((post) => post.pendingActionIds));
  const pendingActionIds = new Set(actions.filter((action) => action.state === "pending").map((action) => action.actionId));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskBySession = new Map<string, TaskRecord>();
  for (const task of tasks) {
    if (!task.sessionId) continue;
    const current = taskBySession.get(task.sessionId);
    if (!current || task.updatedAt > current.updatedAt) taskBySession.set(task.sessionId, task);
  }
  const latestOutcomeByTask = new Map<string, string>();
  for (const post of posts) {
    if (!(post.kind === "result" || post.kind === "failure")) continue;
    const key = post.sessionId ?? post.taskId;
    const latest = latestOutcomeByTask.get(key);
    if (!latest || post.createdAt > latest) latestOutcomeByTask.set(key, post.createdAt);
  }
  const seen = new Set(seenPostIds);
  const dismissed = new Set(dismissedFeedItemIds);
  return [
    ...mergeRoutinePosts(posts).map((post): FeedItem => {
      const unread = !seen.has(post.id);
      const task = taskById.get(post.taskId) ?? (post.sessionId ? taskBySession.get(post.sessionId) : undefined);
      const hasLinkedPendingAction = post.pendingActionIds.some((id) => pendingActionIds.has(id));
      const directReplyIsCurrent = post.pendingActionIds.length === 0
        && (!task || ["waiting_input", "user_review"].includes(task.state));
      const needsAction = post.actionRequired && (hasLinkedPendingAction || directReplyIsCurrent);
      const covered = ["progress", "decision", "attention"].includes(post.kind)
        && (latestOutcomeByTask.get(post.sessionId ?? post.taskId) ?? "") > post.createdAt;
      return {
      type: "post",
      id: post.id,
      createdAt: post.createdAt,
      needsAction,
      unread,
      priority: needsAction ? 0 : POST_VALUE[post.kind] + (covered ? 6 : 0) + (unread ? 0 : 10),
      post,
      };
    }),
    ...actions
      .filter((action) => action.state === "pending" && !linkedActionIds.has(action.actionId))
      .map((action): FeedItem => ({ type: "action", id: action.actionId, createdAt: action.createdAt, needsAction: true, unread: true, priority: 0, action })),
    ...commands
      .filter((command) => command.kind === "create" && ["queued", "dispatching", "running", "failed"].includes(command.state) && command.sessionId === null)
      .map((command): FeedItem => ({ type: "command", id: command.id, createdAt: command.createdAt, needsAction: command.state === "failed", unread: true, priority: command.state === "failed" ? 0 : 5, command })),
  ].filter((item) => !dismissed.has(feedItemId(item)))
    .sort((left, right) => left.priority - right.priority
    || right.createdAt.localeCompare(left.createdAt));
}
