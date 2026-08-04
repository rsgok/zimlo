import type { FeedItem } from "./feedItems";
import { feedItemId } from "./feedItems";

// 页面会话固定序列：首次载入按 protocol 优先级排序建立队列；之后已有卡不因
// 已读 / 审批完成 / 快照刷新而换位。新卡与重新可操作的卡进入队列头部，锚定
// 逻辑负责保持用户当前阅读位置；已处理卡在当前会话原位展示完成状态。

export interface FeedSequenceState {
  /** 当前队列的卡片 key，展示顺序固定 */
  queue: string[];
  /** 历史区卡片 key，展示顺序固定（新历史卡按时间插入） */
  history: string[];
  /** 用户上次到达 caught-up 之后追加进队列的卡片 key */
  fresh: string[];
}

export const CAUGHT_UP_KEY = "__caught_up__";

// 卡片是否属于"当前"（未读或需要操作），与 buildFeedItems 的优先级语义一致。
export function isCurrentEligible(item: FeedItem): boolean {
  return item.unread || item.needsAction;
}

export function createFeedSequence(items: FeedItem[]): FeedSequenceState {
  const queue: string[] = [];
  const history: string[] = [];
  for (const item of items) {
    (isCurrentEligible(item) ? queue : history).push(feedItemId(item));
  }
  return { queue, history, fresh: [] };
}

export function reconcileFeedSequence(previous: FeedSequenceState, items: FeedItem[]): FeedSequenceState {
  const itemByKey = new Map(items.map((item) => [feedItemId(item), item] as const));
  const queueSet = new Set<string>();
  const queue = previous.queue.filter((key) => {
    if (!itemByKey.has(key)) return false;
    queueSet.add(key);
    return true;
  });

  const previousFresh = previous.fresh.filter((key) => queueSet.has(key));
  const newcomers: string[] = [];
  // 队列外的可操作卡（全新卡，或历史区重新可操作的卡）保持 protocol 排序，
  // 统一插到队列头部，让“有新内容”总是指向最前面的最新关注项。
  for (const item of items) {
    const key = feedItemId(item);
    if (queueSet.has(key) || !isCurrentEligible(item)) continue;
    queueSet.add(key);
    newcomers.push(key);
  }
  queue.unshift(...newcomers);
  const fresh = [...newcomers, ...previousFresh];

  // 历史区：保留仍在 items 中且未回到队列的卡；新进历史的卡按 createdAt 新→旧归并。
  const historySurvivors = previous.history.filter((key) => !queueSet.has(key) && itemByKey.has(key));
  const historySet = new Set(historySurvivors);
  const historyNewcomers = items.filter((item) => {
    const key = feedItemId(item);
    return !queueSet.has(key) && !historySet.has(key);
  });
  const history = mergeByCreatedAt(historySurvivors, historyNewcomers, itemByKey);
  return { queue, history, fresh };
}

function mergeByCreatedAt(survivors: string[], newcomers: FeedItem[], itemByKey: Map<string, FeedItem>): string[] {
  const sortedNewcomers = [...newcomers].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const merged: string[] = [];
  let newcomerIndex = 0;
  for (const key of survivors) {
    const createdAt = itemByKey.get(key)?.createdAt ?? "";
    while (newcomerIndex < sortedNewcomers.length && (sortedNewcomers[newcomerIndex]?.createdAt ?? "") >= createdAt) {
      merged.push(feedItemId(sortedNewcomers[newcomerIndex++]!));
    }
    merged.push(key);
  }
  while (newcomerIndex < sortedNewcomers.length) merged.push(feedItemId(sortedNewcomers[newcomerIndex++]!));
  return merged;
}

// 用户到达 caught-up（看完页）后，新到计数清零。
export function clearFresh(sequence: FeedSequenceState): FeedSequenceState {
  return sequence.fresh.length === 0 ? sequence : { ...sequence, fresh: [] };
}

// --- 锚定 ---

export interface FeedAnchor {
  /** 当前可见卡的 key */
  key: string;
  /** 卡片顶部相对滚动视口顶部的偏移（px，吸附位为 0） */
  offset: number;
  /** 在渲染序列中的下标，用于 key 消失时的回退定位 */
  index: number;
}

export interface FeedPageLayout {
  key: string;
  top: number;
  height: number;
}

// 根据 scrollTop 找出当前可见卡并记录偏移。纯函数便于测试；布局来自 DOM 测量。
export function captureAnchor(scrollTop: number, pages: FeedPageLayout[]): FeedAnchor | null {
  if (pages.length === 0) return null;
  const position = scrollTop + 1;
  const index = pages.findIndex((page) => page.top <= position && page.top + page.height > position);
  const resolved = index >= 0 ? index : (scrollTop <= 0 ? 0 : pages.length - 1);
  const page = pages[resolved]!;
  return { key: page.key, offset: page.top - scrollTop, index: resolved };
}

// 空启动帧只有 caught-up 占位页，不能把它当成真实阅读锚点；否则延迟快照
// 到达后会恢复到 caught-up 并越过全部新卡。
export function captureInitialAnchor(hasFeedItems: boolean, pages: FeedPageLayout[]): FeedAnchor | null {
  return hasFeedItems ? captureAnchor(0, pages) : null;
}

// 重渲染后把锚卡恢复到原偏移；锚卡被移除时回退到原下标（钳位到序列内）。
// 返回新的 scrollTop；序列为空时返回 null。
export function restoreScrollTop(anchor: FeedAnchor, pages: FeedPageLayout[]): number | null {
  if (pages.length === 0) return null;
  const byKey = pages.find((page) => page.key === anchor.key);
  const page = byKey ?? pages[Math.min(anchor.index, pages.length - 1)]!;
  return page.top - anchor.offset;
}

// --- 移除（dismiss）乐观更新 + 快照调和 ---

// base 为服务端权威 dismissedFeedItemIds，overrides 为本机尚未被快照确认的意图。
// effective 供构建 feed items 使用；settled 为已被快照吸收、可丢弃的 override key。
export function applyDismissOverrides(
  base: string[],
  overrides: ReadonlyMap<string, boolean>,
): { effective: string[]; settled: string[] } {
  const baseSet = new Set(base);
  const effective = new Set(base);
  const settled: string[] = [];
  for (const [key, intent] of overrides) {
    if (baseSet.has(key) === intent) settled.push(key);
    else if (intent) effective.add(key);
    else effective.delete(key);
  }
  return { effective: [...effective], settled };
}
