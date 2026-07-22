import { describe, expect, it } from "vitest";
import type { ClientCommand } from "@zimlo/protocol";
import {
  COMMAND_OUTBOX_KEY,
  commandSemanticKey,
  enqueueCommand,
  readCommandOutbox,
  removeAcknowledged,
  saveCommandOutbox,
} from "./commandOutbox";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
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
});
