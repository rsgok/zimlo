import { access, mkdir } from "node:fs/promises";
import { platform, release } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveAgentCommand } from "./agent-command.js";
import { ZIMLO_PATHS } from "./paths.js";
import { hookConfigChanges } from "./hook-config.js";
import { inspectCodexPlugin } from "./codex-plugin.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function commandVersion(name: string, command: string | null): DoctorCheck {
  if (!command) return { name, ok: false, detail: "未安装" };
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 });
  const detail = (result.stdout || result.stderr || "未安装").trim().split("\n")[0] ?? "未安装";
  return { name, ok: result.status === 0, detail };
}

export async function runDoctor(entrypoint: string): Promise<DoctorCheck[]> {
  const [codexCommand, claudeCommand] = await Promise.all([
    resolveAgentCommand("codex"),
    resolveAgentCommand("claude"),
  ]);
  const checks: DoctorCheck[] = [
    { name: "macOS", ok: platform() === "darwin", detail: `${platform()} ${release()}` },
    { name: "Node.js", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: process.version },
    commandVersion("codex", codexCommand),
    commandVersion("claude", claudeCommand),
  ];
  try {
    await mkdir(ZIMLO_PATHS.logs, { recursive: true, mode: 0o700 });
    await access(ZIMLO_PATHS.root);
    checks.push({ name: "~/.zimlo", ok: true, detail: ZIMLO_PATHS.root });
  } catch (error) {
    checks.push({ name: "~/.zimlo", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    const plugin = await inspectCodexPlugin(entrypoint);
    checks.push({ name: "Codex GUI", ok: plugin.installed, detail: plugin.detail });
  } catch (error) {
    checks.push({ name: "Codex GUI", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    const changes = await hookConfigChanges(entrypoint);
    const installed = changes.every((change) => JSON.stringify(change.before) === JSON.stringify(change.after));
    checks.push({ name: "CLI hooks", ok: installed, detail: installed ? "已安装" : "未安装或指向旧版 Zimlo" });
  } catch (error) {
    checks.push({ name: "hooks", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? "✓" : "!"} ${check.name.padEnd(12)} ${check.detail}`).join("\n");
}
