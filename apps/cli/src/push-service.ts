import { createPrivateKey, sign } from "node:crypto";
import { fromBase64Url, sealPushRoute, toBase64Url } from "@zimlo/protocol/crypto";
import type { ZimloStore } from "./store.js";

export type PushKind = "approval" | "failure" | "review";

export class PushService {
  private readonly store: ZimloStore;
  private readonly relayURL: string | null;
  private readonly privateKey: ReturnType<typeof createPrivateKey> | null;

  constructor(store: ZimloStore) {
    this.store = store;
    this.relayURL = process.env.ZIMLO_PUSH_RELAY_URL?.replace(/\/+$/u, "") ?? null;
    const pem = process.env.ZIMLO_PUSH_RELAY_PRIVATE_KEY_PEM?.replaceAll("\\n", "\n");
    this.privateKey = pem ? createPrivateKey(pem) : null;
  }

  notify(kind: PushKind, sessionId: string, taskTitle?: string): void {
    if (!this.relayURL || !this.privateKey) return;
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
      const body = JSON.stringify({
        endpoint: registration.endpoint,
        kind,
        collapseId: `${sessionId}:${kind}`,
        alert: { title: "Zimlo", body: kind === "failure" ? "一项任务需要你查看" : "有一项需要你处理" },
        route,
      });
      const timestamp = new Date().toISOString();
      const signature = toBase64Url(sign(null, Buffer.from(`${timestamp}.${body}`), this.privateKey));
      void fetch(`${this.relayURL}/v1/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zimlo-timestamp": timestamp,
          "x-zimlo-signature": signature,
        },
        body,
      }).then((response) => {
        if (response.status === 410) this.store.unregisterPushDevice(registration.deviceId);
      }).catch(() => undefined);
    }
  }
}
