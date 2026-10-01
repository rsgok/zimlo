import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexPluginPaths,
  inspectCodexPlugin,
  installCodexPlugin,
  parseCodexRuntimePlugin,
  uninstallCodexPlugin,
} from "../src/codex-plugin.js";
import { applyHookChanges, hookConfigChanges } from "../src/hook-config.js";

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
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("shared Codex plugin installer", () => {
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
    expect(input.hooks[0].command).toContain("--surface auto");

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

  it("migrates duplicate user hooks and prevents CLI repairs from recreating them", async () => {
    const testHome = await home();
    const codexDir = resolve(testHome, ".codex");
    await mkdir(codexDir, { recursive: true });
    const legacyCommand = "'/old/zimlo' hook --provider codex --surface cli";
    const userHook = { type: "command", command: "my-review-hook", timeout: 17 };
    const legacy = {
      custom: "preserve",
      hooks: Object.fromEntries(["SessionStart", "PreToolUse", "PermissionRequest", "Stop", "PostToolUse", "UserPromptSubmit"].map((event) => [
        event, [{ matcher: "*", hooks: [{ type: "command", command: legacyCommand }, ...(event === "Stop" ? [userHook] : [])] }],
      ])),
    };
    const userPath = resolve(codexDir, "hooks.json");
    await writeFile(userPath, JSON.stringify(legacy));

    await installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });
    const migrated = JSON.parse(await readFile(userPath, "utf8"));
    expect(migrated).toEqual({ custom: "preserve", hooks: { Stop: [{ matcher: "*", hooks: [userHook] }] } });
    const backups = (await readdir(codexDir)).filter((name) => name.includes("zimlo-backup"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(await readFile(resolve(codexDir, backups[0]!), "utf8"))).toEqual(legacy);

    const repair = await hookConfigChanges(entrypoint, false, testHome, ["codex"]);
    expect(repair[0]?.after).toEqual(migrated);
    expect((await applyHookChanges(repair))[0]?.changed).toBe(false);
    await installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });
    expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual(migrated);
    expect((await readdir(codexDir)).filter((name) => name.includes("zimlo-backup"))).toHaveLength(1);

    const pluginHooks = JSON.parse(await readFile(resolve(codexPluginPaths(testHome).plugin, "hooks/hooks.json"), "utf8"));
    const combined = JSON.stringify([migrated.hooks, pluginHooks.hooks]);
    expect(combined.match(/hook --provider codex/g)).toHaveLength(3);
  });

  it("refuses malformed legacy config before changing the plugin", async () => {
    const testHome = await home();
    await mkdir(resolve(testHome, ".codex"), { recursive: true });
    const legacyPath = resolve(testHome, ".codex/hooks.json");
    await writeFile(legacyPath, "invalid json");
    await expect(installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath })).rejects.toThrow("无法解析");
    expect(await readFile(legacyPath, "utf8")).toBe("invalid json");
    await expect(readFile(resolve(codexPluginPaths(testHome).plugin, ".codex-plugin/plugin.json"))).rejects.toThrow();
  });

  it("keeps legacy hooks when Codex plugin activation fails", async () => {
    const testHome = await home();
    const command = resolve(testHome, "codex");
    await writeFile(command, "#!/bin/sh\nif [ \"$2\" = \"list\" ]; then\n  echo '{\"installed\":[]}'\nelse\n  echo 'activation failed' >&2\n  exit 1\nfi\n", { mode: 0o755 });
    vi.stubEnv("ZIMLO_CODEX_BIN", command);
    await mkdir(resolve(testHome, ".codex"), { recursive: true });
    const userPath = resolve(testHome, ".codex/hooks.json");
    const legacy = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "'/old/zimlo' hook --provider codex --surface cli" }] }] } };
    await writeFile(userPath, JSON.stringify(legacy));
    await expect(installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath, activateRuntime: true })).rejects.toThrow("activation failed");
    expect(JSON.parse(await readFile(userPath, "utf8"))).toEqual(legacy);
    expect((await readdir(resolve(testHome, ".codex"))).filter((name) => name.includes("zimlo-backup"))).toHaveLength(0);
  });

  it("marks hard-coded GUI hooks stale even when the manifest version matches", async () => {
    const testHome = await home();
    await installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });
    const path = resolve(codexPluginPaths(testHome).plugin, "hooks/hooks.json");
    const hooks = await readFile(path, "utf8");
    await writeFile(path, hooks.replaceAll("--surface auto", "--surface gui"));
    const status = await inspectCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });
    expect(status.versionCurrent).toBe(true);
    expect(status.commandsCurrent).toBe(false);
    expect(status.installed).toBe(false);
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

  it.each([
    { state: "already absent", list: '{"installed":[]}', unresolved: false },
    { state: "still installed", list: '{"installed":[{"pluginId":"zimlo@personal","installed":true,"enabled":true}]}', unresolved: true },
    { state: "unavailable", list: null, unresolved: true },
    { state: "invalid", list: '{}', unresolved: true },
  ])("cleans the source after a removal failure when runtime state is $state", async ({ list, unresolved }) => {
    const testHome = await home();
    const paths = codexPluginPaths(testHome);
    await installCodexPlugin(entrypoint, { home: testHome, sourceRoot, nodePath });
    const marketplace = JSON.parse(await readFile(paths.marketplace, "utf8"));
    const other = { name: "other", source: { source: "local", path: "./plugins/other" } };
    marketplace.plugins.push(other);
    await writeFile(paths.marketplace, JSON.stringify(marketplace));

    const command = resolve(testHome, "codex");
    await writeFile(command, [
      "#!/bin/sh",
      'if [ "$2" = "list" ]; then',
      list === null ? "  exit 1" : `  echo '${list}'`,
      "else",
      "  echo 'runtime removal failed' >&2",
      "  exit 1",
      "fi",
      "",
    ].join("\n"), { mode: 0o755 });
    vi.stubEnv("ZIMLO_CODEX_BIN", command);

    const removal = uninstallCodexPlugin({ home: testHome, activateRuntime: true });
    if (unresolved) {
      await expect(removal).rejects.toThrow("插件源已移除，但无法确认 Codex Runtime 中的插件已卸载");
    } else {
      await expect(removal).resolves.toMatchObject({ installed: false, runtimeInstalled: false, pluginPresent: false });
    }
    await expect(readFile(resolve(paths.plugin, ".codex-plugin/plugin.json"))).rejects.toThrow();
    expect(JSON.parse(await readFile(paths.marketplace, "utf8")).plugins).toEqual([other]);
  });
});
