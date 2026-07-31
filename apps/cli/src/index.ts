#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { Command } from "commander";
import openBrowser from "open";
import { ActionBroker } from "./action-broker.js";
import { detectInstalledProviders } from "./agent-command.js";
import { AgentToolService, runMcpServer } from "./agent-tools.js";
import { BridgeServer } from "./bridge.js";
import { CloudRelayClient } from "./cloud-relay-client.js";
import { CloudService } from "./cloud-service.js";
import { ensureBridgeRunning } from "./bridge-supervisor.js";
import { codexPluginDeepLink, inspectCodexPlugin, installCodexPlugin, uninstallCodexPlugin } from "./codex-plugin.js";
import { formatDeviceList } from "./device-list.js";
import { DeviceManager } from "./device-manager.js";
import { DiscoveryService } from "./discovery-service.js";
import { doctorHasBlockingFailure, formatDoctor, runDoctor } from "./doctor.js";
import { applyHookChanges, formatHookChanges, formatHookChangesSummary, hookConfigChanges } from "./hook-config.js";
import { HookServer, runHookClient } from "./hook-server.js";
import { detectHookSurface } from "./hook-surface.js";
import { followFile, latestLogFile, readTail } from "./log-view.js";
import { ZIMLO_PATHS } from "./paths.js";
import { ResumeService } from "./resume-service.js";
import { RuntimeHub } from "./runtime.js";
import {
  fetchHealthz,
  formatServiceInspection,
  inspectService,
  isServiceOperational,
  isTcpPortReachable,
  stopService,
} from "./service-inspect.js";
import { acquireServiceInstance, ServiceAlreadyRunningError } from "./service-instance.js";
import {
  classifyStartupFailure,
  clearManualStop,
  clearServiceDescriptor,
  readServiceDescriptor,
  writeServiceDescriptor,
  writeStartupDiagnostics,
} from "./service-state.js";
import { ZimloStore } from "./store.js";
import { TaskCommandService } from "./task-command-service.js";
import { ZIMLO_PROTOCOL_VERSION, ZIMLO_VERSION } from "./version.js";

const entrypoint = fileURLToPath(import.meta.url);
const program = new Command();
const traceStartup = (phase: string): void => {
  if (process.env.ZIMLO_STARTUP_TRACE === "1") console.error(`[zimlo:start] ${phase}`);
};

program.name("zimlo").description("Local feed and action layer for coding agents").version(ZIMLO_VERSION);

