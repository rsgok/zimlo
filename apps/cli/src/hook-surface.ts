import { execFileSync } from "node:child_process";
import type { SessionSurface } from "@zimlo/protocol";

interface ProcessParent {
  pid: number;
  ppid: number;
  tty: string;
  command: string;
}

export function surfaceFromProcessChain(chain: ProcessParent[]): SessionSurface {
  if (chain.some((process) => process.tty && process.tty !== "??" && process.tty !== "?")) return "cli";
  if (chain.some((process) => /(?:\/Applications\/[^\n]*Claude(?: Code)?\.app\/|Claude(?: Code)? Helper)/u.test(process.command))) return "gui";
  return "unknown";
}

export function detectHookSurface(startPid = process.ppid): SessionSurface {
  const chain: ProcessParent[] = [];
  let pid = startPid;
  for (let depth = 0; depth < 6 && pid > 1; depth += 1) {
    try {
      const output = execFileSync("/bin/ps", ["-o", "ppid=,tty=,command=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 500,
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
