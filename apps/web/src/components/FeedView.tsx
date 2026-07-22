import { useEffect, useRef, type ReactNode } from "react";
import type { ClientCommand, FeedPost, PendingAction, Session, TaskCommand } from "@zimlo/protocol";
import { FeedPostView } from "./FeedPostView";
import { ActionFeedCard } from "./ActionFeedCard";
import { buildFeedItems } from "./feedItems";
import { SwipeToTask } from "./SwipeToTask";
import { TaskCommandFailureCard } from "./TaskCommandFailureCard";

interface FeedViewProps {
  posts: FeedPost[];
  sessions: Session[];
  actions: PendingAction[];
  commands: TaskCommand[];
  seenPostIds: string[];
  send: (command: ClientCommand) => void;
  onOpen: (sessionId: string) => void;
  onOpenDiff: (sessionId: string) => void;
}

function SeenFeedPage({ children, postId, seen, onSeen }: { children: ReactNode; postId: string | null; seen: boolean; onSeen: (postId: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!postId || seen || !ref.current || typeof IntersectionObserver === "undefined") return;
    let timer: number | null = null;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && entry.intersectionRatio >= 0.75) {
        if (timer === null) timer = window.setTimeout(() => onSeen(postId), 1_000);
      } else if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }, { threshold: [0.75] });
    observer.observe(ref.current);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [postId, seen, onSeen]);
  return <section ref={ref} className="feed-page" aria-label="Feed 卡片">{children}</section>;
}

export function FeedView({ posts, sessions, actions, commands, seenPostIds, send, onOpen, onOpenDiff }: FeedViewProps) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const items = buildFeedItems(posts, actions, seenPostIds, commands);
  const attentionCount = items.filter((item) => item.needsAction).length;
  const unreadCount = items.filter((item) => item.unread && item.type === "post").length;
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
    <div className="feed-stage">
      <div className="feed-status" aria-label="Feed 状态">
        <span>{attentionCount} 件需要你</span><i aria-hidden="true" /> <span>{unreadCount} 条未读</span>
      </div>
      <div className="feed-timeline" aria-label="Agent Feed">
      {items.map((item, index) => (
        <SeenFeedPage
          key={`${item.type}:${item.id}`}
          postId={item.type === "post" ? item.post.id : null}
          seen={item.type === "post" ? seenPostIds.includes(item.post.id) : false}
          onSeen={(postId) => send({ type: "feed.seen", postId })}
        >
          <SwipeToTask sessionId={item.type === "post" ? item.post.sessionId : item.type === "action" ? item.action.sessionId : null} onOpen={onOpen}>
            {item.type === "post" ? <FeedPostView
              post={item.post}
              session={item.post.sessionId ? sessionById.get(item.post.sessionId) : undefined}
              actions={actions.filter((action) => item.post.pendingActionIds.includes(action.actionId))}
              send={send}
              onOpen={onOpen}
              onOpenDiff={onOpenDiff}
              position={index + 1}
              total={items.length}
            /> : item.type === "action" ? <ActionFeedCard
              action={item.action}
              session={sessionById.get(item.action.sessionId)}
              send={send}
              position={index + 1}
              total={items.length}
            /> : <TaskCommandFailureCard command={item.command} send={send} position={index + 1} total={items.length} />}
          </SwipeToTask>
        </SeenFeedPage>
      ))}
      </div>
    </div>
  );
}