program.command("start")
  .description("Start the local Bridge and web app")
  .option("--lan", "listen on trusted LAN addresses")
  .option("--port <port>", "HTTP port", "4747")
  .action(async (options: { lan?: boolean; port: string }) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("端口必须是 1-65535 的整数。");
    // `zimlo start` 本身就是手动动作：清除手动停止标记（该标记只供 macOS
    // 的自动服务管理读取，见 service-state.ts 的约定注释）。
    await clearManualStop(ZIMLO_PATHS.manualStop);
    let lease;
    try {
      lease = await acquireServiceInstance({
        lockPath: ZIMLO_PATHS.serviceLock,
        entrypoint,
      });
    } catch (error) {
      if (error instanceof ServiceAlreadyRunningError) {
        console.log(error.message);
        return;
      }
      throw error;
    }

    try {
      traceStartup("create-log-directory");
      await mkdir(ZIMLO_PATHS.logs, { recursive: true, mode: 0o700 });
      traceStartup("open-store");
      const store = new ZimloStore(ZIMLO_PATHS.database);
      traceStartup("prune-store");
      store.prune(7);
      traceStartup("finalize-feed-checkpoints");
      store.finalizeOpenFeedCheckpoints(new Date().toISOString(), "bridge:restart");
      traceStartup("create-services");
      const cloud = new CloudService(store);
      const cloudHealth = cloud.refreshHealth();
      const runtime = new RuntimeHub(store, cloud);
      const broker = new ActionBroker(runtime);
      const agentTools = new AgentToolService(runtime);
      const devices = new DeviceManager(store);
      devices.localAdmin();
      const resume = new ResumeService(runtime, broker);
      const taskCommands = new TaskCommandService(runtime, resume);
      const hooks = new HookServer(runtime, broker, ZIMLO_PATHS.socket, agentTools);
      const discovery = new DiscoveryService(runtime);
      const bridge = new BridgeServer({ runtime, broker, devices, taskCommands, cloud, entrypoint, options: { port, lan: Boolean(options.lan) } });
      const cloudRelay = new CloudRelayClient(cloud, port);
      traceStartup("services-created");

      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await clearServiceDescriptor(ZIMLO_PATHS.service, process.pid);
        discovery.stop();
        taskCommands.stop();
        broker.cancelAll();
        await hooks.stop();
        cloudRelay.stop();
        await bridge.stop();
        store.close();
      };

      try {
        await hooks.start();
        traceStartup("hooks-started");
        taskCommands.start();
        const discoveryStarted = Date.now();
        await discovery.start();
        traceStartup("discovery-started");
        await cloudHealth;
        traceStartup("cloud-health-checked");
        traceStartup("start-bridge");
        const urls = await bridge.start();
        traceStartup("bridge-started");
        // 描述文件紧随 HTTP 就绪写入：cloud relay 建连可能耗时数秒，不能让
        // `zimlo status` 在这个窗口里误报"未运行"。cloudRelay 失败时 stop()
        // 会负责清理描述文件。
        await writeServiceDescriptor(ZIMLO_PATHS.service, {
          pid: process.pid,
          port: urls.port,
          version: ZIMLO_VERSION,
          protocolVersion: ZIMLO_PROTOCOL_VERSION,
          startedAt: new Date().toISOString(),
          socketPath: ZIMLO_PATHS.socket,
          // 自动拉起的实例 stdout/stderr 已重定向到 autostart.log；手动
          // `zimlo start` 输出在终端，没有对应日志文件。
          logPath: process.env.ZIMLO_AUTOSTARTED === "1" ? ZIMLO_PATHS.autostartLog : null,
        });
        await writeStartupDiagnostics(ZIMLO_PATHS.startupDiagnostics, {
          at: new Date().toISOString(),
          ok: true,
          pid: process.pid,
          port: urls.port,
        });
        const cloudStarted = await cloudRelay.start();
        traceStartup("cloud-relay-started");
        console.log(`Zimlo 已启动：${urls.localUrl}`);
        if (urls.lanUrl) console.log(`可信局域网：${urls.lanUrl}`);
        console.log(cloudStarted ? `Cloudflare 远程同步：${cloud.relayURL}` : "Cloudflare 远程同步：未配置");
        console.log(`已发现 ${store.listSessions().length} 个 Session（${Date.now() - discoveryStarted} ms）`);
        console.log("按 Ctrl-C 停止。手机审批权限由 Mac 在 Settings 中按设备管理。");

        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
      } finally {
        await stop();
      }
    } catch (error) {
      // 分类启动失败：stderr 保留 macOS StartupLogInspector 识别的关键字
      // （EADDRINUSE / SyntaxError / ERR_MODULE_NOT_FOUND），并附中文指引。
      const failure = classifyStartupFailure(error, port);
      await writeStartupDiagnostics(ZIMLO_PATHS.startupDiagnostics, {
        at: new Date().toISOString(),
        ok: false,
        pid: process.pid,
        port,
        code: failure.code,
        message: failure.summary,
      }).catch(() => undefined);
      console.error(failure.stderrText);
      process.exitCode = 1;
    } finally {
      await lease.release();
    }
  });

program.command("status")
  .description("Show Bridge service status")
  .option("--json", "print machine-readable status")
  .action(async (options: { json?: boolean }) => {
    const inspection = await inspectService({
      servicePath: ZIMLO_PATHS.service,
      lockPath: ZIMLO_PATHS.serviceLock,
      socketPath: ZIMLO_PATHS.socket,
      diagnosticsPath: ZIMLO_PATHS.startupDiagnostics,
      manualStopPath: ZIMLO_PATHS.manualStop,
      logPath: await latestLogFile(ZIMLO_PATHS.logs),
    });
    if (options.json) {
      console.log(JSON.stringify(inspection, null, 2));
    } else {
      console.log(formatServiceInspection(inspection));
    }
    if (!isServiceOperational(inspection, ZIMLO_PROTOCOL_VERSION)) {
      process.exitCode = 1;
    }
  });

