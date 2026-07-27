import { describe, expect, it } from "vitest";
import { createKeyPair, openPushRoute } from "@zimlo/protocol/crypto";
import { PushService } from "../src/push-service.js";
import { ZimloStore } from "../src/store.js";

function setup(showTaskTitle = false) {
  const store = new ZimloStore(":memory:");
  const now = "2026-07-28T00:00:00.000Z";
  store.upsertDevice({
    id: "device_phone",
    name: "iPhone",
    keyBase64: "unused",
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
    isLocalAdmin: false,
    canApprove: false,
    canManageTrust: false,
  });
  const routeKeys = createKeyPair();
  store.upsertPushDevice(
    "device_phone",
    "device_phone",
    Buffer.from(routeKeys.publicKey).toString("base64url"),
  );
  store.updateNotificationSettings("device_phone", {
    enabled: true,
    approvals: true,
    failures: true,
    reviews: true,
    showTaskTitle,
  });
  const sent: Array<Record<string, unknown>> = [];
  const service = new PushService(store, {
    enabled: true,
    sendPush: async (input) => {
      sent.push(input as unknown as Record<string, unknown>);
      return 200;
    },
  });
  return { store, routeKeys, sent, service };
}

describe("PushService", () => {
  it("sends only the three user-action notification kinds with stable collapse ids", () => {
    const { store, sent, service } = setup();
    service.notify("approval", "session-a", "Private task");
    service.notify("failure", "session-a", "Private task");
    service.notify("review", "session-a", "Private task");

    expect(sent.map((input) => input.kind)).toEqual(["approval", "failure", "review"]);
    expect(sent.map((input) => input.collapseId)).toEqual([
      "session-a:approval",
      "session-a:failure",
      "session-a:review",
    ]);
    expect(sent.every((input) => JSON.stringify(input.alert).includes("Private task") === false)).toBe(true);
    store.close();
  });

  it("keeps the task title inside the encrypted route and hides it by default", () => {
    const hidden = setup(false);
    hidden.service.notify("review", "session-a", "Private task");
    expect(openPushRoute(
      hidden.routeKeys.privateKey,
      hidden.sent[0]!.route as Parameters<typeof openPushRoute>[1],
    )).toEqual({ sessionId: "session-a" });
    hidden.store.close();

    const visible = setup(true);
    visible.service.notify("review", "session-a", "Private task");
    expect(openPushRoute(
      visible.routeKeys.privateKey,
      visible.sent[0]!.route as Parameters<typeof openPushRoute>[1],
    )).toEqual({ sessionId: "session-a", taskTitle: "Private task" });
    visible.store.close();
  });

  it("respects the global and per-kind notification switches", () => {
    const { store, sent, service } = setup();
    store.updateNotificationSettings("device_phone", {
      enabled: true,
      approvals: false,
      failures: true,
      reviews: false,
      showTaskTitle: false,
    });
    service.notify("approval", "session-a");
    service.notify("failure", "session-a");
    service.notify("review", "session-a");
    expect(sent.map((input) => input.kind)).toEqual(["failure"]);

    store.updateNotificationSettings("device_phone", {
      enabled: false,
      approvals: true,
      failures: true,
      reviews: true,
      showTaskTitle: false,
    });
    service.notify("failure", "session-b");
    expect(sent).toHaveLength(1);
    store.close();
  });
});
