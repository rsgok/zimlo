import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createConnection, type NetConnectOpts } from "node:net";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

export interface BridgeSupervisorOptions {
  entrypoint: string;
  socketPath: string | NetConnectOpts;
  logPath: string;
  startupTimeoutMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isBridgeSocketReachable(socketPath: string | NetConnectOpts, timeoutMs = 250): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = typeof socketPath === "string" ? createConnection(socketPath) : createConnection(socketPath);
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function ensureBridgeRunning(options: BridgeSupervisorOptions): Promise<boolean> {
  if (await isBridgeSocketReachable(options.socketPath)) return true;

  await mkdir(dirname(options.logPath), { recursive: true, mode: 0o700 });
  const logFd = openSync(options.logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [options.entrypoint, "start"], {
      detached: true,
      env: { ...process.env, ZIMLO_AUTOSTARTED: "1" },
      stdio: ["ignore", logFd, logFd],
    });
    child.once("error", () => undefined);
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const deadline = Date.now() + (options.startupTimeoutMs ?? 4_000);
  while (Date.now() < deadline) {
    if (await isBridgeSocketReachable(options.socketPath)) return true;
    await delay(100);
  }
  return false;
}
