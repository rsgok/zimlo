import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IntegrationStatus } from "@zimlo/protocol";
import { resolveAgentCommand } from "./agent-command.js";
import { inspectCodexPlugin } from "./codex-plugin.js";
import { applyHookChanges, hookConfigChanges } from "./hook-config.js";

const execFileAsync = promisify(execFile);

async function mcpConfigured(command: string | null, entrypoint: string): Promise<boolean> {
  if (!command) return false;
  try {
    const result = await execFileAsync(command, ["mcp", "get", "zimlo"], { timeout: 5_000, maxBuffer: 512 * 1024 });
    const output = `${result.stdout}\n${result.stderr}`;
    return output.includes(entrypoint) && output.includes(process.execPath);
  } catch {
    return false;
  }
}

function cliStatus(
  id: "codex_cli" | "claude_cli",
  provider: "codex" | "claude",
  available: boolean,
  hooks: boolean,
  mcp: boolean,
): IntegrationStatus {
  const label = provider === "codex" ? "Codex · CLI" : "Claude Code · CLI";
  const state = !available ? "unavailable" : hooks && mcp ? "ready" : hooks || mcp ? "partial" : "unavailable";
  const detail = !available
    ? `尚未发现${provider === "codex" ? " Codex CLI" : " Claude Code"}。`
    : hooks && mcp
    ? "Hooks 与 MCP 已配置；新 CLI 任务会自动接入 Zimlo。"
    : `还需${hooks ? "更新 MCP" : mcp ? "更新 Hooks" : "配置 Hooks 与 MCP"}。`;
  return { id, provider, surface: "cli", state, label, detail };
}

export async function inspectIntegrationStatuses(entrypoint: string): Promise<IntegrationStatus[]> {
  const [codexCommand, claudeCommand] = await Promise.all([
    resolveAgentCommand("codex"),
    resolveAgentCommand("claude"),
  ]);
  const [changes, plugin, codexMcp, claudeMcp] = await Promise.all([
    hookConfigChanges(entrypoint),
    inspectCodexPlugin(entrypoint),
    mcpConfigured(codexCommand, entrypoint),
    mcpConfigured(claudeCommand, entrypoint),
  ]);
  const codexHooks = changes.some((change) => change.path.includes("/.codex/") && JSON.stringify(change.before) === JSON.stringify(change.after));
  const claudeHooks = changes.some((change) => change.path.includes("/.claude/") && JSON.stringify(change.before) === JSON.stringify(change.after));
  const claudeSharedReady = claudeHooks && claudeMcp;
  return [
    {
      id: "codex_gui",
      provider: "codex",
      surface: "gui",
      state: plugin.installed ? "ready" : codexCommand ? "partial" : "unavailable",
      label: "Codex · GUI",
      detail: plugin.detail,
    },
    cliStatus("codex_cli", "codex", codexCommand !== null, codexHooks, codexMcp),
    {
      id: "claude_gui",
      provider: "claude",
      surface: "gui",
      state: claudeSharedReady ? "shared" : claudeCommand ? "partial" : "unavailable",
      label: "Claude Code · GUI",
      detail: claudeSharedReady
        ? "Claude App 与 CLI 共用接入，当前已启用。"
        : claudeCommand
          ? "已发现 Claude Code，但共享 Hooks 或 MCP 尚未配置。"
          : "尚未发现 Claude Code。",
    },
    cliStatus("claude_cli", "claude", claudeCommand !== null, claudeHooks, claudeMcp),
  ];
}

export async function installCliIntegrations(entrypoint: string): Promise<void> {
  const [codexCommand, claudeCommand] = await Promise.all([
    resolveAgentCommand("codex"),
    resolveAgentCommand("claude"),
  ]);
  const providers = [
    ...(codexCommand ? ["codex" as const] : []),
    ...(claudeCommand ? ["claude" as const] : []),
  ];
  if (providers.length === 0) throw new Error("尚未发现 Codex 或 Claude Code。");

  const [codexReady, claudeReady] = await Promise.all([
    mcpConfigured(codexCommand, entrypoint),
    mcpConfigured(claudeCommand, entrypoint),
  ]);
  await applyHookChanges(await hookConfigChanges(entrypoint, false, undefined, providers));
  if (codexCommand && !codexReady) {
    await execFileAsync(codexCommand, ["mcp", "remove", "zimlo"], { timeout: 10_000 }).catch(() => undefined);
    await execFileAsync(codexCommand, ["mcp", "add", "zimlo", "--", process.execPath, entrypoint, "mcp", "--provider", "codex"], { timeout: 10_000 });
  }
  if (claudeCommand && !claudeReady) {
    await execFileAsync(claudeCommand, ["mcp", "remove", "zimlo", "-s", "user"], { timeout: 10_000 }).catch(() => undefined);
    await execFileAsync(claudeCommand, ["mcp", "add", "--scope", "user", "zimlo", "--", process.execPath, entrypoint, "mcp", "--provider", "claude"], { timeout: 10_000 });
  }
}
