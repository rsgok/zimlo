import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionSchema, SnapshotSchema, UnifiedEventSchema } from "@zimlo/protocol";
import { describe, expect, it } from "vitest";
import { RuntimeHub } from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(
    `../../../packages/protocol/test-vectors/${name}`,
    import.meta.url,
  )), "utf8");
}

const vector = JSON.parse(fixture("store-compat.json")) as { version: number; session: unknown; event: unknown };
const snapshotFixture = fixture("snapshot-compat.sql");
const snapshotContract = JSON.parse(fixture("snapshot-compat.json")) as { version: number; normalizedSha256: string };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
}

describe("Node/Rust SQLite compatibility vector", () => {
  it("round-trips the canonical session and event through the Node store", () => {
    expect(vector.version).toBe(1);
    const session = SessionSchema.parse(vector.session);
    const expectedEvent = UnifiedEventSchema.parse(vector.event);
    const store = new ZimloStore(":memory:");

    try {
      expect(store.upsertSession(session)).toEqual(session);
      const inserted = store.insertEvent({ ...expectedEvent, sequence: 0 });
      expect(inserted).toEqual({ event: expectedEvent, inserted: true });
      expect(store.listEvents(session.id)).toEqual([expectedEvent]);
    } finally {
      store.close();
    }
  });

  it("builds the complete canonical Snapshot from the shared SQLite fixture", () => {
    const store = new ZimloStore(":memory:");
    const previousHostName = process.env.ZIMLO_HOST_NAME;
    try {
      store.database.exec(snapshotFixture);
      process.env.ZIMLO_HOST_NAME = "Snapshot Fixture Mac";
      const snapshot = SnapshotSchema.parse(new RuntimeHub(store).snapshot("device-local-snapshot"));

      expect(snapshot.host?.id).toBe("host_snapshot_fixture");
      expect(snapshot.host?.name).toBe("Snapshot Fixture Mac");
      expect(snapshot.userProfile.avatarId).toBe("user-07");
      expect(snapshot.projects[0]).toMatchObject({
        id: "project-snapshot",
        hostId: "host_snapshot_fixture",
        sessionCount: 1,
        postCount: 1,
      });
      expect(snapshot.sessions[0]).toMatchObject({
        id: "session-snapshot",
        title: "继续迁移完整 Snapshot",
        projectName: "Snapshot Project",
      });
      expect(snapshot.posts[0]?.headline).toBe("Snapshot 已兼容");
      expect(snapshot.materials[0]?.width).toBe(320);
      expect(snapshot.tasks[0]?.state).toBe("user_review");
      expect(snapshot.commands[0]?.materialIds).toEqual(["material_snapshot_001"]);
      expect(snapshot.workspaces[0]?.path).toBe("/fixture/snapshot");
      expect(snapshot.seenPostIds).toEqual(["post-snapshot"]);
      expect(snapshot.dismissedFeedItemIds).toEqual(["post:old"]);
      expect(snapshot.taskTimelineCursors).toEqual({ "session-snapshot": "event:event-snapshot" });
      expect(snapshot.actions[0]?.approvalContext?.category).toBe("test");
      expect(snapshot.trustPolicies[0]?.preset).toBe("safe_automation");
      expect(snapshot.trustAudit[0]?.decision).toBe("auto_allowed");
      expect(snapshot.notificationSettings.timeZoneOffsetMinutes).toBe(480);
      expect(snapshot.pushDevices[0]?.lastDeliveryStatus).toBe(200);
      expect(snapshot.features).toEqual({
        projectTrustPolicy: true,
        pushNotifications: false,
        remoteSync: false,
        multiHost: true,
      });
      expect(snapshot.sequence).toBe(1);
      expect(snapshot.lanApprovalsEnabled).toBe(true);
      expect(snapshot.trustManagementEnabled).toBe(true);
      expect(snapshot.cards).toEqual([]);
      expect(snapshotContract.version).toBe(1);
      const normalized = structuredClone(snapshot);
      if (normalized.host) normalized.host.lastSeenAt = "NORMALIZED";
      const digest = createHash("sha256").update(JSON.stringify(canonical(normalized))).digest("hex");
      expect(digest).toBe(snapshotContract.normalizedSha256);
    } finally {
      if (previousHostName === undefined) delete process.env.ZIMLO_HOST_NAME;
      else process.env.ZIMLO_HOST_NAME = previousHostName;
      store.close();
    }
  });
});
