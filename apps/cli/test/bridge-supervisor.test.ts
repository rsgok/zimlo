import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { bridgeProtocolVersion, ensureBridgeRunning, isBridgeSocketReachable } from "../src/bridge-supervisor.js";

describe("Bridge supervisor fail-open behavior", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("reports an absent Bridge without throwing", async () => {
    root = await mkdtemp(join(tmpdir(), "zimlo-supervisor-"));
    expect(await isBridgeSocketReachable(join(root, "missing.sock"), 20)).toBe(false);
  });

  it("starts a detached process, writes its log, and returns false after a bounded timeout", async () => {
    root = await mkdtemp(join(tmpdir(), "zimlo-supervisor-"));
    const entrypoint = join(root, "idle.mjs");
    const logPath = join(root, "logs", "autostart.log");
    await writeFile(entrypoint, "setTimeout(() => process.exit(0), 100);\n");
    const startedAt = Date.now();
    const reachable = await ensureBridgeRunning({
      entrypoint,
      socketPath: join(root, "missing.sock"),
      logPath,
      startupTimeoutMs: 50,
    });
    expect(reachable).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await access(logPath);
  });

  it("reads the Bridge protocol handshake before reusing a running socket", async () => {
    root = await mkdtemp(join(tmpdir(), "zimlo-supervisor-"));
    const socketPath = join(root, "bridge.sock");
    const server = createServer((socket) => {
      socket.once("data", () => socket.end(`${JSON.stringify({ type: "bridge_info", protocolVersion: 2 })}\n`));
    });
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
    try {
      expect(await bridgeProtocolVersion(socketPath)).toBe(2);
      expect(await ensureBridgeRunning({ entrypoint: "/missing", socketPath, logPath: join(root, "log") })).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
