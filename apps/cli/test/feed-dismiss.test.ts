import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyFeedDismissSet } from "../src/feed-dismiss.js";
import { ZimloStore } from "../src/store.js";

const roots: string[] = [];

function createStore(): ZimloStore {
  const root = mkdtempSync(join(tmpdir(), "zimlo-dismiss-"));
  roots.push(root);
  const store = new ZimloStore(join(root, "zimlo.db"));
  store.upsertDevice({
    id: "device-a",
    name: "device-a",
    keyBase64: "key",
    createdAt: "2026-07-29T00:00:00.000Z",
    lastSeenAt: "2026-07-29T00:00:00.000Z",
    revokedAt: null,
    isLocalAdmin: false,
    canApprove: false,
  });
  return store;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("feed.dismiss.set", () => {
  it("sets and unsets the dismissed state per device", () => {
    const store = createStore();
    expect(applyFeedDismissSet(store, "device-a", "post:1", true, "k1")).toEqual({ duplicated: false, dismissed: true });
    expect(store.listDismissedFeedItemIds("device-a")).toEqual(["post:1"]);
    expect(applyFeedDismissSet(store, "device-a", "post:1", false, "k2")).toEqual({ duplicated: false, dismissed: false });
    expect(store.listDismissedFeedItemIds("device-a")).toEqual([]);
  });

  it("deduplicates replays of the same idempotency key without re-applying", () => {
    const store = createStore();
    applyFeedDismissSet(store, "device-a", "post:1", true, "k1");
    const replay = applyFeedDismissSet(store, "device-a", "post:1", false, "k1");
    expect(replay).toEqual({ duplicated: true, dismissed: true });
    expect(store.listDismissedFeedItemIds("device-a")).toEqual(["post:1"]);
  });

  it("scopes idempotency keys per device", () => {
    const store = createStore();
    store.upsertDevice({
      id: "device-b",
      name: "device-b",
      keyBase64: "key",
      createdAt: "2026-07-29T00:00:00.000Z",
      lastSeenAt: "2026-07-29T00:00:00.000Z",
      revokedAt: null,
      isLocalAdmin: false,
      canApprove: false,
    });
    applyFeedDismissSet(store, "device-a", "post:1", true, "k1");
    const other = applyFeedDismissSet(store, "device-b", "post:1", true, "k1");
    expect(other.duplicated).toBe(false);
    expect(store.listDismissedFeedItemIds("device-b")).toEqual(["post:1"]);
  });

  it("keeps the legacy feed.dismiss behavior unchanged", () => {
    const store = createStore();
    expect(store.dismissFeedItem("device-a", "post:1")).toBe(true);
    expect(store.dismissFeedItem("device-a", "post:1")).toBe(false);
    expect(store.listDismissedFeedItemIds("device-a")).toEqual(["post:1"]);
  });
});
