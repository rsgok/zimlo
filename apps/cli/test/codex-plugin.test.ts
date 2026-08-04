import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexPluginPaths,
  inspectCodexPlugin,
  installCodexPlugin,
  parseCodexRuntimePlugin,
  uninstallCodexPlugin,
} from "../src/codex-plugin.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../plugin/zimlo");
const entrypoint = "/opt/zimlo/dist/index.js";
const nodePath = "/opt/zimlo/node";
const homes: string[] = [];

async function home(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), "zimlo-plugin-test-"));
  homes.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Codex GUI plugin installer", () => {
  it("distinguishes an enabled Codex plugin from a merely available source", () => {
    expect(parseCodexRuntimePlugin({
      installed: [{
        pluginId: "zimlo@personal",
        name: "zimlo",
        marketplaceName: "personal",
        version: "0.2.0",
        installed: true,
        enabled: true,
      }],
    })).toEqual({ installed: true, enabled: true, version: "0.2.0" });
    expect(parseCodexRuntimePlugin({ installed: [] })).toEqual({
      installed: false,
      enabled: false,
      version: null,
    });
  });

  it("installs a Personal plugin with absolute MCP and hook commands", async () => {
    const testHome = await home();
    const status = await installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });

    expect(status.installed).toBe(true);
    const paths = codexPluginPaths(testHome);
    const mcp = JSON.parse(await readFile(resolve(paths.plugin, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.zimlo).toEqual({
      command: nodePath,
      args: [entrypoint, "mcp", "--provider", "codex"],
    });
    const hooks = JSON.parse(await readFile(resolve(paths.plugin, "hooks/hooks.json"), "utf8"));
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PermissionRequest", "PreToolUse", "SessionStart"]);
    const input = hooks.hooks.PreToolUse[0];
    expect(input.matcher).toBe("request_user_input");
    expect(input.hooks[0].command).toContain(nodePath);
    expect(input.hooks[0].command).toContain(entrypoint);
    expect(input.hooks[0].command).toContain("--surface gui");

    const marketplace = JSON.parse(await readFile(paths.marketplace, "utf8"));
    expect(marketplace.name).toBe("personal");
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({
      name: "zimlo",
      source: { source: "local", path: "./plugins/zimlo" },
    }));
  });

  it("updates idempotently and preserves unrelated Personal plugins", async () => {
    const testHome = await home();
    const paths = codexPluginPaths(testHome);
    await installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });
    const marketplace = JSON.parse(await readFile(paths.marketplace, "utf8"));
    marketplace.interface.displayName = "Kai's plugins";
    marketplace.plugins.unshift({
      name: "other",
      source: { source: "local", path: "./plugins/other" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Productivity",
    });
    await writeFile(paths.marketplace, JSON.stringify(marketplace));

    await installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });
    const updated = JSON.parse(await readFile(paths.marketplace, "utf8"));
    expect(updated.interface.displayName).toBe("Kai's plugins");
    expect(updated.plugins.filter((item: { name: string }) => item.name === "zimlo")).toHaveLength(1);
    expect(updated.plugins.some((item: { name: string }) => item.name === "other")).toBe(true);
  });

  it("detects an installed plugin whose bundled content version is stale", async () => {
    const testHome = await home();
    const paths = codexPluginPaths(testHome);
    await installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });
    const manifestPath = resolve(paths.plugin, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "0.1.0-stale";
    await writeFile(manifestPath, JSON.stringify(manifest));

    const status = await inspectCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });
    expect(status.installed).toBe(false);
    expect(status.versionCurrent).toBe(false);
    expect(status.detail).toContain("重新安装");
  });

  it("removes only its own source entry and plugin directory", async () => {
    const testHome = await home();
    const paths = codexPluginPaths(testHome);
    await installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });
    const marketplace = JSON.parse(await readFile(paths.marketplace, "utf8"));
    marketplace.plugins.push({
      name: "other",
      source: { source: "local", path: "./plugins/other" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Productivity",
    });
    await writeFile(paths.marketplace, JSON.stringify(marketplace));

    await uninstallCodexPlugin({ home: testHome });
    const inspected = await inspectCodexPlugin(entrypoint, { home: testHome, nodePath });
    expect(inspected.installed).toBe(false);
    const updated = JSON.parse(await readFile(paths.marketplace, "utf8"));
    expect(updated.plugins).toHaveLength(1);
    expect(updated.plugins[0].name).toBe("other");
  });
});
