import { isQuickApprovable } from "@zimlo/protocol";
import type { PendingAction, PushRouteV1 } from "@zimlo/protocol";
import { fromBase64Url, sealPushRoute } from "@zimlo/protocol/crypto";
import type { CloudService } from "./cloud-service.js";
import type { ZimloStore } from "./store.js";

export type PushKind = "approval" | "failure";
type CloudPushClient = Pick<CloudService, "enabled" | "sendPush">;

// Cleartext APNs category for low-risk approvals. It is a generic
// UNNotificationCategory identifier carrying no task content, so sending it
// outside the encrypted route keeps the privacy posture — the system needs
// `aps.category` in plaintext to render the lock-screen action buttons.
export const QUICK_APPROVE_PUSH_CATEGORY = "ZIMLO_LOW_RISK_APPROVAL";

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

  notify(kind: PushKind, sessionId: string, taskTitle?: string, action?: PendingAction): void {
    if (!this.cloud.enabled) return;
    for (const { registration, settings } of this.store.listActivePushDevices()) {
      const subscribed = settings.enabled && (kind === "approval" ? settings.approvals : settings.failures);
      if (!subscribed) continue;
      const ids = kind === "approval" && action ? quickApproveDecisionIds(action) : null;
      const payload: PushRouteV1 | { sessionId: string; taskTitle?: string } = ids && action
        ? {
          version: 1,
          sessionId,
          ...(settings.showTaskTitle && taskTitle ? { taskTitle } : {}),
          actionId: action.actionId,
          decision: ids.allowOnceId,
          denyDecision: ids.denyId,
          expiresAt: action.expiresAt,
          ...(action.approvalContext ? { category: action.approvalContext.category } : {}),
        }
        : {
          sessionId,
          ...(settings.showTaskTitle && taskTitle ? { taskTitle } : {}),
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
        collapseId: `${sessionId}:${kind}`,
        alert: { title: "Zimlo", body: kind === "failure" ? "一项任务需要你查看" : "有一项需要你处理" },
        route,
        ...(ids ? { category: QUICK_APPROVE_PUSH_CATEGORY } : {}),
      }).then((status) => {
        if (status === 410) this.store.unregisterPushDevice(registration.deviceId);
      }).catch(() => undefined);
    }
  }
}
