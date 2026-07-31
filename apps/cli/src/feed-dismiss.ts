// feed.dismiss.set 的服务端语义：按设备设置/取消 Feed 条目移除状态，
// 幂等键去重 —— 同一 (deviceId, idempotencyKey) 重放不再写入，只回报当前状态。
import type { ZimloStore } from "./store.js";

export interface FeedDismissSetResult {
  duplicated: boolean;
  dismissed: boolean;
}

export function applyFeedDismissSet(
  store: ZimloStore,
  deviceId: string,
  itemId: string,
  dismissed: boolean,
  idempotencyKey: string,
): FeedDismissSetResult {
  const storageKey = `${deviceId}:${idempotencyKey}`;
  if (store.getIdempotentResult(storageKey)) {
    return {
      duplicated: true,
      dismissed: store.listDismissedFeedItemIds(deviceId).includes(itemId),
    };
  }
  store.setFeedItemDismissed(deviceId, itemId, dismissed);
  store.saveIdempotentResult(storageKey, itemId, { ok: true });
  return { duplicated: false, dismissed };
}
