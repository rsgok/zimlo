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

export async function bridgeProtocolVersion(socketPath: string | NetConnectOpts, timeoutMs = 400): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const socket = typeof socketPath === "string" ? createConnection(socketPath) : createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (version: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(version);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "bridge_info" })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(buffer.slice(0, newline)) as { protocolVersion?: unknown };
        finish(typeof value.protocolVersion === "number" ? value.protocolVersion : null);
      } catch {
        finish(null);
      }
    });
    socket.once("error", () => finish(null));
  });
}

export async function ensureBridgeRunning(options: BridgeSupervisorOptions): Promise<boolean> {
  if (await isBridgeSocketReachable(options.socketPath)) {
    const protocolVersion = await bridgeProtocolVersion(options.socketPath);
    if (protocolVersion === 2) return true;
    throw new Error("Zimlo Bridge 版本过旧，请停止旧进程并重新打开 Zimlo。");
  }

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
