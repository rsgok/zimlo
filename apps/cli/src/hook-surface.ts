import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { SessionSurface } from "@zimlo/protocol";

interface ProcessParent {
  pid: number;
  ppid: number;
  tty: string;
  command: string;
}

const CODEX_VALUE_OPTIONS = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
  "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile",
  "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);

function isCodexCli(command: string): boolean {
  const [executable, ...args] = command.trim().split(/\s+/u);
  if (basename(executable ?? "") !== "codex") return false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") return true;
    if (CODEX_VALUE_OPTIONS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    // Only the subcommand can identify an app server. Later positional
    // arguments belong to the selected command or the user's prompt.
    return argument !== "app-server";
  }
  return true;
}

export function surfaceFromProcessChain(chain: ProcessParent[]): SessionSurface {
  if (chain.some((process) => process.tty && process.tty !== "??" && process.tty !== "?")) return "cli";
  // The desktop bundle also supplies the CLI executable. Its installation
  // path does not make a headless CLI invocation a desktop session.
  if (chain.some((process) => isCodexCli(process.command))) return "cli";
  if (chain.some((process) => /(?:\/Applications\/[^\n]*(?:Claude(?: Code)?|ChatGPT|Codex)\.app\/|(?:Claude(?: Code)?|ChatGPT|Codex) Helper)/u.test(process.command))) return "gui";
  return "unknown";
}

export function detectHookSurface(startPid = process.ppid): SessionSurface {
  const chain: ProcessParent[] = [];
  let pid = startPid;
  const deadline = Date.now() + 500;
  for (let depth = 0; depth < 8 && pid > 1 && Date.now() < deadline; depth += 1) {
    try {
      const output = execFileSync("/bin/ps", ["-o", "ppid=,tty=,command=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: Math.max(1, deadline - Date.now()),
      }).trim();
      const match = output.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/u);
      if (!match) break;
      const parent = { pid, ppid: Number(match[1]), tty: match[2] ?? "?", command: match[3] ?? "" };
      chain.push(parent);
      pid = parent.ppid;
    } catch {
      break;
    }
  }
  return surfaceFromProcessChain(chain);
}
