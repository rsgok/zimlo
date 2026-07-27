import { fromBase64Url, sealPushRoute } from "@zimlo/protocol/crypto";
import type { CloudService } from "./cloud-service.js";
import type { ZimloStore } from "./store.js";

export type PushKind = "approval" | "failure" | "review";
type CloudPushClient = Pick<CloudService, "enabled" | "sendPush">;

export class PushService {
  private readonly store: ZimloStore;
  private readonly cloud: CloudPushClient;

  constructor(store: ZimloStore, cloud: CloudPushClient) {
    this.store = store;
    this.cloud = cloud;
  }

  notify(kind: PushKind, sessionId: string, taskTitle?: string): void {
    if (!this.cloud.enabled) return;
    for (const { registration, settings } of this.store.listActivePushDevices()) {
      const subscribed = settings.enabled
        && (kind === "approval" ? settings.approvals : kind === "failure" ? settings.failures : settings.reviews);
      if (!subscribed) continue;
      let route;
      try {
        route = sealPushRoute(fromBase64Url(registration.publicKey), {
          sessionId,
          ...(settings.showTaskTitle && taskTitle ? { taskTitle } : {}),
        });
      } catch {
        continue;
      }
      void this.cloud.sendPush({
        deviceId: registration.deviceId,
        kind,
        collapseId: `${sessionId}:${kind}`,
        alert: { title: "Zimlo", body: kind === "failure" ? "一项任务需要你查看" : "有一项需要你处理" },
        route,
      }).then((status) => {
        if (status === 410) this.store.unregisterPushDevice(registration.deviceId);
      }).catch(() => undefined);
    }
  }
}
