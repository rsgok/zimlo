import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ClientCommand, FeedPost, PendingAction, Project, Session, TaskCommand, TaskRecord, TaskReview } from "@zimlo/protocol";
import { FeedPostView } from "./FeedPostView";
import { ActionFeedCard } from "./ActionFeedCard";
import { buildFeedItems, feedItemId, type FeedItem } from "./feedItems";
import {
  applyDismissOverrides,
  CAUGHT_UP_KEY,
  captureAnchor,
  captureInitialAnchor,
  clearFresh,
  createFeedSequence,
  reconcileFeedSequence,
  restoreScrollTop,
  type FeedAnchor,
  type FeedPageLayout,
} from "./feedSequence";
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
  onRequestUndo?: ((label: string, undo: () => void) => void) | undefined;
}

const HISTORY_BATCH = 20;

function SeenFeedPage({ children, postId, seen, onSeen, pageRef, feedKey, historical = false }: {
  children: ReactNode;
  postId: string | null;
  seen: boolean;
  onSeen: (postId: string) => void;
  pageRef?: { current: HTMLElement | null } | undefined;
  feedKey: string;
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
  return <section
    ref={(node) => {
      ref.current = node;
      if (pageRef) pageRef.current = node;
    }}
    className={`feed-page ${historical ? "feed-history-page" : ""}`}
    aria-label={historical ? "历史 Feed 卡片" : "Feed 卡片"}
    data-feed-key={feedKey}
  >{children}</section>;
}

export function FeedView({ projects, posts, sessions, actions, commands, tasks, reviews = [], seenPostIds, dismissedFeedItemIds, send, onOpen, onOpenProject, onNewTask, onRequestUndo }: FeedViewProps) {
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  // dismiss 乐观更新 + 快照调和：override 意图在快照吸收后自动丢弃
  const [dismissOverrides, setDismissOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const dismissResolution = useMemo(() => applyDismissOverrides(dismissedFeedItemIds, dismissOverrides), [dismissedFeedItemIds, dismissOverrides]);
  useEffect(() => {
    if (dismissResolution.settled.length === 0) return;
    setDismissOverrides((current) => {
      const next = new Map(current);
      for (const key of dismissResolution.settled) next.delete(key);
      return next;
    });
  }, [dismissResolution.settled]);

  const items = useMemo(
    () => buildFeedItems(posts, actions, seenPostIds, commands, dismissResolution.effective, tasks, reviews),
    [posts, actions, seenPostIds, commands, dismissResolution.effective, tasks, reviews],
  );

  // 页面会话固定序列：首帧按 protocol 排序建立，之后只追加、不换位
  const [sequence, setSequence] = useState(() => createFeedSequence(items));
  const previousItemsRef = useRef(items);
  if (previousItemsRef.current !== items) {
    previousItemsRef.current = items;
    setSequence((current) => reconcileFeedSequence(current, items));
  }

  const itemByKey = useMemo(() => new Map(items.map((item) => [feedItemId(item), item] as const)), [items]);
  const resolveItems = (keys: string[]) => keys.flatMap((key) => {
    const item = itemByKey.get(key);
    return item ? [item] : [];
  });
  const currentItems = resolveItems(sequence.queue);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_BATCH);
  const historyItems = resolveItems(sequence.history);
  const visibleHistoryItems = historyItems.slice(0, historyLimit);

  const historyPage = useRef<HTMLElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<FeedAnchor | null>(null);
  const renderedKeysRef = useRef("");
  const scrollingRef = useRef(false);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const scrollRafRef = useRef(0);
  const [atCaughtUp, setAtCaughtUp] = useState(false);

  const measurePages = (): FeedPageLayout[] => {
    const container = timelineRef.current;
    if (!container) return [];
    const containerRect = container.getBoundingClientRect();
    return [...container.querySelectorAll<HTMLElement>("[data-feed-key]")].map((element) => ({
      key: element.dataset["feedKey"] ?? "",
      top: element.getBoundingClientRect().top - containerRect.top + container.scrollTop,
      height: element.getBoundingClientRect().height,
    })).filter((page) => page.key);
  };

  // 锚定：渲染前后保持当前可见卡的 key 与像素偏移（误差 ≤2px 时不修正）
  useLayoutEffect(() => {
    const container = timelineRef.current;
    if (!container) return;
    const keySignature = `${sequence.queue.join("|")}//${sequence.history.slice(0, historyLimit).join("|")}`;
    if (renderedKeysRef.current === keySignature) return;
    const firstRender = renderedKeysRef.current === "";
    renderedKeysRef.current = keySignature;
    if (firstRender) {
      container.scrollTop = 0;
      anchorRef.current = captureInitialAnchor(sequence.queue.length + sequence.history.length > 0, measurePages());
      return;
    }
    const anchor = anchorRef.current ?? captureAnchor(container.scrollTop, measurePages());
    if (!anchor) return;
    const restored = restoreScrollTop(anchor, measurePages());
    if (restored !== null && Math.abs(container.scrollTop - restored) > 2) container.scrollTop = restored;
  });

  const scrollToKey = (key: string, behavior: ScrollBehavior = "smooth") => {
    const container = timelineRef.current;
    if (!container) return;
    const page = measurePages().find((candidate) => candidate.key === key);
    if (page) container.scrollTo({ top: page.top, behavior });
  };

  // 位于 caught-up 且停止滚动时，自动进入新卡
  useEffect(() => {
    if (!atCaughtUp || sequence.fresh.length === 0 || scrollingRef.current) return;
    scrollToKey(sequence.fresh[0]!);
  });

  const dismissItem = (item: FeedItem) => {
    const key = feedItemId(item);
    setDismissOverrides((current) => new Map(current).set(key, true));
    send({ type: "feed.dismiss.set", itemId: key, dismissed: true, idempotencyKey: crypto.randomUUID() });
    onRequestUndo?.("已移出这张卡片", () => {
      setDismissOverrides((current) => new Map(current).set(key, false));
      send({ type: "feed.dismiss.set", itemId: key, dismissed: false, idempotencyKey: crypto.randomUUID() });
    });
  };

  const handleScroll = () => {
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
    scrollingRef.current = true;
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollingRef.current = false;
      const anchor = anchorRef.current;
      const caughtUp = anchor?.key === CAUGHT_UP_KEY;
      setAtCaughtUp(caughtUp);
      if (caughtUp) setSequence((current) => clearFresh(current));
    }, 180);
    if (scrollRafRef.current) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const container = timelineRef.current;
      if (!container) return;
      anchorRef.current = captureAnchor(container.scrollTop, measurePages());
      // 历史懒渲染：接近底部时追加一批
      if (historyItems.length > visibleHistoryItems.length
        && container.scrollTop + container.clientHeight > container.scrollHeight - container.clientHeight * 1.5) {
        setHistoryLimit((limit) => Math.min(limit + HISTORY_BATCH, historyItems.length));
      }
    });
  };

  useEffect(() => () => {
    if (scrollIdleTimerRef.current !== null) window.clearTimeout(scrollIdleTimerRef.current);
    if (scrollRafRef.current) window.cancelAnimationFrame(scrollRafRef.current);
  }, []);

  const renderItem = (item: FeedItem, historical = false, index = -1) => {
    const position = historical ? null : index + 1;
    return (
      <SeenFeedPage
        key={feedItemId(item)}
        feedKey={feedItemId(item)}
        postId={item.type === "post" ? item.post.id : null}
        seen={item.type === "post" ? seenPostIds.includes(item.post.id) : false}
        onSeen={(postId) => send({ type: "feed.seen", postId })}
        pageRef={historical && index === 0 ? historyPage : undefined}
        historical={historical}
      >
        <SwipeToTask
          sessionId={item.type === "post" ? item.post.sessionId : item.type === "action" ? item.action.sessionId : null}
          onOpen={onOpen}
          onDismiss={() => dismissItem(item)}
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
            total={sequence.queue.length}
          /> : item.type === "action" ? <ActionFeedCard
            action={item.action}
            session={sessionById.get(item.action.sessionId)}
            send={send}
            position={position}
            total={sequence.queue.length}
          /> : <TaskCommandFailureCard command={item.command} send={send} position={position} total={sequence.queue.length} />}
        </SwipeToTask>
      </SeenFeedPage>
    );
  };

  return (
    <div className="feed-stage">
      <div ref={timelineRef} className="feed-timeline" aria-label="Agent Feed" onScroll={handleScroll}>
        {currentItems.map((item, index) => renderItem(item, false, index))}
        <section className="feed-page feed-finished-page" aria-label="当前 Feed 已看完" data-feed-key={CAUGHT_UP_KEY}>
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
        {visibleHistoryItems.map((item, index) => renderItem(item, true, index))}
      </div>
      {sequence.fresh.length > 0 && !atCaughtUp && (
        <button className="feed-new-updates" onClick={() => scrollToKey(sequence.fresh[0]!)}>
          有 {sequence.fresh.length} 条新更新
        </button>
      )}
    </div>
  );
}
