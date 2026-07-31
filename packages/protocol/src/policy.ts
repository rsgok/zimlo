import type { FeedPost, FeedPostKind, PendingAction, ReviewState, TaskCommandState } from "./index.js";

// Shared feed / outbox / reconnect policy. These rules used to be handwritten
// in apps/web (TypeScript) and apps/ios (Swift) and started to drift; every
// client must now implement this module exactly. packages/protocol/test-vectors
// holds the versioned JSON cases that both the vitest and XCTest suites assert.

// --- Feed ---

export const FEED_MERGE_WINDOW_MS = 6 * 60 * 60 * 1_000;

export const POST_VALUE: Record<FeedPostKind, number> = {
  failure: 1,
  result: 2,
  decision: 3,
  attention: 3,
  progress: 4,
};

// Only progress/decision posts merge; progress/decision/attention posts sink
// once a later outcome covers them.
const ROUTINE_POST_KINDS: readonly FeedPostKind[] = ["progress", "decision"];
const COVERABLE_POST_KINDS: readonly FeedPostKind[] = ["progress", "decision", "attention"];

const COVERED_PRIORITY_PENALTY = 6;
const READ_PRIORITY_PENALTY = 10;

// Merges routine posts newest-first: a progress/decision post folds into the
// newest post with the same `${sessionId ?? taskId}:${kind}` key when it is at
// most FEED_MERGE_WINDOW_MS older, appending deduplicated highlights capped at
// two. The comparison is always against the newest post of the key, so merged
// chains do not extend the window.
export function mergeRoutinePosts(posts: FeedPost[]): FeedPost[] {
  const merged: FeedPost[] = [];
  const latestByKey = new Map<string, number>();
  for (const post of [...posts].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    if (!ROUTINE_POST_KINDS.includes(post.kind)) {
      merged.push(post);
      continue;
    }
    const key = `${post.sessionId ?? post.taskId}:${post.kind}`;
    const existingIndex = latestByKey.get(key);
    const existing = existingIndex === undefined ? undefined : merged[existingIndex];
    const withinWindow = existing && new Date(existing.createdAt).getTime() - new Date(post.createdAt).getTime() <= FEED_MERGE_WINDOW_MS;
    if (!existing || !withinWindow) {
      latestByKey.set(key, merged.length);
      merged.push(post);
      continue;
    }
    merged[existingIndex!] = { ...existing, highlights: [...existing.highlights, ...post.highlights].filter((value, index, all) => all.indexOf(value) === index).slice(0, 2) };
  }
  return merged;
}

export function postNeedsAction(input: {
  actionRequired: boolean;
  hasLinkedPendingAction: boolean;
  directReplyIsCurrent: boolean;
  reviewState: ReviewState | null;
}): boolean {
  return input.reviewState === "unreviewed"
    || (input.actionRequired && (input.hasLinkedPendingAction || input.directReplyIsCurrent));
}

// A coverable post is covered when the task's newest result/failure outcome is
// strictly newer than the post.
export function isPostCovered(input: {
  kind: FeedPostKind;
  createdAt: string;
  latestOutcomeCreatedAt: string | null;
}): boolean {
  return COVERABLE_POST_KINDS.includes(input.kind)
    && (input.latestOutcomeCreatedAt ?? "") > input.createdAt;
}

export function postPriority(input: {
  kind: FeedPostKind;
  needsAction: boolean;
  covered: boolean;
  unread: boolean;
}): number {
  if (input.needsAction) return 0;
  return POST_VALUE[input.kind]
    + (input.covered ? COVERED_PRIORITY_PENALTY : 0)
    + (input.unread ? 0 : READ_PRIORITY_PENALTY);
}

export interface FeedOrderable {
  priority: number;
  createdAt: string;
}

// Ascending priority, then newest first. Feed building sorts with a stable
// sort, so items equal on both keys keep their input order.
export function compareFeedItems(left: FeedOrderable, right: FeedOrderable): number {
  return left.priority - right.priority || right.createdAt.localeCompare(left.createdAt);
}

