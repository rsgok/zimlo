// Live inspection of the local Bridge for `zimlo status`, `zimlo stop`,
// `zimlo open` and `zimlo doctor`. Every probe is injectable so tests can run
// without a real Bridge, and ownership checks only ever trust state Zimlo
// wrote itself (service descriptor + instance lock) — a foreign process
// squatting on the port is reported, never signaled.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { isBridgeSocketReachable } from "./bridge-supervisor.js";
import { readServiceLockOwner } from "./service-instance.js";
import {
  isManualStopSet,
  markManualStop,
  readServiceDescriptor,
  readStartupDiagnostics,
  type ServiceDescriptor,
  type StartupDiagnostics,
} from "./service-state.js";

const execFileAsync = promisify(execFile);

export type ServiceOwnership = "verified" | "unverifiable" | "stale" | "not_running";

export interface HealthzResult {
  ok: boolean;
  version?: string;
  protocolVersion?: number;
}

export interface PortOwner {
  pid: number;
  command: string;
}

export interface ServiceInspection {
  descriptor: ServiceDescriptor | null;
  diagnostics: StartupDiagnostics | null;
  manualStop: boolean;
  pidAlive: boolean;
  ownership: ServiceOwnership;
  port: number;
  portReachable: boolean;
  portOwner: PortOwner | null;
  health: HealthzResult | null;
  socketExists: boolean;
  socketReachable: boolean;
  logPath: string | null;
}

export function isServiceOperational(info: ServiceInspection, protocolVersion: number): boolean {
  return info.ownership === "verified"
    && info.pidAlive
    && info.health?.ok === true
    && info.health.protocolVersion === protocolVersion;
}

export interface ServiceInspectOptions {
  servicePath: string;
  lockPath: string;
  socketPath: string;
  diagnosticsPath: string;
  manualStopPath: string;
  defaultPort?: number;
  fetchImpl?: typeof fetch;
  alive?: (pid: number) => boolean;
  tcpProbe?: (port: number, timeoutMs?: number) => Promise<boolean>;
  socketProbe?: (socketPath: string) => Promise<boolean>;
  lookupPortOwner?: (port: number) => Promise<PortOwner | null>;
  logPath?: string | null;
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isTcpPortReachable(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
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

export async function fetchHealthz(port: number, fetchImpl: typeof fetch = fetch): Promise<HealthzResult> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return { ok: false };
    const body = await response.json() as { ok?: unknown; version?: unknown; protocolVersion?: unknown };
    return {
      ok: body.ok === true,
      ...(typeof body.version === "string" ? { version: body.version } : {}),
      ...(typeof body.protocolVersion === "number" ? { protocolVersion: body.protocolVersion } : {}),
    };
  } catch {
    return { ok: false };
  }
}

