import type { FeedPost, PendingAction } from "@zimlo/protocol";

export type FeedItem =
  | { type: "post"; id: string; createdAt: string; needsAction: boolean; post: FeedPost }
  | { type: "action"; id: string; createdAt: string; needsAction: true; action: PendingAction };

export function buildFeedItems(posts: FeedPost[], actions: PendingAction[]): FeedItem[] {
  const linkedActionIds = new Set(posts.flatMap((post) => post.pendingActionIds));
  return [
    ...posts.map((post): FeedItem => ({ type: "post", id: post.id, createdAt: post.createdAt, needsAction: post.actionRequired, post })),
    ...actions
      .filter((action) => !linkedActionIds.has(action.actionId))
      .map((action): FeedItem => ({ type: "action", id: action.actionId, createdAt: action.createdAt, needsAction: true, action })),
  ].sort((left, right) => Number(right.needsAction) - Number(left.needsAction) || right.createdAt.localeCompare(left.createdAt));
}
