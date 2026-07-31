import { mkdtempSync, rmSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectIntegrationStatuses } from "../src/integration-status.js";
import { invalidateIntegrationProbes } from "../src/probe-cache.js";

const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  invalidateIntegrationProbes();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A counting stand-in for the Codex CLI: logs every invocation and answers the
// two probes (`mcp get zimlo`, `plugin list --json`) with fixed output.
async function installFakeCodex(home: string, entrypoint: string): Promise<{ bin: string; log: string }> {
  const bin = join(home, "codex");
  const log = join(home, "invocations.log");
  const script = [
    "#!/bin/sh",
    `echo "$@" >> "${log}"`,
    'if [ "$1" = "mcp" ]; then',
    `  echo "zimlo  ${entrypoint}  via  ${process.execPath}"`,
    "fi",
    'if [ "$1" = "plugin" ]; then',
    "  echo '{\"installed\":[]}'",
    "fi",
    "",
  ].join("\n");
  await writeFile(bin, script, { mode: 0o755 });
  await chmod(bin, 0o755);
  return { bin, log };
}

async function countInvocations(log: string, prefix: string): Promise<number> {
  const content = await readFile(log, "utf8").catch(() => "");
  return content.split("\n").filter((line) => line.startsWith(prefix)).length;
}

describe("integration probe cache", () => {
  it("spawns each Codex probe once across repeated status inspections, and rescans after invalidation", async () => {
    const root = mkdtempSync(join(tmpdir(), "zimlo-probes-"));
    const home = mkdtempSync(join(tmpdir(), "zimlo-probes-home-"));
    roots.push(root, home);
    const entrypoint = join(root, "cli", "dist", "index.js");
    const { bin, log } = await installFakeCodex(home, entrypoint);
    setEnv("ZIMLO_CODEX_BIN", bin);
    setEnv("ZIMLO_CLAUDE_BIN", join(home, "missing-claude"));
    setEnv("HOME", home);

    invalidateIntegrationProbes();
    const first = await inspectIntegrationStatuses(entrypoint);
    const second = await inspectIntegrationStatuses(entrypoint);
    expect(second).toEqual(first);
    expect(await countInvocations(log, "mcp get zimlo")).toBe(1);
    expect(await countInvocations(log, "plugin list --json")).toBe(1);
    // The cached MCP probe really saw this entrypoint: CLI status is wired up.
    expect(first.find((status) => status.id === "codex_cli")?.state).toBe("partial"); // hooks 未装，mcp 已配

    invalidateIntegrationProbes();
    await inspectIntegrationStatuses(entrypoint);
    expect(await countInvocations(log, "mcp get zimlo")).toBe(2);
    expect(await countInvocations(log, "plugin list --json")).toBe(2);
  });
});
