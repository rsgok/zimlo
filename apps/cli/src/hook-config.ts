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
  const configured = appendHooks({}, CODEX_PLUGIN_EVENTS, zimloHookCommand(entrypoint, "codex", nodePath), "codex");
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

export function zimloHookCommand(entrypoint: string, provider: "codex" | "claude", nodePath = process.execPath): string {
  return `${shellQuote(nodePath)} ${shellQuote(entrypoint)} hook --provider ${provider}`;
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

export async function hookConfigChanges(entrypoint: string, uninstall = false): Promise<HookConfigChange[]> {
  const home = homedir();
  const codexPath = join(home, ".codex", "hooks.json");
  const claudePath = join(home, ".claude", "settings.json");
  const codexBefore = await readJson(codexPath);
  const claudeBefore = await readJson(claudePath);
  const codexCommand = zimloHookCommand(entrypoint, "codex");
  const claudeCommand = zimloHookCommand(entrypoint, "claude");
  return [
    {
      path: codexPath,
      before: codexBefore,
      after: uninstall ? removeCommand(codexBefore, codexCommand) : appendHooks(codexBefore, CODEX_EVENTS, codexCommand, "codex"),
    },
    {
      path: claudePath,
      before: claudeBefore,
      after: uninstall ? removeCommand(claudeBefore, claudeCommand) : appendHooks(claudeBefore, CLAUDE_EVENTS, claudeCommand, "claude"),
    },
  ];
}

export async function applyHookChanges(changes: HookConfigChange[]): Promise<void> {
  for (const change of changes) {
    await mkdir(dirname(change.path), { recursive: true, mode: 0o700 });
    if (existsSync(change.path)) {
      const backup = `${change.path}.zimlo-backup-${new Date().toISOString().replaceAll(":", "-")}`;
      await writeFile(backup, `${JSON.stringify(change.before, null, 2)}\n`, { mode: 0o600 });
    }
    const temporary = `${change.path}.zimlo-${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(change.after, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, change.path);
  }
}

export function formatHookChanges(changes: HookConfigChange[]): string {
  return changes.map((change) => {
    const unchanged = JSON.stringify(change.before) === JSON.stringify(change.after);
    return `${change.path}${unchanged ? " (无变化)" : ""}\n${JSON.stringify(change.after.hooks ?? {}, null, 2)}`;
  }).join("\n\n");
}
