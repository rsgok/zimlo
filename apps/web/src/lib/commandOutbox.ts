import type { ClientCommand } from "@zimlo/protocol";
import { semanticCommandKey } from "@zimlo/protocol";

export const COMMAND_OUTBOX_KEY = "zimlo:command-outbox:v1";

const DURABLE_COMMAND_TYPES = new Set<ClientCommand["type"]>([
  "action.decide",
  "session.message",
  "task.create",
  "task.follow_up",
  "task.command.retry",
  "task.command.cancel",
  "feed.dismiss",
  "feed.dismiss.set",
  "task.pin",
  "task.archive",
  "user.profile.update",
  "agent.profile.update",
  "review.respond",
  "trust.policy.update",
  "notification.settings.update",
  "notification.device.register",
  "notification.device.unregister",
]);

// queued：只持久化在本机、尚未发给 Bridge；sent：已发送、等待服务端确认；
// failed：服务端明确拒绝，等待用户重试或重新编辑。
export type CommandOutboxEntryState = "queued" | "sent" | "failed";

export interface CommandOutboxEntry {
  id: string;
  semanticKey: string;
  command: ClientCommand;
  enqueuedAt: string;
  state?: CommandOutboxEntryState | undefined;
  error?: string | undefined;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type MutableStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function defaultStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function isDurableCommand(command: ClientCommand): boolean {
  return DURABLE_COMMAND_TYPES.has(command.type);
}

export function commandSemanticKey(command: ClientCommand): string {
  return semanticCommandKey(command);
}

function commandId(command: ClientCommand): string {
  if (command.type === "task.command.cancel") return commandSemanticKey(command);
  if ("idempotencyKey" in command && command.idempotencyKey !== undefined) return command.idempotencyKey;
  return `${command.type}:${crypto.randomUUID()}`;
}

const DEVICE_DATA_EXACT_KEYS = new Set([COMMAND_OUTBOX_KEY, "zimlo:new-task-draft"]);
const DEVICE_DATA_PREFIXES = ["zimlo:task-draft:", "zimlo:feed-reply:", "zimlo:action-draft:"];

// 解除配对时删除设备身份关联的数据；最近 workspace/runtime 等纯界面偏好保留。
export function clearDeviceLocalData(storage: MutableStorageLike | null = typeof window === "undefined" ? null : window.localStorage): void {
  if (!storage) return;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && (DEVICE_DATA_EXACT_KEYS.has(key) || DEVICE_DATA_PREFIXES.some((prefix) => key.startsWith(prefix)))) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
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

// 同一语义键的最新意图直接替换未确认条目（最后写入胜出）的命令类型。
const REPLACEABLE_COMMAND_TYPES = new Set<ClientCommand["type"]>([
  "agent.profile.update",
  "user.profile.update",
  "trust.policy.update",
  "notification.settings.update",
  "notification.device.register",
  "feed.dismiss.set",
]);

export function enqueueCommand(
  entries: CommandOutboxEntry[],
  command: ClientCommand,
  now = new Date().toISOString(),
): { entries: CommandOutboxEntry[]; entry: CommandOutboxEntry; added: boolean } {
  const key = commandSemanticKey(command);
  const existing = entries.find((entry) => entry.semanticKey === key);
  if (existing) {
    if (REPLACEABLE_COMMAND_TYPES.has(command.type)) {
      const replacement: CommandOutboxEntry = { ...existing, command, enqueuedAt: now, state: "queued" };
      delete replacement.error;
      return { entries: entries.map((entry) => entry.id === existing.id ? replacement : entry), entry: replacement, added: false };
    }
    return { entries, entry: existing, added: false };
  }
  const entry: CommandOutboxEntry = { id: commandId(command), semanticKey: key, command, enqueuedAt: now, state: "queued" };
  return { entries: [...entries, entry], entry, added: true };
}

export function removeAcknowledged(
  entries: CommandOutboxEntry[],
  predicate: (entry: CommandOutboxEntry) => boolean,
): CommandOutboxEntry[] {
  return entries.filter((entry) => !predicate(entry));
}

export function patchOutboxEntries(
  entries: CommandOutboxEntry[],
  predicate: (entry: CommandOutboxEntry) => boolean,
  patch: (entry: CommandOutboxEntry) => CommandOutboxEntry,
): CommandOutboxEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (!predicate(entry)) return entry;
    changed = true;
    return patch(entry);
  });
  return changed ? next : entries;
}

// 仅 create / follow-up / session.message 可以撤回：queued 条目直接本地移除，
// 已发送的通过 task.command.cancel 按幂等键取消（服务端只对 queued 生效）。
const CANCELABLE_OUTBOX_TYPES = new Set<ClientCommand["type"]>(["task.create", "task.follow_up", "session.message"]);

export function isOutboxEntryCancelable(entry: CommandOutboxEntry): boolean {
  return CANCELABLE_OUTBOX_TYPES.has(entry.command.type) && entry.state !== "failed";
}

// 服务端拒绝后允许重试（原样重发）或重新编辑（恢复草稿）的文本类命令。
export function isOutboxEntryEditable(entry: CommandOutboxEntry): boolean {
  return entry.state === "failed" && CANCELABLE_OUTBOX_TYPES.has(entry.command.type);
}

export function isOutboxEntryDiscardable(entry: CommandOutboxEntry): boolean {
  return entry.state === "failed" && !isOutboxEntryEditable(entry);
}

export function outboxEntryIdempotencyKey(entry: CommandOutboxEntry): string | null {
  const command = entry.command;
  return "idempotencyKey" in command && typeof command.idempotencyKey === "string" ? command.idempotencyKey : null;
}
