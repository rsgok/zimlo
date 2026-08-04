import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const COMMON_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  join(homedir(), ".local", "bin"),
  join(homedir(), ".nvm", "current", "bin"),
];

const APP_BINARIES: Record<"codex" | "claude", string[]> = {
  codex: [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ],
  claude: [
    "/Applications/Claude.app/Contents/Resources/claude",
  ],
};

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAgentCommand(command: "codex" | "claude"): Promise<string | null> {
  const override = process.env[command === "codex" ? "ZIMLO_CODEX_BIN" : "ZIMLO_CLAUDE_BIN"]?.trim();
  if (override) return await executable(override) ? override : null;

  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = [
    ...APP_BINARIES[command],
    ...pathDirs.map((directory) => join(directory, command)),
    ...COMMON_BIN_DIRS.map((directory) => join(directory, command)),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await executable(candidate)) return candidate;
  }
  return null;
}

export async function requireAgentCommand(command: "codex" | "claude"): Promise<string> {
  const resolved = await resolveAgentCommand(command);
  if (resolved) return resolved;

  const label = command === "codex" ? "Codex" : "Claude Code";
  throw new Error(`未找到 ${label} Runtime。请确认应用已安装，或在 Zimlo 设置中检查 Runtime 接入。`);
}

export async function detectInstalledProviders(): Promise<Array<"codex" | "claude">> {
  const [codexCommand, claudeCommand] = await Promise.all([
    resolveAgentCommand("codex"),
    resolveAgentCommand("claude"),
  ]);
  return [
    ...(codexCommand ? ["codex" as const] : []),
    ...(claudeCommand ? ["claude" as const] : []),
  ];
}
