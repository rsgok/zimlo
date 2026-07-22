#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { Command } from "commander";
import openBrowser from "open";
import { ActionBroker } from "./action-broker.js";
import { AgentToolService, runMcpServer } from "./agent-tools.js";
import { BridgeServer } from "./bridge.js";
import { ensureBridgeRunning } from "./bridge-supervisor.js";
import { codexPluginDeepLink, inspectCodexPlugin, installCodexPlugin, uninstallCodexPlugin } from "./codex-plugin.js";
import { DeviceManager } from "./device-manager.js";
import { DiscoveryService } from "./discovery-service.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { applyHookChanges, formatHookChanges, hookConfigChanges } from "./hook-config.js";
import { HookServer, runHookClient } from "./hook-server.js";
import { ZIMLO_PATHS } from "./paths.js";
import { ResumeService } from "./resume-service.js";
import { RuntimeHub } from "./runtime.js";
import { ZimloStore } from "./store.js";
import { TaskCommandService } from "./task-command-service.js";

const entrypoint = fileURLToPath(import.meta.url);
const program = new Command();

program.name("zimlo").description("Local feed and action layer for coding agents").version("0.2.0");

program.command("start")
  .description("Start the local Bridge and web app")
  .option("--lan", "listen on trusted LAN addresses")
  .option("--port <port>", "HTTP port", "4747")
  .action(async (options: { lan?: boolean; port: string }) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("端口必须是 1-65535 的整数。");
    await mkdir(ZIMLO_PATHS.logs, { recursive: true, mode: 0o700 });
    const store = new ZimloStore(ZIMLO_PATHS.database);
    store.prune(7);
    store.finalizeOpenFeedCheckpoints(new Date().toISOString(), "bridge:restart");
    const runtime = new RuntimeHub(store);
    const broker = new ActionBroker(runtime);
    const agentTools = new AgentToolService(runtime);
    const devices = new DeviceManager(store);
    devices.localAdmin();
    const resume = new ResumeService(runtime, broker);
    const taskCommands = new TaskCommandService(runtime, resume);
    const hooks = new HookServer(runtime, broker, ZIMLO_PATHS.socket, agentTools);
    const discovery = new DiscoveryService(runtime);
    const bridge = new BridgeServer({ runtime, broker, devices, taskCommands, entrypoint, options: { port, lan: Boolean(options.lan) } });

    const urls = await bridge.start();
    await hooks.start();
    taskCommands.start();
    const discoveryStarted = Date.now();
    await discovery.start();
    console.log(`Zimlo 已启动：${urls.localUrl}`);
    if (urls.lanUrl) console.log(`可信局域网：${urls.lanUrl}`);
    console.log(`已发现 ${store.listSessions().length} 个 Session（${Date.now() - discoveryStarted} ms）`);
    console.log("按 Ctrl-C 停止。手机审批权限由 Mac 在 Profile 中按设备管理。");

    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      discovery.stop();
      taskCommands.stop();
      broker.cancelAll();
      await hooks.stop();
      await bridge.stop();
      store.close();
    };
    process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
    process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
    await new Promise<void>(() => undefined);
  });

program.command("doctor")
  .description("Check runtime, agents, directories, and hooks")
  .action(async () => {
    const checks = await runDoctor(entrypoint);
    console.log(formatDoctor(checks));
    if (checks.some((check) => !check.ok && ["macOS", "Node.js", "~/.zimlo"].includes(check.name))) process.exitCode = 1;
  });

const hooks = program.command("hooks").description("Manage opt-in agent hooks");
hooks.command("diff").action(async () => console.log(formatHookChanges(await hookConfigChanges(entrypoint))));
hooks.command("status").action(async () => {
  const changes = await hookConfigChanges(entrypoint);
  const installed = changes.every((change) => JSON.stringify(change.before) === JSON.stringify(change.after));
  console.log(installed ? "Zimlo hooks 已安装且为当前版本。" : "Zimlo hooks 未安装或需要升级。运行 `zimlo hooks diff` 预览。" );
});
hooks.command("install").action(async () => {
  const changes = await hookConfigChanges(entrypoint);
  await applyHookChanges(changes);
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
    for (const device of store.listDevices()) {
      console.log(`${device.revokedAt ? "revoked" : "active "}  ${device.id}  ${device.name}  ${device.lastSeenAt}`);
    }
  } finally {
    store.close();
  }
});
devices.command("revoke <device-id>").action((deviceId: string) => {
  const store = new ZimloStore(ZIMLO_PATHS.database);
  try {
    const device = store.getDevice(deviceId);
    if (!device) throw new Error("找不到该设备。");
    if (device.isLocalAdmin) throw new Error("本机管理设备不能撤销；它只可通过 loopback 获取。" );
    if (!store.revokeDevice(deviceId)) throw new Error("设备已经撤销。" );
    console.log(`已撤销 ${device.name} (${device.id})。`);
  } finally {
    store.close();
  }
});

program.command("open").description("Open the local management page").action(async () => {
  await openBrowser("http://127.0.0.1:4747");
});

program.command("hook")
  .description("Internal hook transport")
  .requiredOption("--provider <provider>")
  .action(async (options: { provider: string }) => {
    if (options.provider !== "codex" && options.provider !== "claude") throw new Error("未知 provider。");
    await runHookClient(options.provider, ZIMLO_PATHS.socket);
  });

program.command("mcp")
  .description("Run the Zimlo MCP tools for a coding agent")
  .requiredOption("--provider <provider>")
  .action(async (options: { provider: string }) => {
    if (options.provider !== "codex" && options.provider !== "claude") throw new Error("未知 provider。");
    await ensureBridgeRunning({ entrypoint, socketPath: ZIMLO_PATHS.socket, logPath: ZIMLO_PATHS.autostartLog });
    await runMcpServer(options.provider, ZIMLO_PATHS.socket);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
