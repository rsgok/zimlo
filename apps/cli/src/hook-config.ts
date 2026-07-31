import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type JsonObject = Record<string, unknown>;

export interface HookConfigChange {
  path: string;
  before: JsonObject;
  after: JsonObject;
}

const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"] as const;
const CODEX_PLUGIN_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop"] as const;
const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;

export function codexPluginHooks(entrypoint: string, nodePath = process.execPath): JsonObject {
  const configured = appendHooks({}, CODEX_PLUGIN_EVENTS, zimloHookCommand(entrypoint, "codex", "gui", nodePath), "codex");
  return {
    description: "Zimlo Feed checkpoints and action bridge for Codex",
    hooks: configured.hooks ?? {},
  };
}

function clone(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

async function readJson(path: string): Promise<JsonObject> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as JsonObject;
  } catch (error) {
    if (!existsSync(path)) return {};
    throw new Error(`无法解析 ${path}，请先修复该 JSON 文件。`, { cause: error });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function zimloHookCommand(
  entrypoint: string,
  provider: "codex" | "claude",
  surface: "gui" | "cli" | "auto" = "cli",
  nodePath = process.execPath,
): string {
  return `${shellQuote(nodePath)} ${shellQuote(entrypoint)} hook --provider ${provider} --surface ${surface}`;
}

function appendHooks(
  root: JsonObject,
  events: readonly string[],
  command: string,
  provider: "codex" | "claude",
): JsonObject {
  const next = clone(root);
  const hooks = next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks)
    ? (next.hooks as JsonObject)
    : {};
  next.hooks = hooks;
  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const alreadyInstalled = groups.some((rawGroup) => {
      if (!rawGroup || typeof rawGroup !== "object") return false;
      const handlers = (rawGroup as JsonObject).hooks;
      return Array.isArray(handlers) && handlers.some((rawHandler) => {
        return rawHandler && typeof rawHandler === "object" && (rawHandler as JsonObject).command === command;
      });
    });
    if (alreadyInstalled) continue;
    const handler: JsonObject = {
      type: "command",
      command,
      timeout: event === "PermissionRequest" || event === "PreToolUse" ? 480 : event === "Stop" ? 3 : 5,
      statusMessage: event === "PermissionRequest" ? "Waiting for Zimlo approval" : "Updating Zimlo",
    };
    const group: JsonObject = { hooks: [handler] };
    if (["SessionStart"].includes(event)) group.matcher = "startup|resume|clear|compact";
    if (["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"].includes(event)) group.matcher = "*";
    groups.push(group);
    hooks[event] = groups;
  }
  return next;
}

function removeCommand(root: JsonObject, command: string): JsonObject {
  const next = clone(root);
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) return next;
  const hooks = next.hooks as JsonObject;
  for (const [event, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) continue;
    const groups = rawGroups.flatMap((rawGroup) => {
      if (!rawGroup || typeof rawGroup !== "object") return [rawGroup];
      const group = clone(rawGroup as JsonObject);
      if (!Array.isArray(group.hooks)) return [group];
      const remaining = group.hooks.filter((rawHandler) => {
        return !(rawHandler && typeof rawHandler === "object" && (rawHandler as JsonObject).command === command);
      });
      group.hooks = remaining;
      return remaining.length > 0 ? [group] : [];
    });
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  return next;
}

function removeZimloCommands(root: JsonObject, provider: "codex" | "claude"): JsonObject {
  const next = clone(root);
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) return next;
  const hooks = next.hooks as JsonObject;
  for (const [event, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) continue;
    const groups = rawGroups.flatMap((rawGroup) => {
      if (!rawGroup || typeof rawGroup !== "object") return [rawGroup];
      const group = clone(rawGroup as JsonObject);
      if (!Array.isArray(group.hooks)) return [group];
      const remaining = group.hooks.filter((rawHandler) => {
        if (!rawHandler || typeof rawHandler !== "object") return true;
        const command = (rawHandler as JsonObject).command;
        if (typeof command !== "string") return true;
        return !/zimlo/iu.test(command) || !command.includes(`hook --provider ${provider}`);
      });
      group.hooks = remaining;
      return remaining.length > 0 ? [group] : [];
    });
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  return next;
}

