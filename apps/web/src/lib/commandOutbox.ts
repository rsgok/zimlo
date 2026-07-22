import type { ClientCommand } from "@zimlo/protocol";

export const COMMAND_OUTBOX_KEY = "zimlo:command-outbox:v1";

const DURABLE_COMMAND_TYPES = new Set<ClientCommand["type"]>([
  "action.decide",
  "session.message",
  "task.create",
  "task.follow_up",
  "task.command.retry",
  "feed.dismiss",
  "agent.profile.update",
]);

export interface CommandOutboxEntry {
  id: string;
  semanticKey: string;
  command: ClientCommand;
  enqueuedAt: string;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function isDurableCommand(command: ClientCommand): boolean {
  return DURABLE_COMMAND_TYPES.has(command.type);
}

function sortedInput(input: Record<string, string> | undefined): string {
  return JSON.stringify(Object.entries(input ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

export function commandSemanticKey(command: ClientCommand): string {
  switch (command.type) {
    case "task.create":
      return `${command.type}:${command.provider}:${command.workspaceId}:${command.text.trim()}`;
    case "task.follow_up":
    case "session.message":
      return `${command.type}:${command.sessionId}:${command.text.trim()}`;
    case "task.command.retry":
      return `${command.type}:${command.commandId}`;
    case "action.decide":
      return `${command.type}:${command.actionId}:${command.decisionId}:${command.confirmationPhrase ?? ""}:${sortedInput(command.input)}`;
    case "feed.dismiss":
      return `${command.type}:${command.itemId}`;
    case "agent.profile.update":
      return `${command.type}:${command.projectId}`;
    default:
      return `${command.type}:${JSON.stringify(command)}`;
  }
}

function commandId(command: ClientCommand): string {
  if ("idempotencyKey" in command) return command.idempotencyKey;
  return `${command.type}:${crypto.randomUUID()}`;
}

export function readCommandOutbox(storage: StorageLike | null = defaultStorage()): CommandOutboxEntry[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(COMMAND_OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is CommandOutboxEntry => Boolean(
      entry && typeof entry === "object"
      && typeof (entry as CommandOutboxEntry).id === "string"
      && typeof (entry as CommandOutboxEntry).semanticKey === "string"
      && typeof (entry as CommandOutboxEntry).enqueuedAt === "string"
      && isDurableCommand((entry as CommandOutboxEntry).command),
    ));
  } catch {
    return [];
  }
}

export function saveCommandOutbox(entries: CommandOutboxEntry[], storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(COMMAND_OUTBOX_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

export function enqueueCommand(
  entries: CommandOutboxEntry[],
  command: ClientCommand,
  now = new Date().toISOString(),
): { entries: CommandOutboxEntry[]; entry: CommandOutboxEntry; added: boolean } {
  const semanticKey = commandSemanticKey(command);
  const existing = entries.find((entry) => entry.semanticKey === semanticKey);
  if (existing) {
    if (command.type === "agent.profile.update") {
      const replacement = { ...existing, command, enqueuedAt: now };
      return { entries: entries.map((entry) => entry.id === existing.id ? replacement : entry), entry: replacement, added: false };
    }
    return { entries, entry: existing, added: false };
  }
  const entry = { id: commandId(command), semanticKey, command, enqueuedAt: now };
  return { entries: [...entries, entry], entry, added: true };
}

export function removeAcknowledged(
  entries: CommandOutboxEntry[],
  predicate: (entry: CommandOutboxEntry) => boolean,
): CommandOutboxEntry[] {
  return entries.filter((entry) => !predicate(entry));
}
