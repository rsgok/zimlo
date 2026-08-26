import { redactText } from "@zimlo/adapters";
import { isQuickApprovable } from "@zimlo/protocol";
import type { FeedPost, NotificationSettings, PendingAction, PushRouteV1 } from "@zimlo/protocol";
import { fromBase64Url, sealPushRoute } from "@zimlo/protocol/crypto";
import type { CloudService } from "./cloud-service.js";
import type { ZimloStore } from "./store.js";

export type PushKind = "approval" | "approval_reminder" | "result" | "failure";
type CloudPushClient = Pick<CloudService, "enabled" | "sendPush">;

// Cleartext APNs category for low-risk approvals. It is a generic
// UNNotificationCategory identifier carrying no task content, so sending it
// outside the encrypted route keeps the privacy posture — the system needs
// `aps.category` in plaintext to render the lock-screen action buttons.
export const QUICK_APPROVE_PUSH_CATEGORY = "ZIMLO_LOW_RISK_APPROVAL";
export const NOTIFICATION_SUMMARY_LIMIT = 120;

function compactNotificationText(value: string, limit = NOTIFICATION_SUMMARY_LIMIT): string {
  const compact = redactText(value, 512).replace(/\s+/gu, " ").trim();
  const characters = Array.from(compact);
  return characters.length <= limit ? compact : `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

export function notificationSummaryForPost(
  post: Pick<FeedPost, "headline" | "takeaway">,
): string | undefined {
  const headline = compactNotificationText(post.headline, 72);
  const takeaway = compactNotificationText(post.takeaway, NOTIFICATION_SUMMARY_LIMIT);
  if (!headline) return takeaway || undefined;
  if (!takeaway || takeaway === headline) return headline;
  return compactNotificationText(`${headline}：${takeaway}`) || undefined;
}

function approvalCategoryLabel(action: PendingAction): string | undefined {
  switch (action.approvalContext?.category) {
    case "read": return "读取项目文件";
    case "search": return "搜索项目内容";
    case "test": return "运行测试";
    case "build": return "构建项目";
    case "write": return "修改文件";
    case "install": return "安装或更新依赖";
    case "network": return "访问网络";
    case "git_publish": return "发布 Git 变更";
    case "destructive": return "执行可能破坏数据的操作";
    case "unknown": return "执行一项操作";
    default: return undefined;
  }
}

export function notificationSummaryForAction(action: PendingAction, reminder = false): string {
  if (action.kind === "input") return reminder ? "仍有一个问题等待你回复" : "需要你回复一个问题";
  const operation = approvalCategoryLabel(action);
  const prefix = reminder ? "仍待批准" : "需要批准";
  return operation ? `${prefix}：${operation}` : `${prefix}一项操作`;
}

export function pushCollapseId(kind: PushKind, sessionId: string): string {
  return `${sessionId}:${kind === "approval" || kind === "approval_reminder" ? "action" : "status"}`;
}

export function isCriticalPush(kind: PushKind): boolean {
  return kind !== "result";
}

export function isInQuietHours(settings: NotificationSettings, now = new Date()): boolean {
  if (!settings.quietHoursEnabled) return false;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const localMinutes = ((utcMinutes + settings.timeZoneOffsetMinutes) % 1_440 + 1_440) % 1_440;
  return localMinutes >= 22 * 60 || localMinutes < 8 * 60;
}

export function shouldDeliverPush(kind: PushKind, settings: NotificationSettings, now = new Date()): boolean {
  if (!settings.enabled) return false;
  const subscribed = kind === "approval" || kind === "approval_reminder"
    ? settings.approvals
    : kind === "result"
      ? settings.results
      : settings.failures;
  if (!subscribed) return false;
  if ((settings.criticalOnly || isInQuietHours(settings, now)) && !isCriticalPush(kind)) return false;
  return true;
}

// Lock-screen actions are only offered while the action is pending and
// unexpired; anything else falls back to the plain open-the-app route and
// the server re-validates state, device permission and idempotency on decide.
// Both decision ids travel inside the encrypted route so "批准一次" and
// "拒绝" work from the lock screen without a bridge round trip.
function quickApproveDecisionIds(action: PendingAction): { allowOnceId: string; denyId: string } | null {
  if (action.state !== "pending" || !isQuickApprovable(action)) return null;
  if (Date.parse(action.expiresAt) <= Date.now()) return null;
  const allowOnceId = action.availableDecisions.find((decision) => decision.scope === "once")?.id;
  const denyId = action.availableDecisions.find((decision) => decision.scope === "deny")?.id;
  return allowOnceId && denyId ? { allowOnceId, denyId } : null;
}

export class PushService {
  private readonly store: ZimloStore;
  private readonly cloud: CloudPushClient;

  constructor(store: ZimloStore, cloud: CloudPushClient) {
    this.store = store;
    this.cloud = cloud;
  }

  notify(
    kind: PushKind,
    sessionId: string,
    taskTitle?: string,
    action?: PendingAction,
    summary?: string,
  ): void {
    if (!this.cloud.enabled) return;
    for (const { registration, settings } of this.store.listActivePushDevices()) {
      if (!shouldDeliverPush(kind, settings)) continue;
      const actionableKind = kind === "approval" || kind === "approval_reminder";
      const ids = actionableKind && action ? quickApproveDecisionIds(action) : null;
      const safeSummary = compactNotificationText(
        summary ?? (action ? notificationSummaryForAction(action, kind === "approval_reminder") : ""),
      );
      const privateDisplay = settings.showTaskTitle
        ? {
          ...(taskTitle ? { taskTitle: compactNotificationText(taskTitle, 80) } : {}),
          ...(safeSummary ? { summary: safeSummary } : {}),
        }
        : {};
      const payload: PushRouteV1 | { sessionId: string; taskTitle?: string; summary?: string } = ids && action
        ? {
          version: 1,
          sessionId,
          ...privateDisplay,
          actionId: action.actionId,
          decision: ids.allowOnceId,
          denyDecision: ids.denyId,
          expiresAt: action.expiresAt,
          ...(action.approvalContext ? { category: action.approvalContext.category } : {}),
        }
        : {
          sessionId,
          ...privateDisplay,
        };
      let route;
      try {
        route = sealPushRoute(fromBase64Url(registration.publicKey), payload);
      } catch {
        continue;
      }
      void this.cloud.sendPush({
        deviceId: registration.deviceId,
        kind,
        collapseId: pushCollapseId(kind, sessionId),
        badge: this.store.notificationUnreadCount(registration.deviceId, settings),
        alert: {
          title: "Zimlo",
          body: kind === "failure"
            ? "一项任务需要你查看"
            : kind === "result"
              ? "一项任务有了新结果"
              : kind === "approval_reminder"
                ? "仍有一项等待你处理"
                : "有一项需要你处理",
        },
        route,
        ...(ids ? { category: QUICK_APPROVE_PUSH_CATEGORY } : {}),
      }).then((status) => {
        try {
          this.store.recordPushDelivery(registration.deviceId, kind, status);
          if (status === 410) this.store.unregisterPushDevice(registration.deviceId);
        } catch {
          // The Bridge may have completed shutdown while an APNs request was
          // still in flight; delivery diagnostics must never crash teardown.
        }
      }).catch(() => {
        try { this.store.recordPushDelivery(registration.deviceId, kind, -1); }
        catch { /* Store closed during shutdown. */ }
      });
    }
  }
}
