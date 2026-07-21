import type { ClientCommand, FeedPost, PendingAction, Session } from "@zimlo/protocol";
import { FeedPostView } from "./FeedPostView";

interface FeedViewProps {
  posts: FeedPost[];
  sessions: Session[];
  actions: PendingAction[];
  send: (command: ClientCommand) => void;
  onOpen: (sessionId: string) => void;
}

export function FeedView({ posts, sessions, actions, send, onOpen }: FeedViewProps) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const sorted = [...posts].sort((left, right) => Number(right.actionRequired) - Number(left.actionRequired) || right.createdAt.localeCompare(left.createdAt));
  if (sorted.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-mark">Z</span>
        <h2>Feed 还没有帖子</h2>
        <p>Session 会自动出现在 Tasks，但 Zimlo 不会把日志自动摘要成帖子。Agent 只有在明确调用 feed.post 后，内容才会出现在这里。</p>
      </div>
    );
  }
  return (
    <div className="feed-timeline" aria-label="Agent Feed">
      {sorted.map((post, index) => (
        <section className="feed-page" key={post.id} aria-label={`${index + 1} / ${sorted.length}`}>
        <FeedPostView
          post={post}
          session={post.sessionId ? sessionById.get(post.sessionId) : undefined}
          actions={actions.filter((action) => post.pendingActionIds.includes(action.actionId))}
          send={send}
          onOpen={onOpen}
          position={index + 1}
          total={sorted.length}
        />
        </section>
      ))}
    </div>
  );
}