// Parses `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pc` (same format the macOS
// app's PortOwnerLookup uses). Best-effort and macOS-only; null elsewhere.
export async function lookupPortOwner(port: number): Promise<PortOwner | null> {
  if (process.platform !== "darwin") return null;
  try {
    const result = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"], { timeout: 3_000 });
    let pid: number | null = null;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("c") && pid !== null && Number.isInteger(pid)) {
        return { pid, command: line.slice(1) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function inspectService(options: ServiceInspectOptions): Promise<ServiceInspection> {
  const alive = options.alive ?? defaultAlive;
  const tcpProbe = options.tcpProbe ?? isTcpPortReachable;
  const socketProbe = options.socketProbe ?? ((path: string) => isBridgeSocketReachable(path));
  const ownerLookup = options.lookupPortOwner ?? lookupPortOwner;
  const [descriptor, diagnostics, manualStop, lockOwner, socketExists] = await Promise.all([
    readServiceDescriptor(options.servicePath),
    readStartupDiagnostics(options.diagnosticsPath),
    isManualStopSet(options.manualStopPath),
    readServiceLockOwner(options.lockPath),
    fileExists(options.socketPath),
  ]);
  const port = descriptor?.port ?? options.defaultPort ?? 4747;
  const pidAlive = descriptor !== null && alive(descriptor.pid);
  const ownership: ServiceOwnership = !descriptor
    ? "not_running"
    : !pidAlive
      ? "stale"
      : lockOwner?.pid === descriptor.pid
        ? "verified"
        : "unverifiable";
  let health: HealthzResult | null = null;
  let portReachable = false;
  let portOwner: PortOwner | null = null;
  if (pidAlive) {
    health = await fetchHealthz(port, options.fetchImpl ?? fetch);
    portReachable = health.ok || await tcpProbe(port);
  } else {
    portReachable = await tcpProbe(port);
    if (portReachable) portOwner = await ownerLookup(port);
  }
  const socketReachable = socketExists ? await socketProbe(options.socketPath) : false;
  return {
    descriptor,
    diagnostics,
    manualStop,
    pidAlive,
    ownership,
    port,
    portReachable,
    portOwner,
    health,
    socketExists,
    socketReachable,
    logPath: options.logPath !== undefined ? options.logPath : descriptor?.logPath ?? null,
  };
}

export type StopServiceResult =
  | { status: "stopped"; pid: number }
  | { status: "not_running" }
  | { status: "refused"; message: string }
  | { status: "stop_failed"; pid: number; message: string };

export interface StopServiceOptions {
  servicePath: string;
  lockPath: string;
  manualStopPath: string;
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  markManualStop?: () => Promise<void>;
  waitMs?: number;
  pollMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stops only a Bridge Zimlo can prove is its own: the instance lock owner is
// the source of truth, cross-checked against the service descriptor. Anything
// else on the port is left alone and reported.
export async function stopService(options: StopServiceOptions): Promise<StopServiceResult> {
  const alive = options.alive ?? defaultAlive;
  const kill = options.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const markStop = options.markManualStop ?? (() => markManualStop(options.manualStopPath));
  const [descriptor, lockOwner] = await Promise.all([
    readServiceDescriptor(options.servicePath),
    readServiceLockOwner(options.lockPath),
  ]);
  if (lockOwner && alive(lockOwner.pid)) {
    if (descriptor && descriptor.pid !== lockOwner.pid) {
      return {
        status: "refused",
        message: `实例锁（PID ${lockOwner.pid}）与服务描述文件（PID ${descriptor.pid}）不一致，无法确认进程归属，已放弃停止。请运行 zimlo status 查看。`,
      };
    }
    kill(lockOwner.pid, "SIGTERM");
    const deadline = Date.now() + (options.waitMs ?? 10_000);
    while (Date.now() < deadline) {
      if (!alive(lockOwner.pid)) {
        await markStop();
        return { status: "stopped", pid: lockOwner.pid };
      }
      await delay(options.pollMs ?? 100);
    }
    return {
      status: "stop_failed",
      pid: lockOwner.pid,
      message: `已向 PID ${lockOwner.pid} 发送 SIGTERM，但进程未在 ${Math.round((options.waitMs ?? 10_000) / 1_000)} 秒内退出。请运行 zimlo status 查看详情。`,
    };
  }
  if (descriptor && alive(descriptor.pid)) {
    return {
      status: "refused",
      message: `PID ${descriptor.pid} 仍在运行，但缺少实例锁，无法确认它是 Zimlo 自己的 Bridge，已放弃停止。请运行 zimlo status 查看，确认后可手动结束该进程。`,
    };
  }
  await markStop();
  return { status: "not_running" };
}

export function formatServiceInspection(info: ServiceInspection): string {
  const lines: string[] = [];
  const descriptor = info.descriptor;
  if (!descriptor) {
    lines.push("! 进程      未运行（没有服务描述文件）");
  } else if (!info.pidAlive) {
    lines.push(`! 进程      PID ${descriptor.pid} 已退出（描述文件是过期记录）`);
  } else if (info.ownership === "verified") {
    lines.push(`✓ 进程      PID ${descriptor.pid} 运行中（归属已校验）`);
  } else {
    lines.push(`! 进程      PID ${descriptor.pid} 运行中，但实例锁缺失或归属不明`);
  }
  if (info.health?.ok) {
    lines.push(`✓ 端口      127.0.0.1:${info.port} 监听中（version ${info.health.version ?? "?"}，协议 v${info.health.protocolVersion ?? "?"}）`);
  } else if (info.pidAlive && info.portReachable) {
    lines.push(`! 端口      127.0.0.1:${info.port} 有监听但 /healthz 无响应`);
  } else if (!info.pidAlive && info.portReachable) {
    lines.push(`! 端口      127.0.0.1:${info.port} 被其他进程占用${info.portOwner ? `（${info.portOwner.command}，PID ${info.portOwner.pid}）` : ""}`);
  } else {
    lines.push(`· 端口      127.0.0.1:${info.port} 空闲`);
  }
  lines.push(
    info.socketReachable
      ? "✓ Socket    可连接"
      : info.socketExists
        ? `! Socket    ${descriptor?.socketPath ?? ""} 存在但不可连接`.trimEnd()
        : "· Socket    不存在",
  );
  if (info.manualStop) lines.push("! 手动停止  已设置手动停止标记（macOS 不会自动拉起；zimlo start 会清除）");
  if (info.diagnostics) {
    lines.push(info.diagnostics.ok
      ? `✓ 最近启动  ${info.diagnostics.at} 成功${info.diagnostics.pid ? `（PID ${info.diagnostics.pid}）` : ""}`
      : `! 最近启动  ${info.diagnostics.at} 失败：${info.diagnostics.code ?? "unknown"}${info.diagnostics.message ? `（${info.diagnostics.message}）` : ""}`);
  } else {
    lines.push("· 最近启动  暂无记录");
  }
  lines.push(`日志        ${info.logPath ?? "暂无日志文件"}`);
  return lines.join("\n");
}
