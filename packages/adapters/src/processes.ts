import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);
const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$/u;

function detectProvider(command: string): ProcessSnapshot["provider"] | null {
  const executable = command.trim().split(/\s+/u)[0]?.split("/").pop();
  if (executable === "codex") return "codex";
  if (executable === "claude") return "claude";
  return null;
}

function providerSessionId(provider: ProcessSnapshot["provider"], command: string): string | null {
  const pattern = provider === "claude"
    ? /(?:^|\s)(?:--resume|-r)\s+([0-9a-f-]{8,})\b/iu
    : /(?:^|\s)(?:exec\s+)?resume\s+([0-9a-f-]{8,})\b/iu;
  return command.match(pattern)?.[1] ?? null;
}

function sessionBearing(provider: ProcessSnapshot["provider"], command: string): boolean {
  if (provider === "claude") return true;
  return !/(?:^|\s)(?:app-server|sandbox)(?:\s|$)/u.test(command);
}

export function classifyAgentCommand(command: string): {
  provider: ProcessSnapshot["provider"];
  providerSessionId: string | null;
  sessionBearing: boolean;
} | null {
  const provider = detectProvider(command);
  if (!provider) return null;
  return {
    provider,
    providerSessionId: providerSessionId(provider, command),
    sessionBearing: sessionBearing(provider, command),
  };
}

async function lsofDetails(pid: number): Promise<{ cwd: string | null; transcriptPaths: string[] }> {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-p", String(pid), "-Fn"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    let cwd: string | null = null;
    const transcriptPaths: string[] = [];
    let currentDescriptor = "";
    for (const line of stdout.split("\n")) {
      if (line.startsWith("f")) currentDescriptor = line.slice(1);
      if (!line.startsWith("n")) continue;
      const path = line.slice(1);
      if (currentDescriptor === "cwd") cwd = path;
      if (/\.(?:codex\/sessions|claude\/projects)\//u.test(path) && path.endsWith(".jsonl")) {
        transcriptPaths.push(path);
      }
    }
    return { cwd, transcriptPaths };
  } catch {
    return { cwd: null, transcriptPaths: [] };
  }
}

export async function scanAgentProcesses(): Promise<ProcessSnapshot[]> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,tty=,command="], {
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return [];
  }

  const base = stdout
    .split("\n")
    .map((line) => line.match(PROCESS_LINE))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => {
      const command = match[5] ?? "";
      const classification = classifyAgentCommand(command);
      if (!classification) return null;
      const started = new Date(match[3] ?? "");
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        provider: classification.provider,
        startedAt: Number.isNaN(started.getTime()) ? new Date().toISOString() : started.toISOString(),
        tty: match[4] === "??" ? null : (match[4] ?? null),
        command,
        providerSessionId: classification.providerSessionId,
        sessionBearing: classification.sessionBearing,
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  return Promise.all(
    base.map(async (process) => ({ ...process, ...(await lsofDetails(process.pid)) })),
  );
}