program.command("stop")
  .description("Stop the running Bridge")
  .action(async () => {
    const result = await stopService({
      servicePath: ZIMLO_PATHS.service,
      lockPath: ZIMLO_PATHS.serviceLock,
      manualStopPath: ZIMLO_PATHS.manualStop,
    });
    switch (result.status) {
      case "stopped":
        console.log(`已停止 Zimlo Bridge（PID ${result.pid}）。`);
        console.log("已记录手动停止标记：macOS 不会自动拉起；zimlo start 可重新启动（并清除标记）。");
        return;
      case "not_running":
        console.log("Zimlo Bridge 未在运行。已记录手动停止标记，macOS 不会自动拉起。");
        return;
      case "refused":
      case "stop_failed":
        console.error(result.message);
        process.exitCode = 1;
        return;
    }
  });

program.command("logs")
  .description("Print Bridge or desktop app logs")
  .option("--follow", "keep streaming new log lines")
  .option("--cli", "read ~/.zimlo/logs (default)")
  .option("--desktop", "read the macOS app log")
  .action(async (options: { follow?: boolean; desktop?: boolean }) => {
    const path = options.desktop
      ? join(homedir(), "Library", "Logs", "Zimlo", "service.log")
      : await latestLogFile(ZIMLO_PATHS.logs);
    if (!path) {
      console.log(options.desktop ? "暂无 macOS 应用日志。" : `暂无日志文件（${ZIMLO_PATHS.logs}）。`);
      return;
    }
    console.error(`# ${path}`);
    process.stdout.write(await readTail(path));
    if (options.follow) await followFile(path, (chunk) => process.stdout.write(chunk));
  });

program.command("doctor")
  .description("Check runtime, agents, directories, hooks, and the Bridge")
  .action(async () => {
    const checks = await runDoctor(entrypoint);
    console.log(formatDoctor(checks));
    if (doctorHasBlockingFailure(checks)) process.exitCode = 1;
  });

const hooks = program.command("hooks").description("Manage opt-in agent hooks");
hooks.command("diff")
  .option("--json", "print the full hook configuration instead of a summary")
  .action(async (options: { json?: boolean }) => {
    const changes = await hookConfigChanges(entrypoint);
    console.log(options.json ? formatHookChanges(changes) : formatHookChangesSummary(changes));
  });
hooks.command("status").action(async () => {
  const changes = await hookConfigChanges(entrypoint);
  const installed = changes.every((change) => JSON.stringify(change.before) === JSON.stringify(change.after));
  console.log(installed ? "Zimlo hooks 已安装且为当前版本。" : "Zimlo hooks 未安装或需要升级。运行 `zimlo hooks diff` 预览。" );
});
hooks.command("install").action(async () => {
  // 只给已安装的 agent 写配置：未安装的 provider 不生成文件、不创建
  // ~/.codex 或 ~/.claude 目录。
  const providers = await detectInstalledProviders();
  if (providers.length === 0) {
    throw new Error("尚未发现 Codex 或 Claude Code，未写入任何配置。请先安装其中一个 Agent。");
  }
  const changes = await hookConfigChanges(entrypoint, false, undefined, providers);
  const applied = await applyHookChanges(changes);
  for (const item of applied) {
    console.log(item.changed ? `已更新 ${item.path}` : `无需改动 ${item.path}（已是最新）`);
    if (item.backupPath) console.log(`备份 ${item.backupPath}`);
  }
  console.log("Zimlo hooks 已原子合并；原配置已保留，已有文件同时创建了时间戳备份。");
  console.log("Codex CLI 用户请运行 `/hooks` 检查并信任新 hook；Codex GUI 请改用 `zimlo codex-plugin install`。" );
});
hooks.command("uninstall").action(async () => {
  const changes = await hookConfigChanges(entrypoint, true);
  await applyHookChanges(changes);
  console.log("仅 Zimlo 自己的 hook 项已移除；用户原配置已保留。");
});

