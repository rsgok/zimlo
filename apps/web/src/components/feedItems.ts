import type { FeedPost, PendingAction, TaskCommand } from "@zimlo/protocol";
import { compareFeedItems, isPostCovered, mergeRoutinePosts, postPriority } from "@zimlo/protocol";

export { mergeRoutinePosts };

export type FeedItem =
  | { type: "post"; id: string; createdAt: string; needsAction: boolean; unread: boolean; priority: number; post: FeedPost }
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
): FeedItem[] {
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
      const covered = isPostCovered({
        kind: post.kind,
        createdAt: post.createdAt,
        latestOutcomeCreatedAt: latestOutcomeByTask.get(post.sessionId ?? post.taskId) ?? null,
      });
      return {
      type: "post",
      id: post.id,
      createdAt: post.createdAt,
      needsAction: false,
      unread,
      priority: postPriority({ kind: post.kind, needsAction: false, covered, unread }),
      post,
      };
    }),
    ...actions
      .filter((action) => action.state === "pending")
      .map((action): FeedItem => ({ type: "action", id: action.actionId, createdAt: action.createdAt, needsAction: true, unread: true, priority: 0, action })),
    ...commands
      .filter((command) => command.kind === "create" && ["queued", "dispatching", "running", "failed"].includes(command.state) && command.sessionId === null)
      .map((command): FeedItem => ({ type: "command", id: command.id, createdAt: command.createdAt, needsAction: command.state === "failed", unread: true, priority: command.state === "failed" ? 0 : 5, command })),
  ].filter((item) => !dismissed.has(feedItemId(item)))
    .sort(compareFeedItems);
}
