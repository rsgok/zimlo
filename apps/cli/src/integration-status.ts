import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IntegrationStatus } from "@zimlo/protocol";
import { inspectCodexPlugin } from "./codex-plugin.js";
import { applyHookChanges, hookConfigChanges } from "./hook-config.js";

const execFileAsync = promisify(execFile);

async function mcpConfigured(command: "codex" | "claude"): Promise<boolean> {
  try {
    await execFileAsync(command, ["mcp", "get", "zimlo"], { timeout: 5_000, maxBuffer: 512 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function cliStatus(
  id: "codex_cli" | "claude_cli",
  provider: "codex" | "claude",
  hooks: boolean,
  mcp: boolean,
): IntegrationStatus {
  const label = provider === "codex" ? "Codex · CLI" : "Claude Code · CLI";
  const state = hooks && mcp ? "ready" : hooks || mcp ? "partial" : "unavailable";
  const detail = hooks && mcp
    ? "Hooks 与 MCP 已配置；新 CLI 任务会自动接入 Zimlo。"
    : `还需${hooks ? " MCP" : mcp ? " Hooks" : " Hooks 与 MCP"}；Zimlo 不会静默修改用户级配置。`;
  return { id, provider, surface: "cli", state, label, detail };
}

export async function inspectIntegrationStatuses(entrypoint: string): Promise<IntegrationStatus[]> {
  const [changes, plugin, codexMcp, claudeMcp] = await Promise.all([
    hookConfigChanges(entrypoint),
    inspectCodexPlugin(entrypoint),
    mcpConfigured("codex"),
    mcpConfigured("claude"),
  ]);
  const codexHooks = changes.some((change) => change.path.includes("/.codex/") && JSON.stringify(change.before) === JSON.stringify(change.after));
  const claudeHooks = changes.some((change) => change.path.includes("/.claude/") && JSON.stringify(change.before) === JSON.stringify(change.after));
  const claudeSharedReady = claudeHooks && claudeMcp;
  return [
    {
      id: "codex_gui",
      provider: "codex",
      surface: "gui",
      state: plugin.installed ? "ready" : "partial",
      label: "Codex · GUI",
      detail: plugin.installed ? "Personal Plugin 已就绪；新 GUI 任务会带上 Zimlo 工具与 GUI 标记。" : plugin.detail,
    },
    cliStatus("codex_cli", "codex", codexHooks, codexMcp),
    {
      id: "claude_gui",
      provider: "claude",
      surface: "gui",
      state: "shared",
      label: "Claude Code · GUI",
      detail: claudeSharedReady
        ? "当前与 Claude CLI 共用用户级 Hooks 与 MCP；Zimlo 会保留 GUI/CLI 来源，但没有独立插件。"
        : "没有独立插件；当前共用的 Claude 用户级 Hooks 或 MCP 尚未完整配置。",
    },
    cliStatus("claude_cli", "claude", claudeHooks, claudeMcp),
  ];
}

export async function installCliIntegrations(entrypoint: string): Promise<void> {
  const [codexReady, claudeReady] = await Promise.all([mcpConfigured("codex"), mcpConfigured("claude")]);
  await applyHookChanges(await hookConfigChanges(entrypoint));
  if (!codexReady) {
    await execFileAsync("codex", ["mcp", "add", "zimlo", "--", process.execPath, entrypoint, "mcp", "--provider", "codex"], { timeout: 10_000 });
  }
  if (!claudeReady) {
    await execFileAsync("claude", ["mcp", "add", "--scope", "user", "zimlo", "--", process.execPath, entrypoint, "mcp", "--provider", "claude"], { timeout: 10_000 });
  }
}