const codexPlugin = program.command("codex-plugin").description("Manage the Zimlo integration for Codex GUI");
codexPlugin.command("install").action(async () => {
  const status = await installCodexPlugin(entrypoint);
  console.log("Zimlo 已加入 Codex GUI 的 Personal 插件源。" );
  console.log("打开 Codex GUI → Plugins → Personal → Zimlo，点击安装并审核 hooks，然后新建任务。" );
  console.log(`打开插件：${codexPluginDeepLink(status.paths)}`);
});
codexPlugin.command("status").action(async () => {
  const status = await inspectCodexPlugin(entrypoint);
  console.log(`${status.installed ? "✓" : "!"} ${status.detail}`);
  console.log(status.paths.plugin);
});
codexPlugin.command("uninstall").action(async () => {
  const status = await uninstallCodexPlugin();
  console.log(status.detail);
});

const devices = program.command("devices").description("Manage paired browser devices");
devices.command("list").action(() => {
  const store = new ZimloStore(ZIMLO_PATHS.database);
  try {
    console.log(formatDeviceList(store.listDevices()));
  } finally {
    store.close();
  }
});
devices.command("revoke <device-id>").action(async (deviceId: string) => {
  const store = new ZimloStore(ZIMLO_PATHS.database);
  try {
    const device = store.getDevice(deviceId);
    if (!device) throw new Error(`找不到设备 ${deviceId}。先运行 zimlo devices list 查看已配对设备。`);
    if (device.isLocalAdmin) throw new Error("本机管理设备不能撤销；它只可通过 loopback 获取。" );
    if (!store.revokeDevice(deviceId)) throw new Error("设备已经撤销。" );
    await new CloudService(store).revokeDevice(deviceId);
    console.log(`已撤销 ${device.name} (${device.id})。`);
  } finally {
    store.close();
  }
});

program.command("open").description("Open the local management page").action(async () => {
  const descriptor = await readServiceDescriptor(ZIMLO_PATHS.service);
  if (!descriptor) {
    throw new Error("Zimlo 未在运行，请先 zimlo start 启动（zimlo status 可查看状态）。");
  }
  const health = await fetchHealthz(descriptor.port);
  if (!health.ok || health.protocolVersion !== ZIMLO_PROTOCOL_VERSION) {
    throw new Error(
      health.ok
        ? `Zimlo Bridge 协议版本不匹配（v${health.protocolVersion ?? "?"}，期望 v${ZIMLO_PROTOCOL_VERSION}）。请运行 zimlo stop && zimlo start。`
        : await isTcpPortReachable(descriptor.port)
        ? `端口 ${descriptor.port} 被其他程序占用或 Bridge 已损坏，拒绝打开。请运行 zimlo status 查看，必要时 zimlo stop 后重新 zimlo start。`
        : "Zimlo Bridge 未在运行，请先 zimlo start 启动。",
    );
  }
  await openBrowser(`http://127.0.0.1:${descriptor.port}`);
});

program.command("hook")
  .description("Internal hook transport")
  .requiredOption("--provider <provider>")
  .option("--surface <surface>", "Execution surface", "unknown")
  .action(async (options: { provider: string; surface: string }) => {
    if (options.provider !== "codex" && options.provider !== "claude") throw new Error("未知 provider。");
    if (!["gui", "cli", "auto", "unknown"].includes(options.surface)) throw new Error("未知 surface。");
    const surface = options.surface === "auto" ? detectHookSurface() : options.surface as "gui" | "cli" | "unknown";
    await runHookClient(options.provider, surface, ZIMLO_PATHS.socket);
  });

program.command("mcp")
  .description("Run the Zimlo MCP tools for a coding agent")
  .requiredOption("--provider <provider>")
  .action(async (options: { provider: string }) => {
    if (options.provider !== "codex" && options.provider !== "claude") throw new Error("未知 provider。");
    const started = await ensureBridgeRunning({ entrypoint, socketPath: ZIMLO_PATHS.socket, logPath: ZIMLO_PATHS.autostartLog });
    if (!started) {
      throw new Error(`Zimlo Bridge 未能在预期时间内启动。请运行 zimlo doctor 检查环境，或查看日志：${ZIMLO_PATHS.autostartLog}`);
    }
    await runMcpServer(options.provider, ZIMLO_PATHS.socket);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
