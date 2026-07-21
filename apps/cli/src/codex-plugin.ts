import { constants } from "node:fs";
import { access, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { codexPluginHooks } from "./hook-config.js";

type JsonObject = Record<string, unknown>;

export interface CodexPluginPaths {
  marketplaceRoot: string;
  marketplace: string;
  pluginsRoot: string;
  plugin: string;
  legacyPlugin: string;
}

export interface CodexPluginOptions {
  home?: string;
  sourceRoot?: string;
  nodePath?: string;
}

export interface CodexPluginStatus {
  installed: boolean;
  pluginPresent: boolean;
  marketplacePresent: boolean;
  commandsCurrent: boolean;
  versionCurrent: boolean;
  detail: string;
  paths: CodexPluginPaths;
}

const PLUGIN_NAME = "zimlo";
const MARKETPLACE_SOURCE = `./plugins/${PLUGIN_NAME}`;

export function codexPluginPaths(home = homedir()): CodexPluginPaths {
  const marketplaceRoot = join(home, ".agents", "plugins");
  // Codex resolves Personal marketplace `./plugins/*` sources from the home
  // directory even though marketplace.json itself lives under ~/.agents.
  const pluginsRoot = join(home, "plugins");
  return {
    marketplaceRoot,
    marketplace: join(marketplaceRoot, "marketplace.json"),
    pluginsRoot,
    plugin: join(pluginsRoot, PLUGIN_NAME),
    legacyPlugin: join(marketplaceRoot, "plugins", PLUGIN_NAME),
  };
}

export function bundledCodexPluginRoot(entrypoint: string): string {
  return resolve(dirname(entrypoint), "..", "plugin", PLUGIN_NAME);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<JsonObject | null> {
  if (!(await exists(path))) return null;
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(value)) throw new Error("根节点必须是对象");
    return value;
  } catch (error) {
    throw new Error(`无法解析 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (await exists(path)) {
    const backup = `${path}.zimlo-backup-${new Date().toISOString().replaceAll(":", "-")}`;
    await copyFile(path, backup);
  }
  const temporary = `${path}.zimlo-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function mcpConfig(entrypoint: string, nodePath: string): JsonObject {
  return {
    mcpServers: {
      zimlo: {
        command: nodePath,
        args: [entrypoint, "mcp", "--provider", "codex"],
      },
    },
  };
}

function marketplaceWithZimlo(existing: JsonObject | null): JsonObject {
  const marketplace: JsonObject = existing ?? {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: [],
  };
  if (typeof marketplace.name !== "string" || !marketplace.name) {
    throw new Error("Personal marketplace 缺少有效的 name。请先修复 marketplace.json。");
  }
  if (!isObject(marketplace.interface)) marketplace.interface = { displayName: "Personal" };
  const plugins = Array.isArray(marketplace.plugins) ? [...marketplace.plugins] : [];
  const conflict = plugins.find((item) => isObject(item) && item.name === PLUGIN_NAME);
  if (conflict) {
    const source = isObject(conflict.source) ? conflict.source : {};
    if (source.source !== "local" || source.path !== MARKETPLACE_SOURCE) {
      throw new Error("Personal marketplace 已有另一个名为 zimlo 的来源，未自动覆盖。");
    }
  }
  const entry = {
    name: PLUGIN_NAME,
    source: { source: "local", path: MARKETPLACE_SOURCE },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  };
  marketplace.plugins = conflict
    ? plugins.map((item) => item === conflict ? entry : item)
    : [...plugins, entry];
  return marketplace;
}

async function materializePlugin(
  sourceRoot: string,
  destination: string,
  entrypoint: string,
  nodePath: string,
): Promise<void> {
  await access(join(sourceRoot, ".codex-plugin", "plugin.json"), constants.R_OK);
  await cp(sourceRoot, destination, { recursive: true, force: true });
  await writeFile(join(destination, ".mcp.json"), `${JSON.stringify(mcpConfig(entrypoint, nodePath), null, 2)}\n`, { mode: 0o600 });
  await mkdir(join(destination, "hooks"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(destination, "hooks", "hooks.json"),
    `${JSON.stringify(codexPluginHooks(entrypoint, nodePath), null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function installCodexPlugin(entrypoint: string, options: CodexPluginOptions = {}): Promise<CodexPluginStatus> {
  const paths = codexPluginPaths(options.home);
  const sourceRoot = options.sourceRoot ?? bundledCodexPluginRoot(entrypoint);
  const nodePath = options.nodePath ?? process.execPath;
  await mkdir(paths.pluginsRoot, { recursive: true, mode: 0o700 });
  const temporary = join(paths.pluginsRoot, `.zimlo-install-${process.pid}-${Date.now()}`);
  const previous = join(paths.pluginsRoot, `.zimlo-previous-${process.pid}-${Date.now()}`);
  let movedPrevious = false;
  let installedNew = false;
  try {
    await materializePlugin(sourceRoot, temporary, entrypoint, nodePath);
    if (await exists(paths.plugin)) {
      await rename(paths.plugin, previous);
      movedPrevious = true;
    }
    await rename(temporary, paths.plugin);
    installedNew = true;
    const marketplace = marketplaceWithZimlo(await readJson(paths.marketplace));
    await writeJsonAtomic(paths.marketplace, marketplace);
    if (movedPrevious) await rm(previous, { recursive: true, force: true });
    const legacyManifest = await readJson(join(paths.legacyPlugin, ".codex-plugin", "plugin.json"));
    if (legacyManifest?.name === PLUGIN_NAME) await rm(paths.legacyPlugin, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (installedNew) await rm(paths.plugin, { recursive: true, force: true });
    if (movedPrevious) await rename(previous, paths.plugin);
    throw error;
  }
  return inspectCodexPlugin(entrypoint, options);
}

export async function inspectCodexPlugin(entrypoint: string, options: CodexPluginOptions = {}): Promise<CodexPluginStatus> {
  const paths = codexPluginPaths(options.home);
  const nodePath = options.nodePath ?? process.execPath;
  const sourceRoot = options.sourceRoot ?? bundledCodexPluginRoot(entrypoint);
  const manifest = await readJson(join(paths.plugin, ".codex-plugin", "plugin.json"));
  const bundledManifest = await readJson(join(sourceRoot, ".codex-plugin", "plugin.json"));
  const marketplace = await readJson(paths.marketplace);
  const pluginPresent = manifest?.name === PLUGIN_NAME;
  const entries = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
  const marketplacePresent = entries.some((item) => {
    if (!isObject(item) || item.name !== PLUGIN_NAME || !isObject(item.source)) return false;
    return item.source.source === "local" && item.source.path === MARKETPLACE_SOURCE;
  });
  const mcp = await readJson(join(paths.plugin, ".mcp.json"));
  const servers = isObject(mcp?.mcpServers) ? mcp.mcpServers : null;
  const server = servers && isObject(servers.zimlo) ? servers.zimlo : null;
  const args = server && Array.isArray(server.args) ? server.args : [];
  const commandsCurrent = Boolean(server)
    && server?.command === nodePath
    && args[0] === entrypoint
    && args.slice(1).join(" ") === "mcp --provider codex";
  const versionCurrent = typeof manifest?.version === "string"
    && typeof bundledManifest?.version === "string"
    && manifest.version === bundledManifest.version;
  const installed = pluginPresent && marketplacePresent && commandsCurrent && versionCurrent;
  const detail = installed
    ? "已安装；请在 Codex GUI 的 Plugins → Personal 中启用 Zimlo"
    : !pluginPresent
      ? "未安装"
      : !marketplacePresent
        ? "插件文件存在，但 Personal marketplace 未注册"
        : !commandsCurrent
          ? "插件命令指向旧版 CLI，需要重新安装"
          : "插件内容版本已过期，请重新安装并新建 Codex 任务";
  return { installed, pluginPresent, marketplacePresent, commandsCurrent, versionCurrent, detail, paths };
}

export async function uninstallCodexPlugin(options: CodexPluginOptions = {}): Promise<CodexPluginStatus> {
  const paths = codexPluginPaths(options.home);
  const marketplace = await readJson(paths.marketplace);
  if (marketplace) {
    const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    marketplace.plugins = plugins.filter((item) => {
      if (!isObject(item) || item.name !== PLUGIN_NAME || !isObject(item.source)) return true;
      return !(item.source.source === "local" && item.source.path === MARKETPLACE_SOURCE);
    });
    await writeJsonAtomic(paths.marketplace, marketplace);
  }
  const manifest = await readJson(join(paths.plugin, ".codex-plugin", "plugin.json"));
  if (manifest?.name === PLUGIN_NAME) await rm(paths.plugin, { recursive: true, force: true });
  const legacyManifest = await readJson(join(paths.legacyPlugin, ".codex-plugin", "plugin.json"));
  if (legacyManifest?.name === PLUGIN_NAME) await rm(paths.legacyPlugin, { recursive: true, force: true });
  return {
    installed: false,
    pluginPresent: false,
    marketplacePresent: false,
    commandsCurrent: false,
    versionCurrent: false,
    detail: "Zimlo Personal 插件源已移除；若 GUI 中仍显示已安装，请在 Plugins 页面卸载",
    paths,
  };
}

export function codexPluginDeepLink(paths: CodexPluginPaths, mode?: "share"): string {
  const suffix = mode ? `&mode=${mode}` : "";
  return `codex://plugins/${PLUGIN_NAME}?marketplacePath=${encodeURIComponent(paths.marketplace)}${suffix}`;
}
