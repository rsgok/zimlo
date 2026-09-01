import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { doctorHasBlockingFailure, formatDoctor, runDoctor, type DoctorCheck } from "../src/doctor.js";
import type { ServiceInspection } from "../src/service-inspect.js";

const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeInspection(overrides: Partial<ServiceInspection>): ServiceInspection {
  return {
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
    ...overrides,
  };
}

const cloudOk = async () => ({ reachable: true, detail: "已连接（测试）" });

async function runFakeDoctor(inspection: ServiceInspection): Promise<DoctorCheck[]> {
  const home = mkdtempSync(join(tmpdir(), "zimlo-doctor-home-"));
  roots.push(home);
  setEnv("ZIMLO_CODEX_BIN", join(home, "missing-codex"));
  setEnv("ZIMLO_CLAUDE_BIN", join(home, "missing-claude"));
  setEnv("HOME", home);
  return runDoctor(join(home, "cli", "dist", "index.js"), {
    inspect: async () => inspection,
    cloudCheck: cloudOk,
  });
}

describe("runDoctor bridge checks", () => {
  it("passes when the bridge is verified and the protocol matches", async () => {
    const checks = await runFakeDoctor(fakeInspection({
      descriptor: {
        pid: 4242,
        port: 4747,
        version: "0.2.0",
        protocolVersion: 5,
        startedAt: "2026-07-29T00:00:00.000Z",
        socketPath: "/tmp/bridge.sock",
        logPath: null,
      },
      pidAlive: true,
      ownership: "verified",
      portReachable: true,
      health: { ok: true, version: "0.2.0", protocolVersion: 5 },
      diagnostics: { at: "2026-07-29T00:00:00.000Z", ok: true, pid: 4242 },
    }));
    const bridge = checks.find((check) => check.name === "Bridge 服务");
    expect(bridge?.ok).toBe(true);
    expect(bridge?.blocking).toBe(true);
    expect(bridge?.detail).toContain("PID 4242");
    expect(checks.find((check) => check.name === "启动诊断")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "云同步")?.ok).toBe(true);
  });

  it("points to zimlo start when the bridge is not running", async () => {
    const checks = await runFakeDoctor(fakeInspection({}));
    const bridge = checks.find((check) => check.name === "Bridge 服务");
    expect(bridge?.ok).toBe(false);
    expect(bridge?.fix).toBe("zimlo start");
    expect(bridge?.blocking).toBe(true);
    const output = formatDoctor(checks);
    expect(output).toContain("→ 修复: zimlo start");
  });

  it("points to stop && start on protocol mismatch", async () => {
    const checks = await runFakeDoctor(fakeInspection({
      descriptor: {
        pid: 4242,
        port: 4747,
        version: "0.1.0",
        protocolVersion: 1,
        startedAt: "2026-07-29T00:00:00.000Z",
        socketPath: "/tmp/bridge.sock",
        logPath: null,
      },
      pidAlive: true,
      ownership: "verified",
      portReachable: true,
      health: { ok: true, version: "0.1.0", protocolVersion: 1 },
    }));
    const bridge = checks.find((check) => check.name === "Bridge 服务");
    expect(bridge?.ok).toBe(false);
    expect(bridge?.fix).toBe("zimlo stop && zimlo start");
  });

  it("surfaces a foreign port occupier and last startup failure", async () => {
    const checks = await runFakeDoctor(fakeInspection({
      descriptor: {
        pid: 4242,
        port: 4747,
        version: "0.2.0",
        protocolVersion: 5,
        startedAt: "2026-07-29T00:00:00.000Z",
        socketPath: "/tmp/bridge.sock",
        logPath: null,
      },
      ownership: "stale",
      portReachable: true,
      portOwner: { pid: 9001, command: "python3" },
      diagnostics: { at: "2026-07-29T00:00:00.000Z", ok: false, code: "port_in_use", message: "端口 4747 已被占用" },
    }));
    const bridge = checks.find((check) => check.name === "Bridge 服务");
    expect(bridge?.ok).toBe(false);
    expect(bridge?.detail).toContain("python3");
    const diagnostics = checks.find((check) => check.name === "启动诊断");
    expect(diagnostics?.ok).toBe(false);
    expect(diagnostics?.fix).toContain("zimlo status");
  });

  it("points to zimlo hooks install when hooks are missing", async () => {
    const checks = await runFakeDoctor(fakeInspection({}));
    const hooks = checks.find((check) => check.name === "CLI hooks");
    expect(hooks?.ok).toBe(false); // 空 HOME 下 before={} ≠ after，需要安装
    expect(hooks?.fix).toBe("zimlo hooks install");
    const output = formatDoctor(checks);
    expect(output).toContain("→ 修复: zimlo hooks install");
  });
});

describe("doctor exit code", () => {
  it("fails only when a blocking check fails", () => {
    expect(doctorHasBlockingFailure([{ name: "Bridge 服务", ok: false, detail: "未运行" }])).toBe(false);
    expect(doctorHasBlockingFailure([{ name: "Node.js", ok: false, detail: "v20", blocking: true }])).toBe(true);
    expect(doctorHasBlockingFailure([{ name: "macOS", ok: true, detail: "darwin", blocking: true }])).toBe(false);
  });

  it("marks macOS/Node.js/~/.zimlo as blocking", async () => {
    const checks = await runFakeDoctor(fakeInspection({}));
    for (const name of ["macOS", "Node.js", "~/.zimlo", "Bridge 服务"]) {
      expect(checks.find((check) => check.name === name)?.blocking).toBe(true);
    }
    expect(doctorHasBlockingFailure(checks)).toBe(true);
  });
});
