import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionBroker } from "../src/action-broker.js";
import { BridgeServer } from "../src/bridge.js";
import { CloudService } from "../src/cloud-service.js";
import { DeviceManager } from "../src/device-manager.js";
import { ResumeService } from "../src/resume-service.js";
import { RuntimeHub } from "../src/runtime.js";
import { ZimloStore } from "../src/store.js";
import { TaskCommandService } from "../src/task-command-service.js";
import { ZIMLO_PROTOCOL_VERSION, ZIMLO_VERSION } from "../src/version.js";

const roots: string[] = [];
const bridges: BridgeServer[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function createBridge(): Promise<{ localUrl: string; home: string }> {
  const root = mkdtempSync(join(tmpdir(), "zimlo-api-"));
  const home = mkdtempSync(join(tmpdir(), "zimlo-api-home-"));
  roots.push(root, home);
  setEnv("ZIMLO_CLOUD_DISABLED", "1");
  setEnv("ZIMLO_CODEX_BIN", join(home, "missing-codex"));
  setEnv("ZIMLO_CLAUDE_BIN", join(home, "missing-claude"));
  setEnv("HOME", home);
  const store = new ZimloStore(join(root, "zimlo.db"));
  const cloud = new CloudService(store);
  const runtime = new RuntimeHub(store, cloud);
  const broker = new ActionBroker(runtime);
  const devices = new DeviceManager(store);
  devices.localAdmin();
  const resume = new ResumeService(runtime, broker);
  const taskCommands = new TaskCommandService(runtime, resume);
  const entrypoint = join(root, "cli", "dist", "index.js");
  const bridge = new BridgeServer({ runtime, broker, devices, taskCommands, cloud, entrypoint, options: { port: 0, lan: false } });
  bridges.push(bridge);
  const urls = await bridge.start();
  return { localUrl: urls.localUrl, home };
}

interface StableError {
  code: string;
  message: string;
  recoverable: boolean;
  action?: string;
}

async function expectStableError(response: Response, status: number): Promise<StableError> {
  expect(response.status).toBe(status);
  const body = await response.json() as StableError;
  expect(typeof body.code).toBe("string");
  expect(typeof body.message).toBe("string");
  expect(typeof body.recoverable).toBe("boolean");
  expect(body.message).not.toContain("Internal Server Error");
  return body;
}

describe("local API stable errors", () => {
  it("serves /healthz with the shared version constants", async () => {
    const { localUrl } = await createBridge();
    const response = await fetch(`${localUrl}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; version: string; protocolVersion: number };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(ZIMLO_VERSION);
    expect(body.protocolVersion).toBe(ZIMLO_PROTOCOL_VERSION);
  });

  it("maps a missing agent runtime to no_integrations with an action", async () => {
    const { localUrl } = await createBridge();
    const response = await fetch(`${localUrl}/api/local/integrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "cli" }),
    });
    const body = await expectStableError(response, 400);
    expect(body.code).toBe("no_integrations");
    expect(body.recoverable).toBe(false);
    expect(body.action).toContain("安装");
  });

  it("rejects an unknown integration target with a stable 400", async () => {
    const { localUrl } = await createBridge();
    const response = await fetch(`${localUrl}/api/local/integrations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "nope" }),
    });
    const body = await expectStableError(response, 400);
    expect(body.code).toBe("unknown_integration_target");
  });

  it("maps corrupt hook configuration to config_corrupt on status", async () => {
    const { localUrl, home } = await createBridge();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{ not json");
    const response = await fetch(`${localUrl}/api/local/status`);
    const body = await expectStableError(response, 500);
    expect(body.code).toBe("config_corrupt");
    expect(body.recoverable).toBe(false);
    expect(body.action).toBeTruthy();
  });

  it("maps pairing creation failure to pairing_create_failed (503)", async () => {
    const { localUrl } = await createBridge();
    const response = await fetch(`${localUrl}/api/local/pairing`, { method: "POST" });
    const body = await expectStableError(response, 503);
    expect(body.code).toBe("pairing_create_failed");
    expect(body.recoverable).toBe(true);
    expect(body.action).toContain("网络");
  });

  it("keeps /api/local-bootstrap working and reports status when healthy", async () => {
    const { localUrl } = await createBridge();
    const bootstrap = await fetch(`${localUrl}/api/local-bootstrap`);
    expect(bootstrap.status).toBe(200);
    const device = await bootstrap.json() as { deviceId: string; deviceKey: string };
    expect(device.deviceId).toBeTruthy();
    const status = await fetch(`${localUrl}/api/local/status`);
    expect(status.status).toBe(200);
    const body = await status.json() as { ready: boolean; integrations: unknown[] };
    expect(body.ready).toBe(true);
    expect(body.integrations.length).toBeGreaterThan(0);
  });
});