export async function hookConfigChanges(
  entrypoint: string,
  uninstall = false,
  home = homedir(),
  providers: readonly ("codex" | "claude")[] = ["codex", "claude"],
): Promise<HookConfigChange[]> {
  const codexPath = join(home, ".codex", "hooks.json");
  const claudePath = join(home, ".claude", "settings.json");
  const codexBefore = await readJson(codexPath);
  const claudeBefore = await readJson(claudePath);
  const codexCommand = zimloHookCommand(entrypoint, "codex", "cli");
  const claudeCommand = zimloHookCommand(entrypoint, "claude", "auto");
  const codexWithoutZimlo = removeZimloCommands(codexBefore, "codex");
  const claudeWithoutZimlo = removeZimloCommands(claudeBefore, "claude");
  return [
    {
      provider: "codex" as const,
      path: codexPath,
      before: codexBefore,
      after: uninstall
        ? removeCommand(codexWithoutZimlo, codexCommand)
        : appendHooks(codexWithoutZimlo, CODEX_EVENTS, codexCommand, "codex"),
    },
    {
      provider: "claude" as const,
      path: claudePath,
      before: claudeBefore,
      after: uninstall
        ? removeCommand(claudeWithoutZimlo, claudeCommand)
        : appendHooks(claudeWithoutZimlo, CLAUDE_EVENTS, claudeCommand, "claude"),
    },
  ].filter((change) => providers.includes(change.provider))
    .map(({ provider: _provider, ...change }) => change);
}

export interface AppliedHookChange {
  path: string;
  changed: boolean;
  backupPath: string | null;
}

export async function applyHookChanges(changes: HookConfigChange[]): Promise<AppliedHookChange[]> {
  const applied: AppliedHookChange[] = [];
  for (const change of changes) {
    const changed = JSON.stringify(change.before) !== JSON.stringify(change.after);
    if (!changed) {
      applied.push({ path: change.path, changed, backupPath: null });
      continue;
    }
    await mkdir(dirname(change.path), { recursive: true, mode: 0o700 });
    let backupPath: string | null = null;
    if (existsSync(change.path)) {
      backupPath = `${change.path}.zimlo-backup-${new Date().toISOString().replaceAll(":", "-")}`;
      await writeFile(backupPath, `${JSON.stringify(change.before, null, 2)}\n`, { mode: 0o600 });
    }
    const temporary = `${change.path}.zimlo-${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(change.after, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, change.path);
    applied.push({ path: change.path, changed, backupPath });
  }
  return applied;
}

function hookCommandsByEvent(config: JsonObject): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return result;
  for (const [event, rawGroups] of Object.entries(hooks as JsonObject)) {
    if (!Array.isArray(rawGroups)) continue;
    const commands = rawGroups.flatMap((rawGroup) => {
      if (!rawGroup || typeof rawGroup !== "object") return [];
      const handlers = (rawGroup as JsonObject).hooks;
      if (!Array.isArray(handlers)) return [];
      return handlers
        .map((handler) => (handler && typeof handler === "object" ? (handler as JsonObject).command : null))
        .filter((command): command is string => typeof command === "string");
    });
    result.set(event, commands);
  }
  return result;
}

// `zimlo hooks diff` 的默认输出：每个文件按事件汇总新增/移除/保留的 hook
// 条目，不 dump 完整 JSON（--json 才输出 formatHookChanges 的完整结构）。
export function formatHookChangesSummary(changes: HookConfigChange[]): string {
  return changes.map((change) => {
    if (JSON.stringify(change.before) === JSON.stringify(change.after)) {
      return `${change.path}（已是最新，无变化）`;
    }
    const before = hookCommandsByEvent(change.before);
    const after = hookCommandsByEvent(change.after);
    const lines = [change.path];
    let added = 0;
    let removed = 0;
    let kept = 0;
    for (const event of new Set([...before.keys(), ...after.keys()])) {
      const beforeCommands = new Set(before.get(event) ?? []);
      const afterCommands = new Set(after.get(event) ?? []);
      const addedCommands = [...afterCommands].filter((command) => !beforeCommands.has(command));
      const removedCommands = [...beforeCommands].filter((command) => !afterCommands.has(command));
      kept += [...afterCommands].filter((command) => beforeCommands.has(command)).length;
      added += addedCommands.length;
      removed += removedCommands.length;
      if (addedCommands.length > 0) lines.push(`  + ${event}：新增 ${addedCommands.length} 条 hook`);
      if (removedCommands.length > 0) lines.push(`  - ${event}：移除 ${removedCommands.length} 条 hook`);
    }
    lines.push(`  合计：新增 ${added} 条，移除 ${removed} 条，保留 ${kept} 条。`);
    return lines.join("\n");
  }).join("\n\n");
}

export function formatHookChanges(changes: HookConfigChange[]): string {
  return changes.map((change) => {
    const unchanged = JSON.stringify(change.before) === JSON.stringify(change.after);
    return `${change.path}${unchanged ? " (无变化)" : ""}\n${JSON.stringify(change.after.hooks ?? {}, null, 2)}`;
  }).join("\n\n");
}
