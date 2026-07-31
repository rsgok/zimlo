import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { applyHookChanges, formatHookChangesSummary, hookConfigChanges } from "../src/hook-config.js";

let home: string | null = null;

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = null;
});

async function tempHome(): Promise<string> {
  home = await mkdtemp(join(tmpdir(), "zimlo-hook-summary-"));
  return home;
}

describe("formatHookChangesSummary", () => {
  it("summarizes additions per event instead of dumping JSON", async () => {
    const dir = await tempHome();
    const changes = await hookConfigChanges("/tmp/zimlo.js", false, dir, ["codex"]);
    expect(changes).toHaveLength(1);
    const summary = formatHookChangesSummary(changes);
    expect(summary).toContain(join(dir, ".codex", "hooks.json"));
    expect(summary).toContain("+ SessionStart：新增 1 条 hook");
    expect(summary).toContain("+ PermissionRequest：新增 1 条 hook");
    expect(summary).toContain("合计：新增 6 条，移除 0 条，保留 0 条。");
    expect(summary).not.toContain('"hooks"');
  });

  it("reports unchanged files and counts kept hooks on upgrades", async () => {
    const dir = await tempHome();
    const codexDir = join(dir, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "hooks.json"), JSON.stringify({
      hooks: {
        Stop: [{
          hooks: [
            { type: "command", command: "'/old/node' '/old/zimlo.js' hook --provider codex --surface cli" },
            { type: "command", command: "user-hook --do-stuff" },
          ],
        }],
      },
    }));
    const changes = await hookConfigChanges("/tmp/zimlo.js", false, dir, ["codex"]);
    const summary = formatHookChangesSummary(changes);
    expect(summary).toContain("- Stop：移除 1 条 hook");
    expect(summary).toContain("+ Stop：新增 1 条 hook");
    expect(summary).toContain("保留 1 条");

    await applyHookChanges(changes);
    const unchanged = await hookConfigChanges("/tmp/zimlo.js", false, dir, ["codex"]);
    expect(formatHookChangesSummary(unchanged)).toContain("（已是最新，无变化）");
  });
});

describe("applyHookChanges reporting", () => {
  it("returns changed flags and backup paths, and skips writes when unchanged", async () => {
    const dir = await tempHome();
    const changes = await hookConfigChanges("/tmp/zimlo.js", false, dir, ["codex"]);
    const applied = await applyHookChanges(changes);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.changed).toBe(true);
    expect(applied[0]?.backupPath).toBeNull();

    const second = await applyHookChanges(await hookConfigChanges("/tmp/zimlo.js", false, dir, ["codex"]));
    expect(second[0]?.changed).toBe(false);
    expect(second[0]?.backupPath).toBeNull();
    expect((await readdir(join(dir, ".codex"))).filter((name) => name.includes("zimlo-backup"))).toHaveLength(0);

    // 配置被外部改成旧版 Zimlo hook 后再次应用：需要升级，生成备份且备份
    // 内容等于改动前的文件。
    const hooksPath = join(dir, ".codex", "hooks.json");
    const stale = {
      custom: true,
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "'/old/node' '/old/zimlo.js' hook --provider codex --surface cli" }] }],
      },
    };
    await writeFile(hooksPath, JSON.stringify(stale));
    const third = await applyHookChanges(await hookConfigChanges("/tmp/zimlo.js", false, dir, ["codex"]));
    expect(third[0]?.changed).toBe(true);
    expect(third[0]?.backupPath).not.toBeNull();
    const backup = JSON.parse(await readFile(third[0]!.backupPath!, "utf8"));
    expect(backup.custom).toBe(true);
    expect(backup.hooks.Stop[0].hooks[0].command).toContain("/old/zimlo.js");
  });

  it("only touches the detected provider: no ~/.claude directory is created for codex-only installs", async () => {
    const dir = await tempHome();
    const changes = await hookConfigChanges("/tmp/zimlo.js", false, dir, ["codex"]);
    expect(changes.map((change) => change.path)).toEqual([join(dir, ".codex", "hooks.json")]);
    await applyHookChanges(changes);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".codex", "hooks.json"))).toBe(true);
  });
});
