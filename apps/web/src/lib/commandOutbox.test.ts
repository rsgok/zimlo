import { describe, expect, it } from "vitest";
import type { ClientCommand } from "@zimlo/protocol";
import outboxKeysVector from "../../../../packages/protocol/test-vectors/outbox-keys.json";
import {
  COMMAND_OUTBOX_KEY,
  clearDeviceLocalData,
  commandSemanticKey,
  enqueueCommand,
  isOutboxEntryCancelable,
  isOutboxEntryEditable,
  readCommandOutbox,
  removeAcknowledged,
  saveCommandOutbox,
} from "./commandOutbox";

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
}

const followUp = (idempotencyKey: string): ClientCommand => ({
  type: "task.follow_up",
  sessionId: "session-a",
  text: "继续验证移动端",
  idempotencyKey,
});

describe("persistent command outbox", () => {
  it("deduplicates repeated clicks while preserving the first idempotency key", () => {
    const first = enqueueCommand([], followUp("first"));
    const repeated = enqueueCommand(first.entries, followUp("second"));
    expect(repeated.added).toBe(false);
    expect(repeated.entries).toHaveLength(1);
    expect(repeated.entry.command).toMatchObject({ idempotencyKey: "first" });
  });

  it("persists commands across reloads and removes only acknowledged entries", () => {
    const storage = new MemoryStorage();
    const queued = enqueueCommand([], followUp("follow-up"), "2026-07-23T01:00:00.000Z").entries;
    expect(saveCommandOutbox(queued, storage)).toBe(true);
    expect(storage.values.has(COMMAND_OUTBOX_KEY)).toBe(true);
    const restored = readCommandOutbox(storage);
    expect(restored).toEqual(queued);
    expect(removeAcknowledged(restored, (entry) => entry.id === "follow-up")).toEqual([]);
  });

  it("uses a stable semantic key for form input regardless of field order", () => {
    const left: ClientCommand = { type: "action.decide", actionId: "a", sessionId: "s", decisionId: "approve", idempotencyKey: "1", input: { z: "2", a: "1" } };
    const right: ClientCommand = { ...left, idempotencyKey: "2", input: { a: "1", z: "2" } };
    expect(commandSemanticKey(left)).toBe(commandSemanticKey(right));
  });

  it("reports a persistence failure so the composer can keep the original draft", () => {
    const failingStorage = { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } };
    expect(saveCommandOutbox(enqueueCommand([], followUp("retryable")).entries, failingStorage)).toBe(false);
  });

  it("keeps only the latest preset avatar choice while offline", () => {
    const first = enqueueCommand([], { type: "user.profile.update", avatarId: "user-01" }, "2026-07-23T01:00:00.000Z");
    const latest = enqueueCommand(first.entries, { type: "user.profile.update", avatarId: "user-24" }, "2026-07-23T01:01:00.000Z");
    expect(latest.entries).toHaveLength(1);
    expect(latest.entry.command).toEqual({ type: "user.profile.update", avatarId: "user-24" });
  });

  it("keeps only the latest dismiss intent per feed item (replace, not append)", () => {
    const first = enqueueCommand([], { type: "feed.dismiss.set", itemId: "post:p-1", dismissed: true, idempotencyKey: "k-1" });
    const undone = enqueueCommand(first.entries, { type: "feed.dismiss.set", itemId: "post:p-1", dismissed: false, idempotencyKey: "k-2" });
    expect(undone.added).toBe(false);
    expect(undone.entries).toHaveLength(1);
    expect(undone.entry.command).toMatchObject({ type: "feed.dismiss.set", dismissed: false, idempotencyKey: "k-2" });
  });

  it("persists cancellation under a distinct id from the target command", () => {
    const original = enqueueCommand([], followUp("target-key")).entry;
    const canceled = enqueueCommand([original], { type: "task.command.cancel", idempotencyKey: "target-key" });
    expect(canceled.added).toBe(true);
    expect(canceled.entry.id).toBe("task.command.cancel:target-key");
    expect(canceled.entry.id).not.toBe(original.id);
    expect(canceled.entries).toHaveLength(2);
  });

  it("clears device-bound commands and drafts while retaining UI preferences", () => {
    const storage = new MemoryStorage();
    storage.setItem(COMMAND_OUTBOX_KEY, "[]");
    storage.setItem("zimlo:new-task-draft", "new");
    storage.setItem("zimlo:task-draft:s1", "reply");
    storage.setItem("zimlo:feed-reply:p1", "feed");
    storage.setItem("zimlo:action-draft:a1", "answer");
    storage.setItem("zimlo:last-workspace", "ws-1");

    clearDeviceLocalData(storage);

    expect(storage.values).toEqual(new Map([["zimlo:last-workspace", "ws-1"]]));
  });
});

describe("outbox entry actions", () => {
  it("allows cancelling queued and sent task commands, but not failed or non-task entries", () => {
    const queued = enqueueCommand([], followUp("k-queued")).entry;
    expect(isOutboxEntryCancelable(queued)).toBe(true);
    expect(isOutboxEntryEditable(queued)).toBe(false);

    const sent = { ...queued, state: "sent" as const };
    expect(isOutboxEntryCancelable(sent)).toBe(true);
    expect(isOutboxEntryEditable(sent)).toBe(false);

    const failed = { ...queued, state: "failed" as const };
    expect(isOutboxEntryCancelable(failed)).toBe(false);
    expect(isOutboxEntryEditable(failed)).toBe(true);

    const dismissEntry = enqueueCommand([], { type: "feed.dismiss.set", itemId: "post:p-1", dismissed: true, idempotencyKey: "k-dismiss" }).entry;
    expect(isOutboxEntryCancelable(dismissEntry)).toBe(false);
    expect(isOutboxEntryEditable({ ...dismissEntry, state: "failed" as const })).toBe(false);
  });
});

describe("outbox semantic keys", () => {
  it("matches the shared protocol test vectors", () => {
    for (const testCase of outboxKeysVector.cases) {
      expect(commandSemanticKey(testCase.input as unknown as ClientCommand), testCase.name).toBe(testCase.expected.key);
    }
  });
});
