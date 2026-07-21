import { describe, expect, it } from "vitest";
import { codexPluginHooks } from "../src/hook-config.js";

describe("Codex GUI plugin hooks", () => {
  it("uses only lifecycle and approval hooks with a fail-open Stop timeout", () => {
    const config = codexPluginHooks("/tmp/zimlo.js", "/tmp/node") as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>> };
    expect(Object.keys(config.hooks).sort()).toEqual(["PermissionRequest", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect(config.hooks.Stop?.[0]?.hooks[0]?.timeout).toBe(3);
    expect(config.hooks.PermissionRequest?.[0]?.hooks[0]?.timeout).toBe(480);
  });
});
