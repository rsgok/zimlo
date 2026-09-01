import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatServiceInspection,
  inspectService,
  isServiceOperational,
  stopService,
  type ServiceInspection,
} from "../src/service-inspect.js";
import { isManualStopSet, writeServiceDescriptor, type ServiceDescriptor } from "../src/service-state.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zimlo-inspect-"));
  roots.push(root);
  return root;
}

function paths(root: string) {
  return {
    servicePath: join(root, "run", "service.json"),
    lockPath: join(root, "run", "service.lock"),
    socketPath: join(root, "run", "bridge.sock"),
    diagnosticsPath: join(root, "run", "startup-diagnostics.json"),
    manualStopPath: join(root, "run", "manual-stop"),
  };
}

function descriptor(pid: number): ServiceDescriptor {
  return {
    pid,
    port: 4747,
    version: "0.2.0",
    protocolVersion: 5,
    startedAt: "2026-07-29T00:00:00.000Z",
    socketPath: "/tmp/bridge.sock",
    logPath: "/tmp/autostart.log",
  };
}

async function writeLockOwner(lockPath: string, pid: number): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({
    pid,
    token: "token-1",
    entrypoint: "/app/dist/index.js",
    startedAt: "2026-07-29T00:00:00.000Z",
  }));
}

const healthyFetch = (async () => ({
  ok: true,
  json: async () => ({ ok: true, version: "0.2.0", protocolVersion: 5 }),
})) as unknown as typeof fetch;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("inspectService", () => {
  it("reports not_running when no descriptor exists", async () => {
    const root = tempRoot();
    const inspection = await inspectService({
      ...paths(root),
      tcpProbe: async () => false,
      socketProbe: async () => false,
    });
    expect(inspection.ownership).toBe("not_running");
    expect(inspection.pidAlive).toBe(false);
    expect(inspection.portReachable).toBe(false);
    expect(inspection.health).toBeNull();
  });

  it("verifies ownership when descriptor and lock owner agree and healthz responds", async () => {
    const root = tempRoot();
    const options = paths(root);
    await writeServiceDescriptor(options.servicePath, descriptor(4242));
    await writeLockOwner(options.lockPath, 4242);
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(options.socketPath, "");
    const inspection = await inspectService({
      ...options,
      alive: () => true,
      fetchImpl: healthyFetch,
      tcpProbe: async () => true,
      socketProbe: async () => true,
    });
    expect(inspection.ownership).toBe("verified");
    expect(inspection.health?.ok).toBe(true);
    expect(inspection.health?.protocolVersion).toBe(5);
    expect(inspection.socketReachable).toBe(true);
    expect(inspection.logPath).toBe("/tmp/autostart.log");
  });

  it("marks a live descriptor without a lock as unverifiable", async () => {
    const root = tempRoot();
    const options = paths(root);
    await writeServiceDescriptor(options.servicePath, descriptor(4242));
    const inspection = await inspectService({
      ...options,
      alive: () => true,
      fetchImpl: healthyFetch,
      tcpProbe: async () => true,
      socketProbe: async () => false,
    });
    expect(inspection.ownership).toBe("unverifiable");
  });

  it("reports a stale descriptor plus a foreign port occupier", async () => {
    const root = tempRoot();
    const options = paths(root);
    await writeServiceDescriptor(options.servicePath, descriptor(4242));
    const inspection = await inspectService({
      ...options,
      alive: () => false,
      tcpProbe: async () => true,
      lookupPortOwner: async () => ({ pid: 9001, command: "python3" }),
      socketProbe: async () => false,
    });
    expect(inspection.ownership).toBe("stale");
    expect(inspection.portReachable).toBe(true);
    expect(inspection.portOwner).toEqual({ pid: 9001, command: "python3" });
  });
});

