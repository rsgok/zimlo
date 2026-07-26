import { useEffect, useRef, type ReactNode } from "react";
import type { ClientCommand, FeedPost, PendingAction, Project, Session, TaskCommand, TaskRecord, TaskReview } from "@zimlo/protocol";
import { FeedPostView } from "./FeedPostView";
import { ActionFeedCard } from "./ActionFeedCard";
import { buildFeedItems, feedItemId, type FeedItem } from "./feedItems";
import { SwipeToTask } from "./SwipeToTask";
import { TaskCommandFailureCard } from "./TaskCommandFailureCard";

interface FeedViewProps {
  projects: Project[];
  posts: FeedPost[];
  sessions: Session[];
  actions: PendingAction[];
  commands: TaskCommand[];
  tasks: TaskRecord[];
  reviews?: TaskReview[] | undefined;
  seenPostIds: string[];
  dismissedFeedItemIds: string[];
  send: (command: ClientCommand) => boolean;
  onOpen: (sessionId: string) => void;
  onOpenProject: (projectId: string) => void;
  onNewTask: () => void;
}

export function currentSessionPriority(item: FeedItem): number {
  return item.priority - (item.unread ? 0 : 10);
}

export function updateCurrentCohort(cohort: Map<string, boolean>, items: FeedItem[]): void {
  for (const item of items) {
    const key = feedItemId(item);
    const current = cohort.get(key);
    if (current === undefined) cohort.set(key, item.unread || item.needsAction);
    else if (current && item.type === "post" && item.settledReview) cohort.set(key, false);
    else if (!current && item.needsAction) cohort.set(key, true);
  }
}

function SeenFeedPage({ children, postId, seen, onSeen, pageRef, historical = false }: {
  children: ReactNode;
  postId: string | null;
  seen: boolean;
  onSeen: (postId: string) => void;
  pageRef?: { current: HTMLElement | null } | undefined;
  historical?: boolean;
}) {
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
  return <section ref={(node) => {
    ref.current = node;
    if (pageRef) pageRef.current = node;
  }} className={`feed-page ${historical ? "feed-history-page" : ""}`} aria-label={historical ? "历史 Feed 卡片" : "Feed 卡片"}>{children}</section>;
}

export function FeedView({ projects, posts, sessions, actions, commands, tasks, reviews = [], seenPostIds, dismissedFeedItemIds, send, onOpen, onOpenProject, onNewTask }: FeedViewProps) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const items = buildFeedItems(posts, actions, seenPostIds, commands, dismissedFeedItemIds, tasks, reviews);
  const currentCohort = useRef(new Map<string, boolean>());
  const historyPage = useRef<HTMLElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const positionedOnFirstCard = useRef(false);
  updateCurrentCohort(currentCohort.current, items);
  const currentItems = items
    .filter((item) => currentCohort.current.get(feedItemId(item)))
    .sort((left, right) => currentSessionPriority(left) - currentSessionPriority(right) || right.createdAt.localeCompare(left.createdAt));
  const historyItems = items
    .filter((item) => !currentCohort.current.get(feedItemId(item)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  useEffect(() => {
    if (positionedOnFirstCard.current || currentItems.length === 0 || !timelineRef.current) return;
    positionedOnFirstCard.current = true;
    const frame = window.requestAnimationFrame(() => {
      if (timelineRef.current) timelineRef.current.scrollTop = 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentItems.length]);

  const renderItem = (item: FeedItem, historical = false, index = -1) => {
    const position = historical ? null : index + 1;
    return (
      <SeenFeedPage
        key={feedItemId(item)}
        postId={item.type === "post" ? item.post.id : null}
        seen={item.type === "post" ? seenPostIds.includes(item.post.id) : false}
        onSeen={(postId) => send({ type: "feed.seen", postId })}
        pageRef={historical && index === 0 ? historyPage : undefined}
        historical={historical}
      >
        <SwipeToTask
          sessionId={item.type === "post" ? item.post.sessionId : item.type === "action" ? item.action.sessionId : null}
          onOpen={onOpen}
          onDismiss={() => send({ type: "feed.dismiss", itemId: feedItemId(item) })}
        >
          {historical && <span className="history-label">历史</span>}
          {item.type === "post" ? <FeedPostView
            post={item.post}
            session={item.post.sessionId ? sessionById.get(item.post.sessionId) : undefined}
            project={item.post.projectId ? projectById.get(item.post.projectId) : undefined}
            actions={actions.filter((action) => item.post.pendingActionIds.includes(action.actionId))}
            review={reviews.find((review) => review.postId === item.post.id)}
            send={send}
            onOpenProject={onOpenProject}
            needsAction={item.needsAction}
            position={position}
            total={currentItems.length}
          /> : item.type === "action" ? <ActionFeedCard
            action={item.action}
            session={sessionById.get(item.action.sessionId)}
            send={send}
            position={position}
            total={currentItems.length}
          /> : <TaskCommandFailureCard command={item.command} send={send} position={position} total={currentItems.length} />}
        </SwipeToTask>
      </SeenFeedPage>
    );
  };

  return (
    <div className="feed-stage">
      <div ref={timelineRef} className="feed-timeline" aria-label="Agent Feed">
        {currentItems.map((item, index) => renderItem(item, false, index))}
        <section className="feed-page feed-finished-page" aria-label="当前 Feed 已看完">
          <div className="feed-finished-card">
            <div className="feed-finished-status">
              <span className="empty-mark">✓</span>
              <p className="eyebrow">YOU'RE ALL CAUGHT UP</p>
            </div>
            <h2>{currentItems.length === 0 && historyItems.length === 0 ? "Feed 已经清空" : "当前更新已经看完"}</h2>
            <div>
              <button className="primary-button" onClick={onNewTask}>＋ 新任务</button>
              {historyItems.length > 0 && <button className="secondary-button" onClick={() => historyPage.current?.scrollIntoView({ behavior: "smooth" })}>继续看历史 ↓</button>}
            </div>
          </div>
        </section>
        {historyItems.map((item, index) => renderItem(item, true, index))}
      </div>
    </div>
  );
}