// --- Command outbox semantic keys ---
//
// Dedupe keys for durable outbox commands, as the union of the web
// (commandOutbox.ts) and iOS (AppModel.swift) rules:
// - every string field is trimmed before joining (iOS trimmed all fields, web
//   only free text; ids are machine-generated, so trimming changes nothing)
// - action.decide sorts its input record by key (code-unit order, not locale)
//   so JSON field order never changes the key
// - feed.seen / task.timeline.seen keys come from the iOS rule set, the
//   action.decide sorted-input rule from web
// - unknown command types fall back to a recursively key-sorted JSON encoding
//   of the command fields (type excluded, it is already the key prefix),
//   replacing web's insertion-order JSON.stringify and iOS's random UUID so
//   the fallback is deterministic too

export type SemanticCommandFields = { type: string } & Record<string, unknown>;

export function semanticCommandKey(command: SemanticCommandFields): string {
  switch (command.type) {
    case "task.create":
      return `${command.type}:${textField(command, "provider")}:${textField(command, "workspaceId")}:${textField(command, "text")}`;
    case "task.follow_up":
    case "session.message":
      return `${command.type}:${textField(command, "sessionId")}:${textField(command, "text")}`;
    case "task.command.retry":
      return `${command.type}:${textField(command, "commandId")}`;
    case "task.command.cancel":
      return `${command.type}:${textField(command, "commandId") || textField(command, "idempotencyKey")}`;
    case "action.decide":
      return `${command.type}:${textField(command, "actionId")}:${textField(command, "decisionId")}:${textField(command, "confirmationPhrase")}:${sortedInput(command.input)}`;
    case "feed.dismiss":
    case "feed.dismiss.set":
      return `${command.type}:${textField(command, "itemId")}`;
    case "feed.seen":
      return `${command.type}:${textField(command, "postId")}`;
    case "task.timeline.seen":
      return `${command.type}:${textField(command, "sessionId")}:${textField(command, "itemId")}`;
    case "agent.profile.update":
    case "trust.policy.update":
      return `${command.type}:${textField(command, "projectId")}`;
    case "user.profile.update":
    case "notification.settings.update":
    case "notification.device.register":
    case "notification.device.unregister":
      return command.type;
    case "review.respond":
      return `${command.type}:${textField(command, "reviewId")}:${textField(command, "decision")}:${textField(command, "note")}`;
    default: {
      const { type: _, ...fields } = command;
      return `${command.type}:${stableStringify(fields)}`;
    }
  }
}

function textField(command: Record<string, unknown>, key: string): string {
  const value = command[key];
  return typeof value === "string" ? value.trim() : "";
}

function sortedInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "[]";
  const entries = Object.entries(input as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => compareCodeUnits(left, right));
  return JSON.stringify(entries);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// --- Command cancellation ---

// Only queued commands may be canceled; dispatching/running already reached the
// agent and the terminal states are settled.
export const CANCELABLE_COMMAND_STATES: readonly TaskCommandState[] = ["queued"];

export function isCommandCancelable(state: TaskCommandState): boolean {
  return CANCELABLE_COMMAND_STATES.includes(state);
}

// --- Reconnect backoff ---

export const BACKOFF_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export const BACKOFF_JITTER_RATIO = 0.2;

// attempt 0 is the first retry; attempts past the schedule clamp to the last
// delay. A symmetric ±20% jitter (injectable random for tests) keeps
// reconnecting clients from synchronizing.
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(Math.trunc(attempt), 0), BACKOFF_DELAYS_MS.length - 1);
  const base = BACKOFF_DELAYS_MS[index]!;
  return Math.round(base * (1 + (random() * 2 - 1) * BACKOFF_JITTER_RATIO));
}

// --- Quick approval ---

// A pending action qualifies for one-tap approval from a notification or feed
// card only when it is an approval offering an explicit low-risk allow-once
// decision and a deny decision, neither requiring a confirmation phrase.
export function isQuickApprovable(action: Pick<PendingAction, "kind" | "availableDecisions">): boolean {
  if (action.kind !== "approval") return false;
  const allowOnce = action.availableDecisions.find((decision) => decision.scope === "once");
  const deny = action.availableDecisions.find((decision) => decision.scope === "deny");
  return Boolean(
    allowOnce && allowOnce.risk === "low" && !allowOnce.confirmationPhrase
    && deny && !deny.confirmationPhrase,
  );
}