describe("stopService", () => {
  it("stops the bridge proven by the instance lock and writes the manual-stop marker", async () => {
    const root = tempRoot();
    const options = paths(root);
    await writeServiceDescriptor(options.servicePath, descriptor(4242));
    await writeLockOwner(options.lockPath, 4242);
    let running = true;
    const signals: string[] = [];
    const result = await stopService({
      servicePath: options.servicePath,
      lockPath: options.lockPath,
      manualStopPath: options.manualStopPath,
      alive: () => running,
      kill: (_pid, signal) => {
        signals.push(signal);
        running = false;
      },
      pollMs: 5,
    });
    expect(result).toEqual({ status: "stopped", pid: 4242 });
    expect(signals).toEqual(["SIGTERM"]);
    expect(await isManualStopSet(options.manualStopPath)).toBe(true);
  });

  it("refuses to stop a live process that lacks a lock", async () => {
    const root = tempRoot();
    const options = paths(root);
    await writeServiceDescriptor(options.servicePath, descriptor(4242));
    let killed = false;
    const result = await stopService({
      servicePath: options.servicePath,
      lockPath: options.lockPath,
      manualStopPath: options.manualStopPath,
      alive: () => true,
      kill: () => {
        killed = true;
      },
    });
    expect(result.status).toBe("refused");
    expect(killed).toBe(false);
    expect(await isManualStopSet(options.manualStopPath)).toBe(false);
  });

  it("refuses when lock owner and descriptor disagree", async () => {
    const root = tempRoot();
    const options = paths(root);
    await writeServiceDescriptor(options.servicePath, descriptor(4242));
    await writeLockOwner(options.lockPath, 5151);
    const result = await stopService({
      servicePath: options.servicePath,
      lockPath: options.lockPath,
      manualStopPath: options.manualStopPath,
      alive: () => true,
      kill: () => undefined,
    });
    expect(result.status).toBe("refused");
  });

  it("writes the marker even when nothing is running", async () => {
    const root = tempRoot();
    const options = paths(root);
    const result = await stopService({
      servicePath: options.servicePath,
      lockPath: options.lockPath,
      manualStopPath: options.manualStopPath,
      alive: () => false,
      kill: () => undefined,
    });
    expect(result).toEqual({ status: "not_running" });
    expect(await isManualStopSet(options.manualStopPath)).toBe(true);
  });

  it("reports stop_failed when the process ignores SIGTERM", async () => {
    const root = tempRoot();
    const options = paths(root);
    await writeLockOwner(options.lockPath, 4242);
    const result = await stopService({
      servicePath: options.servicePath,
      lockPath: options.lockPath,
      manualStopPath: options.manualStopPath,
      alive: () => true,
      kill: () => undefined,
      waitMs: 20,
      pollMs: 5,
    });
    expect(result.status).toBe("stop_failed");
    expect(await isManualStopSet(options.manualStopPath)).toBe(false);
  });
});

describe("formatServiceInspection", () => {
  const base: ServiceInspection = {
    descriptor: null,
    diagnostics: null,
    manualStop: false,
    pidAlive: false,
    ownership: "not_running",
    port: 4747,
    portReachable: false,
    portOwner: null,
    health: null,
    socketExists: false,
    socketReachable: false,
    logPath: null,
  };

  it("renders a running service", () => {
    const text = formatServiceInspection({
      ...base,
      descriptor: descriptor(4242),
      pidAlive: true,
      ownership: "verified",
      portReachable: true,
      health: { ok: true, version: "0.2.0", protocolVersion: 5 },
      socketExists: true,
      socketReachable: true,
      diagnostics: { at: "2026-07-29T00:00:00.000Z", ok: true, pid: 4242 },
      logPath: "/tmp/autostart.log",
    });
    expect(text).toContain("✓ 进程");
    expect(text).toContain("4242");
    expect(text).toContain("协议 v5");
    expect(text).toContain("✓ Socket");
    expect(text).toContain("/tmp/autostart.log");
  });

  it("renders a foreign port occupier and the manual-stop marker", () => {
    const text = formatServiceInspection({
      ...base,
      descriptor: descriptor(4242),
      ownership: "stale",
      portReachable: true,
      portOwner: { pid: 9001, command: "python3" },
      manualStop: true,
      diagnostics: { at: "2026-07-29T00:00:00.000Z", ok: false, code: "port_in_use", message: "端口 4747 已被占用" },
    });
    expect(text).toContain("过期记录");
    expect(text).toContain("被其他进程占用（python3，PID 9001）");
    expect(text).toContain("手动停止标记");
    expect(text).toContain("port_in_use");
  });
});

describe("isServiceOperational", () => {
  const healthy: ServiceInspection = {
    descriptor: descriptor(4242), diagnostics: null, manualStop: false,
    pidAlive: true, ownership: "verified", port: 4747, portReachable: true,
    portOwner: null, health: { ok: true, version: "0.2.0", protocolVersion: 5 },
    socketExists: true, socketReachable: true, logPath: null,
  };

  it("requires verified ownership, a healthy endpoint, and the expected protocol", () => {
    expect(isServiceOperational(healthy, 5)).toBe(true);
    expect(isServiceOperational({ ...healthy, ownership: "unverifiable" }, 5)).toBe(false);
    expect(isServiceOperational({ ...healthy, health: { ok: false } }, 5)).toBe(false);
    expect(isServiceOperational(healthy, 2)).toBe(false);
  });
});
