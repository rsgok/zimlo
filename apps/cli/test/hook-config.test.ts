import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { applyHookChanges, codexPluginHooks, hookConfigChanges, zimloHookCommand } from "../src/hook-config.js";

describe("Codex GUI plugin hooks", () => {
  let home: string | null = null;

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    home = null;
  });

  it("uses only session binding and synchronous human-action hooks", () => {
    const config = codexPluginHooks("/tmp/zimlo.js", "/tmp/node") as {
      hooks: Record<string, Array<{
        matcher?: string;
        hooks: Array<{ timeout: number; command: string; statusMessage?: string }>;
      }>>;
    };
    expect(Object.keys(config.hooks).sort()).toEqual(["PermissionRequest", "PreToolUse", "SessionStart"]);
    expect(config.hooks.PreToolUse?.[0]?.matcher).toBe("request_user_input");
    expect(config.hooks.PreToolUse?.[0]?.hooks[0]?.timeout).toBe(480);
    expect(config.hooks.PreToolUse?.[0]?.hooks[0]?.statusMessage).toBe("Waiting for Zimlo input");
    expect(config.hooks.PermissionRequest?.[0]?.hooks[0]?.timeout).toBe(480);
    expect(config.hooks.PermissionRequest?.[0]?.matcher).toBe("*");
    expect(config.hooks.SessionStart?.[0]?.hooks[0]?.statusMessage).toBeUndefined();
    expect(config.hooks.SessionStart?.[0]?.hooks[0]?.command).toContain("--surface gui");
  });

  it("uses the same three-event set for CLI providers with provider-specific input tools", async () => {
    home = await mkdtemp(join(tmpdir(), "zimlo-hooks-"));
    const [codex, claude] = await hookConfigChanges("/tmp/zimlo.js", false, home);
    const codexHooks = codex?.after.hooks as Record<string, Array<{ matcher?: string }>>;
    const claudeHooks = claude?.after.hooks as Record<string, Array<{ matcher?: string }>>;

    expect(Object.keys(codexHooks).sort()).toEqual(["PermissionRequest", "PreToolUse", "SessionStart"]);
    expect(Object.keys(claudeHooks).sort()).toEqual(["PermissionRequest", "PreToolUse", "SessionStart"]);
    expect(codexHooks.PreToolUse?.[0]?.matcher).toBe("request_user_input");
    expect(claudeHooks.PreToolUse?.[0]?.matcher).toBe("AskUserQuestion");
    expect(codexHooks.SessionStart?.[0]?.matcher).toBe("startup|resume|clear");
  });

  it("lets shared Claude settings detect GUI versus CLI at hook runtime", () => {
    expect(zimloHookCommand("/tmp/zimlo.js", "claude", "auto", "/tmp/node")).toContain("--surface auto");
  });

  it("replaces stale source-path hooks instead of running two Zimlo services", async () => {
    home = await mkdtemp(join(tmpdir(), "zimlo-hooks-"));
    const codexRoot = join(home, ".codex");
    await mkdir(codexRoot, { recursive: true });
    await writeFile(join(codexRoot, "hooks.json"), JSON.stringify({
      hooks: {
        Stop: [{
          hooks: [{
            type: "command",
            command: "'/old/node' '/Users/kai/Code/zimlo/apps/cli/dist/index.js' hook --provider codex --surface cli",
          }],
        }],
      },
    }));

    const changes = await hookConfigChanges("/Applications/Zimlo.app/runtime/index.js", false, home);
    await applyHookChanges(changes);
    const updated = JSON.parse(await readFile(join(codexRoot, "hooks.json"), "utf8"));
    const commands = Object.values(updated.hooks)
      .flatMap((groups: any) => groups)
      .flatMap((group: any) => group.hooks)
      .map((hook: any) => hook.command);
    expect(commands.some((command: string) => command.includes("/Users/kai/Code/zimlo"))).toBe(false);
    expect(commands.every((command: string) => command.includes("/Applications/Zimlo.app"))).toBe(true);
  });
});
