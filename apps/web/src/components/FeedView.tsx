import type { ClientCommand, FeedPost, PendingAction, Session } from "@zimlo/protocol";
import { FeedPostView } from "./FeedPostView";
import { ActionFeedCard } from "./ActionFeedCard";
import { buildFeedItems } from "./feedItems";
import { SwipeToTask } from "./SwipeToTask";

interface FeedViewProps {
  posts: FeedPost[];
  sessions: Session[];
  actions: PendingAction[];
  send: (command: ClientCommand) => void;
  onOpen: (sessionId: string) => void;
}

export function FeedView({ posts, sessions, actions, send, onOpen }: FeedViewProps) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const items = buildFeedItems(posts, actions);
  if (items.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-mark">Z</span>
        <h2>Feed 还没有帖子</h2>
        <p>原始任务会保留在 Tasks。只有值得你阅读的 Agent 判断、结果和待处理操作才会出现在这里。</p>
      </div>
    );
  }
  return (
    <div className="feed-timeline" aria-label="Agent Feed">
      {items.map((item, index) => (
        <section className="feed-page" key={`${item.type}:${item.id}`} aria-label={`${index + 1} / ${items.length}`}>
          <SwipeToTask sessionId={item.type === "post" ? item.post.sessionId : item.action.sessionId} onOpen={onOpen}>
            {item.type === "post" ? <FeedPostView
              post={item.post}
              session={item.post.sessionId ? sessionById.get(item.post.sessionId) : undefined}
              actions={actions.filter((action) => item.post.pendingActionIds.includes(action.actionId))}
              send={send}
              onOpen={onOpen}
              position={index + 1}
              total={items.length}
            /> : <ActionFeedCard
              action={item.action}
              session={sessionById.get(item.action.sessionId)}
              send={send}
              position={index + 1}
              total={items.length}
            />}
          </SwipeToTask>
        </section>
      ))}
    </div>
  );
}
