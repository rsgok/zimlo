import { describe, expect, it } from "vitest";
import { codexPluginHooks, zimloHookCommand } from "../src/hook-config.js";

describe("Codex GUI plugin hooks", () => {
  it("uses only lifecycle and approval hooks with a fail-open Stop timeout", () => {
    const config = codexPluginHooks("/tmp/zimlo.js", "/tmp/node") as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number; command: string }> }>> };
    expect(Object.keys(config.hooks).sort()).toEqual(["PermissionRequest", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect(config.hooks.Stop?.[0]?.hooks[0]?.timeout).toBe(3);
    expect(config.hooks.PermissionRequest?.[0]?.hooks[0]?.timeout).toBe(480);
    expect(config.hooks.SessionStart?.[0]?.hooks[0]?.command).toContain("--surface gui");
  });

  it("lets shared Claude settings detect GUI versus CLI at hook runtime", () => {
    expect(zimloHookCommand("/tmp/zimlo.js", "claude", "auto", "/tmp/node")).toContain("--surface auto");
  });
});
