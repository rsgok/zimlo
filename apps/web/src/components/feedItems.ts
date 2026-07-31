import type { FeedPost, PendingAction, TaskCommand, TaskRecord, TaskReview } from "@zimlo/protocol";
import { compareFeedItems, isPostCovered, mergeRoutinePosts, postNeedsAction, postPriority } from "@zimlo/protocol";

export { mergeRoutinePosts };

export type FeedItem =
  | { type: "post"; id: string; createdAt: string; needsAction: boolean; unread: boolean; priority: number; settledReview?: boolean; post: FeedPost }
  | { type: "action"; id: string; createdAt: string; needsAction: true; unread: true; priority: 0; action: PendingAction }
  | { type: "command"; id: string; createdAt: string; needsAction: boolean; unread: true; priority: number; command: TaskCommand };

export function feedItemId(item: Pick<FeedItem, "type" | "id">): string {
  return `${item.type}:${item.id}`;
}

export function buildFeedItems(
  posts: FeedPost[],
  actions: PendingAction[],
  seenPostIds: string[] = [],
  commands: TaskCommand[] = [],
  dismissedFeedItemIds: string[] = [],
  tasks: TaskRecord[] = [],
  reviews: TaskReview[] = [],
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
  const reviewByPostId = new Map(reviews.map((review) => [review.postId, review]));
  return [
    ...mergeRoutinePosts(posts).map((post): FeedItem => {
      const review = reviewByPostId.get(post.id);
      const settledReview = Boolean(review && review.state !== "unreviewed");
      const unread = !settledReview && !seen.has(post.id);
      const task = taskById.get(post.taskId) ?? (post.sessionId ? taskBySession.get(post.sessionId) : undefined);
      const hasLinkedPendingAction = post.pendingActionIds.some((id) => pendingActionIds.has(id));
      const directReplyIsCurrent = post.pendingActionIds.length === 0
        && (!task || ["waiting_input", "user_review"].includes(task.state));
      const needsAction = postNeedsAction({
        actionRequired: post.actionRequired,
        hasLinkedPendingAction,
        directReplyIsCurrent,
        reviewState: review?.state ?? null,
      });
      const covered = isPostCovered({
        kind: post.kind,
        createdAt: post.createdAt,
        latestOutcomeCreatedAt: latestOutcomeByTask.get(post.sessionId ?? post.taskId) ?? null,
      });
      return {
      type: "post",
      id: post.id,
      createdAt: post.createdAt,
      needsAction,
      unread,
      ...(settledReview ? { settledReview: true } : {}),
      priority: postPriority({ kind: post.kind, needsAction, covered, unread }),
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
    .sort(compareFeedItems);
}
