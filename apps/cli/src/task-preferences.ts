// task.pin / task.archive 的可选幂等：客户端带 idempotencyKey 时纳入与
// feed 与任务偏好命令按相同的 (deviceId, key) 去重；缺省保持旧行为（直接应用）。
import type { TaskPreference } from "@zimlo/protocol";
import type { ZimloStore } from "./store.js";

export interface TaskPreferenceResult {
  preference: TaskPreference;
  duplicated: boolean;
}

export function setTaskPinnedIdempotent(
  store: ZimloStore,
  deviceId: string,
  sessionId: string,
  pinned: boolean,
  idempotencyKey?: string,
): TaskPreferenceResult {
  if (!idempotencyKey) return { preference: store.setTaskPinned(sessionId, pinned), duplicated: false };
  const storageKey = `${deviceId}:${idempotencyKey}`;
  if (store.getIdempotentResult(storageKey)) {
    return { preference: store.getTaskPreference(sessionId), duplicated: true };
  }
  const preference = store.setTaskPinned(sessionId, pinned);
  store.saveIdempotentResult(storageKey, sessionId, { ok: true });
  return { preference, duplicated: false };
}

export function setTaskArchivedIdempotent(
  store: ZimloStore,
  deviceId: string,
  sessionId: string,
  archived: boolean,
  idempotencyKey?: string,
): TaskPreferenceResult {
  if (!idempotencyKey) return { preference: store.setTaskArchived(sessionId, archived), duplicated: false };
  const storageKey = `${deviceId}:${idempotencyKey}`;
  if (store.getIdempotentResult(storageKey)) {
    return { preference: store.getTaskPreference(sessionId), duplicated: true };
  }
  const preference = store.setTaskArchived(sessionId, archived);
  store.saveIdempotentResult(storageKey, sessionId, { ok: true });
  return { preference, duplicated: false };
}
