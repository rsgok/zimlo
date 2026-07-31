// Persistent service state under ~/.zimlo/run: the service descriptor written
// by a running Bridge, the most recent startup diagnostics, and the
// manual-stop marker.
//
// manual-stop contract: `zimlo stop` writes the marker and only the macOS
// app's automatic service management honors it (a later task). `zimlo start`
// clears it because typing start is itself a manual action; `zimlo mcp`
// auto-starting the Bridge deliberately ignores it — running an agent is an
// explicit user action too.
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ServiceDescriptor {
  pid: number;
  port: number;
  version: string;
  protocolVersion: number;
  startedAt: string;
  socketPath: string;
  logPath: string | null;
}

export interface StartupDiagnostics {
  at: string;
  ok: boolean;
  pid?: number;
  port?: number;
  code?: string;
  message?: string;
}

function isServiceDescriptor(value: unknown): value is ServiceDescriptor {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Partial<ServiceDescriptor>;
  return Number.isInteger(descriptor.pid)
    && Number(descriptor.pid) > 0
    && Number.isInteger(descriptor.port)
    && typeof descriptor.version === "string"
    && typeof descriptor.protocolVersion === "number"
    && typeof descriptor.startedAt === "string"
    && typeof descriptor.socketPath === "string"
    && (typeof descriptor.logPath === "string" || descriptor.logPath === null);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.zimlo-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function writeServiceDescriptor(path: string, descriptor: ServiceDescriptor): Promise<void> {
  await writeJsonAtomic(path, descriptor);
}

export async function readServiceDescriptor(path: string): Promise<ServiceDescriptor | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isServiceDescriptor(value) ? value : null;
  } catch {
    return null;
  }
}

// Only clears the descriptor this process (or its test double) wrote, so a
// stale descriptor left by an older instance survives a foreign `stop`.
export async function clearServiceDescriptor(path: string, expectedPid: number): Promise<boolean> {
  const current = await readServiceDescriptor(path);
  if (!current || current.pid !== expectedPid) return false;
  await rm(path, { force: true });
  return true;
}

export async function writeStartupDiagnostics(path: string, diagnostics: StartupDiagnostics): Promise<void> {
  await writeJsonAtomic(path, diagnostics);
}

export async function readStartupDiagnostics(path: string): Promise<StartupDiagnostics | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object") return null;
    const diagnostics = value as Partial<StartupDiagnostics>;
    return typeof diagnostics.at === "string" && typeof diagnostics.ok === "boolean"
      ? diagnostics as StartupDiagnostics
      : null;
  } catch {
    return null;
  }
}

export interface StartupFailure {
  code: "port_in_use" | "config_corrupt" | "runtime_missing" | "startup_failed";
  summary: string;
  // Printed on stderr. Must keep the literal keyword the macOS
  // StartupLogInspector greps for (EADDRINUSE / SyntaxError /
  // ERR_MODULE_NOT_FOUND) so the app classifies terminal failures correctly.
  stderrText: string;
}

export function classifyStartupFailure(error: unknown, port: number): StartupFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE" || /EADDRINUSE/u.test(message)) {
    return {
      code: "port_in_use",
      summary: `端口 ${port} 已被占用`,
      stderrText: [
        `EADDRINUSE：端口 ${port} 已被占用，Zimlo 无法启动。`,
        "→ 运行 zimlo status 查看当前实例；或 zimlo stop 停止后重试；或换端口：zimlo start --port <端口>。",
      ].join("\n"),
    };
  }
  if (error instanceof SyntaxError || /SyntaxError|Unexpected token|in JSON|无法解析/u.test(message)) {
    return {
      code: "config_corrupt",
      summary: `本地配置或数据文件损坏：${message}`,
      stderrText: [
        `SyntaxError：本地配置或数据文件损坏（${message}）。`,
        "→ 备份并修复对应文件后重试；zimlo doctor 可协助定位。",
      ].join("\n"),
    };
  }
  if (code === "ERR_MODULE_NOT_FOUND" || /Cannot find module|ERR_MODULE_NOT_FOUND/u.test(message)) {
    return {
      code: "runtime_missing",
      summary: `运行时文件缺失：${message}`,
      stderrText: [
        `ERR_MODULE_NOT_FOUND：Zimlo 运行时文件缺失或损坏（${message}）。`,
        "→ 请重新安装 Zimlo 后重试。",
      ].join("\n"),
    };
  }
  if (/not a database|SQLITE_CORRUPT|database .* is malformed/iu.test(message)) {
    return {
      code: "config_corrupt",
      summary: `本地数据库损坏：${message}`,
      stderrText: [
        `SQLITE_CORRUPT：Zimlo 本地数据库损坏（${message}）。`,
        "→ 备份 ~/.zimlo 后删除损坏的数据库文件，再重新启动。",
      ].join("\n"),
    };
  }
  return {
    code: "startup_failed",
    summary: message,
    stderrText: [
      `Zimlo 启动失败：${message}`,
      "→ 运行 zimlo doctor 检查环境；日志见 zimlo logs。",
    ].join("\n"),
  };
}

export async function markManualStop(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

export async function clearManualStop(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function isManualStopSet(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
