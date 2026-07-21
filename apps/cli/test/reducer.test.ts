import { describe, expect, it } from "vitest";
import type { PendingAction, UnifiedEvent } from "@zimlo/protocol";
import { reduceEventToCard } from "../src/reducer.js";

function event(kind: UnifiedEvent["kind"], itemId: string): UnifiedEvent {
  return {
    id: `event-${itemId}`,
    sequence: 1,
    provider: "codex",
    sessionId: "session-a",
    providerSessionId: "provider-a",
    turnId: "turn-a",
    itemId,
    kind,
    source: "hook",
    occurredAt: "2026-07-20T00:00:00.000Z",
    payload: { command: "pnpm test" },
    provenance: "verified",
  };
}

function action(actionId: string, kind: PendingAction["kind"]): PendingAction {
  return {
    actionId,
    sessionId: "session-a",
    kind,
    title: "Attention",
    detail: "Exact request",
    availableDecisions: [],
    expiresAt: "2026-07-20T00:08:00.000Z",
    state: "pending",
    createdAt: "2026-07-20T00:00:00.000Z",
  };
}

describe("feed reducer", () => {
  it("upserts regular events by session, turn and five-card category", () => {
    expect(reduceEventToCard(event("command_started", "a")).id)
      .toBe(reduceEventToCard(event("command_completed", "b")).id);
  });

  it("keeps simultaneous input and approval requests independent", () => {
    const first = reduceEventToCard(event("needs_input", "a"), action("action-a", "input"));
    const second = reduceEventToCard(event("needs_approval", "b"), action("action-b", "approval"));
    expect(first.id).not.toBe(second.id);
    expect(first.actionIds).toEqual(["action-a"]);
    expect(second.actionIds).toEqual(["action-b"]);
  });

  it("never upgrades an agent-reported result to verified", () => {
    const reported = { ...event("completed", "a"), provenance: "agent_reported" as const };
    expect(reduceEventToCard(reported).provenance).toBe("agent_reported");
  });
});
