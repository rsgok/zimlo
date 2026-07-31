import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES } from "@zimlo/protocol";
import { ZimloStore } from "../src/store.js";
import { setTaskArchivedIdempotent, setTaskPinnedIdempotent } from "../src/task-preferences.js";

const roots: string[] = [];

function createStore(): ZimloStore {
  const root = mkdtempSync(join(tmpdir(), "zimlo-prefs-"));
  roots.push(root);
  const store = new ZimloStore(join(root, "zimlo.db"));
  store.upsertSession({
    id: "session-a",
    provider: "codex",
    surface: "cli",
    providerSessionId: "provider-a",
    title: "Task A",
    cwd: "/tmp/project",
    transcriptPath: null,
    status: "idle",
    lastActivityAt: "2026-07-29T00:00:00.000Z",
    createdAt: "2026-07-29T00:00:00.000Z",
    activePid: null,
    processStartedAt: null,
    tty: null,
    correlationUncertain: false,
    capabilities: EMPTY_CAPABILITIES,
  });
  return store;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("task pin/archive idempotency", () => {
  it("applies once per idempotency key and replays the current preference", () => {
    const store = createStore();
    const first = setTaskPinnedIdempotent(store, "device-a", "session-a", true, "pin-1");
    expect(first.duplicated).toBe(false);
    expect(first.preference.pinnedAt).not.toBeNull();

    const replay = setTaskPinnedIdempotent(store, "device-a", "session-a", false, "pin-1");
    expect(replay.duplicated).toBe(true);
    expect(replay.preference.pinnedAt).toBe(first.preference.pinnedAt);
    expect(store.getTaskPreference("session-a").pinnedAt).toBe(first.preference.pinnedAt);
  });

  it("keeps legacy behavior when no idempotency key is given", () => {
    const store = createStore();
    expect(setTaskPinnedIdempotent(store, "device-a", "session-a", true).duplicated).toBe(false);
    const again = setTaskPinnedIdempotent(store, "device-a", "session-a", false);
    expect(again.duplicated).toBe(false);
    expect(again.preference.pinnedAt).toBeNull();
  });

  it("applies archive idempotently with an independent flag", () => {
    const store = createStore();
    setTaskPinnedIdempotent(store, "device-a", "session-a", true, "pin-1");
    const archived = setTaskArchivedIdempotent(store, "device-a", "session-a", true, "archive-1");
    expect(archived.preference.archivedAt).not.toBeNull();
    expect(archived.preference.pinnedAt).not.toBeNull();
    const replay = setTaskArchivedIdempotent(store, "device-a", "session-a", false, "archive-1");
    expect(replay.duplicated).toBe(true);
    expect(replay.preference.archivedAt).toBe(archived.preference.archivedAt);
  });

  it("scopes idempotency keys per device", () => {
    const store = createStore();
    setTaskPinnedIdempotent(store, "device-a", "session-a", true, "pin-1");
    const other = setTaskPinnedIdempotent(store, "device-b", "session-a", false, "pin-1");
    expect(other.duplicated).toBe(false);
    expect(other.preference.pinnedAt).toBeNull();
  });
});
