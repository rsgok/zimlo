import { access, mkdir } from "node:fs/promises";
import { platform, release } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveAgentCommand } from "./agent-command.js";
import { DEFAULT_CLOUD_URL } from "./cloud-service.js";
import { ZIMLO_PATHS } from "./paths.js";
import { hookConfigChanges } from "./hook-config.js";
import { inspectCodexPlugin } from "./codex-plugin.js";
import { inspectService, type ServiceInspection } from "./service-inspect.js";
import { ZIMLO_PROTOCOL_VERSION } from "./version.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  // 失败时输出的一行可复制修复命令（或最短修复路径）。
  fix?: string;
  // 阻塞项失败时 doctor 以非零退出码结束。
  blocking?: boolean;
}

export interface DoctorDeps {
  // 测试注入点：Bridge 运行状态与云同步检查。
  inspect?: () => Promise<ServiceInspection>;
  cloudCheck?: () => Promise<{ reachable: boolean; detail: string }>;
}

function commandVersion(name: string, command: string | null): DoctorCheck {
  if (!command) return { name, ok: false, detail: "未安装" };
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 });
  const detail = (result.stdout || result.stderr || "未安装").trim().split("\n")[0] ?? "未安装";
  return { name, ok: result.status === 0, detail };
}

function bridgeChecks(inspection: ServiceInspection): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (inspection.pidAlive && inspection.ownership === "verified" && inspection.health?.ok) {
    const protocol = inspection.health.protocolVersion;
    if (protocol === ZIMLO_PROTOCOL_VERSION) {
      checks.push({ name: "Bridge 服务", ok: true, detail: `运行中（PID ${inspection.descriptor?.pid}，协议 v${protocol}）`, blocking: true });
    } else {
      checks.push({
        name: "Bridge 服务",
        ok: false,
        detail: `运行中但协议版本不匹配（v${protocol ?? "?"}，期望 v${ZIMLO_PROTOCOL_VERSION}）`,
        fix: "zimlo stop && zimlo start",
        blocking: true,
      });
    }
  } else if (inspection.pidAlive) {
    checks.push({
      name: "Bridge 服务",
      ok: false,
      detail: inspection.ownership === "unverifiable"
        ? `PID ${inspection.descriptor?.pid} 在运行，但无法校验归属`
        : "进程在运行但 /healthz 无响应",
      fix: "zimlo status",
      blocking: true,
    });
  } else if (inspection.portReachable) {
    checks.push({
      name: "Bridge 服务",
      ok: false,
      detail: `未运行；端口 ${inspection.port} 被其他进程占用${inspection.portOwner ? `（${inspection.portOwner.command}，PID ${inspection.portOwner.pid}）` : ""}`,
      fix: "停止占用进程后 zimlo start",
      blocking: true,
    });
  } else {
    checks.push({ name: "Bridge 服务", ok: false, detail: "未运行", fix: "zimlo start", blocking: true });
  }
  const diagnostics = inspection.diagnostics;
  if (!diagnostics) {
    checks.push({ name: "启动诊断", ok: true, detail: "暂无启动记录" });
  } else if (diagnostics.ok) {
    checks.push({ name: "启动诊断", ok: true, detail: `上次启动成功（${diagnostics.at}）` });
  } else {
    checks.push({
      name: "启动诊断",
      ok: false,
      detail: `上次启动失败：${diagnostics.code ?? "unknown"}${diagnostics.message ? `（${diagnostics.message}）` : ""}`,
      fix: diagnostics.code === "port_in_use" ? "zimlo status 查看实例，或 zimlo start --port 换端口" : "zimlo logs 查看日志",
    });
  }
  return checks;
}

async function defaultCloudCheck(): Promise<{ reachable: boolean; detail: string }> {
  if (process.env.ZIMLO_CLOUD_DISABLED === "1") return { reachable: true, detail: "已禁用（ZIMLO_CLOUD_DISABLED=1）" };
  const baseURL = (process.env.ZIMLO_CLOUD_URL?.trim() || DEFAULT_CLOUD_URL).replace(/\/+$/u, "");
  try {
    const response = await fetch(`${baseURL}/healthz`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return { reachable: false, detail: `云端返回 ${response.status}（不影响本地功能）` };
    return { reachable: true, detail: `已连接（${baseURL}）` };
  } catch {
    return { reachable: false, detail: "无法连接云端（不影响本地功能）" };
  }
}

export async function runDoctor(entrypoint: string, deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const [codexCommand, claudeCommand] = await Promise.all([
    resolveAgentCommand("codex"),
    resolveAgentCommand("claude"),
  ]);
  const checks: DoctorCheck[] = [
    { name: "macOS", ok: platform() === "darwin", detail: `${platform()} ${release()}`, blocking: true },
    {
      name: "Node.js",
      ok: Number(process.versions.node.split(".")[0]) >= 24,
      detail: process.version,
      blocking: true,
      fix: "安装 Node.js 24 或更高版本后重试",
    },
    commandVersion("codex", codexCommand),
    commandVersion("claude", claudeCommand),
  ];
  try {
    await mkdir(ZIMLO_PATHS.logs, { recursive: true, mode: 0o700 });
    await access(ZIMLO_PATHS.root);
    checks.push({ name: "~/.zimlo", ok: true, detail: ZIMLO_PATHS.root, blocking: true });
  } catch (error) {
    checks.push({
      name: "~/.zimlo",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      blocking: true,
      fix: `mkdir -p ${ZIMLO_PATHS.root} 并检查目录权限`,
    });
  }
  try {
    const plugin = await inspectCodexPlugin(entrypoint);
    checks.push({
      name: "Codex GUI",
      ok: plugin.installed,
      detail: plugin.detail,
      ...(plugin.installed ? {} : { fix: "zimlo codex-plugin install" }),
    });
  } catch (error) {
    checks.push({
      name: "Codex GUI",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: "zimlo codex-plugin install",
    });
  }
  try {
    const changes = await hookConfigChanges(entrypoint);
    const installed = changes.every((change) => JSON.stringify(change.before) === JSON.stringify(change.after));
    checks.push({
      name: "CLI hooks",
      ok: installed,
      detail: installed ? "已安装" : "未安装或指向旧版 Zimlo",
      ...(installed ? {} : { fix: "zimlo hooks install" }),
    });
  } catch (error) {
    checks.push({
      name: "CLI hooks",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: "修复该 JSON 文件后运行 zimlo hooks install",
    });
  }
  const inspection = deps.inspect
    ? await deps.inspect()
    : await inspectService({
      servicePath: ZIMLO_PATHS.service,
      lockPath: ZIMLO_PATHS.serviceLock,
      socketPath: ZIMLO_PATHS.socket,
      diagnosticsPath: ZIMLO_PATHS.startupDiagnostics,
      manualStopPath: ZIMLO_PATHS.manualStop,
    });
  checks.push(...bridgeChecks(inspection));
  const cloud = deps.cloudCheck ? await deps.cloudCheck() : await defaultCloudCheck();
  checks.push({
    name: "云同步",
    ok: cloud.reachable,
    detail: cloud.detail,
    ...(cloud.reachable ? {} : { fix: "检查网络；或 ZIMLO_CLOUD_DISABLED=1 禁用远程同步" }),
  });
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map((check) => {
    const line = `${check.ok ? "✓" : "!"} ${check.name.padEnd(12)} ${check.detail}`;
    return !check.ok && check.fix ? `${line}\n  → 修复: ${check.fix}` : line;
  }).join("\n");
}

export function doctorHasBlockingFailure(checks: DoctorCheck[]): boolean {
  return checks.some((check) => check.blocking === true && !check.ok);
}
