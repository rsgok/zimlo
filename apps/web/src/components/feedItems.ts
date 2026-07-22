import type { FeedPost, PendingAction, TaskCommand } from "@zimlo/protocol";

export type FeedItem =
  | { type: "post"; id: string; createdAt: string; needsAction: boolean; unread: boolean; post: FeedPost }
  | { type: "action"; id: string; createdAt: string; needsAction: true; unread: true; action: PendingAction }
  | { type: "command"; id: string; createdAt: string; needsAction: true; unread: true; command: TaskCommand };

export function buildFeedItems(posts: FeedPost[], actions: PendingAction[], seenPostIds: string[] = [], commands: TaskCommand[] = []): FeedItem[] {
  const linkedActionIds = new Set(posts.flatMap((post) => post.pendingActionIds));
  const seen = new Set(seenPostIds);
  return [
    ...posts.map((post): FeedItem => ({
      type: "post",
      id: post.id,
      createdAt: post.createdAt,
      needsAction: post.actionRequired && post.pendingActionIds.length > 0,
      unread: !seen.has(post.id),
      post,
    })),
    ...actions
      .filter((action) => action.state === "pending" && !linkedActionIds.has(action.actionId))
      .map((action): FeedItem => ({ type: "action", id: action.actionId, createdAt: action.createdAt, needsAction: true, unread: true, action })),
    ...commands
      .filter((command) => command.kind === "create" && command.state === "failed" && command.sessionId === null)
      .map((command): FeedItem => ({ type: "command", id: command.id, createdAt: command.createdAt, needsAction: true, unread: true, command })),
  ].sort((left, right) => Number(right.needsAction) - Number(left.needsAction)
    || Number(right.unread) - Number(left.unread)
    || right.createdAt.localeCompare(left.createdAt));
}
