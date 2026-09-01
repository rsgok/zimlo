import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyStartupFailure,
  clearManualStop,
  clearServiceDescriptor,
  isManualStopSet,
  markManualStop,
  readServiceDescriptor,
  readStartupDiagnostics,
  writeServiceDescriptor,
  writeStartupDiagnostics,
  type ServiceDescriptor,
} from "../src/service-state.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zimlo-service-state-"));
  roots.push(root);
  return root;
}

function descriptor(pid: number): ServiceDescriptor {
  return {
    pid,
    port: 4747,
    version: "0.2.0",
    protocolVersion: 5,
    startedAt: "2026-07-29T00:00:00.000Z",
    socketPath: "/tmp/bridge.sock",
    logPath: null,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("service descriptor lifecycle", () => {
  it("writes, reads, and clears the descriptor only for the owning pid", async () => {
    const root = tempRoot();
    const path = join(root, "run", "service.json");
    await writeServiceDescriptor(path, descriptor(4242));
    expect(await readServiceDescriptor(path)).toEqual(descriptor(4242));

    expect(await clearServiceDescriptor(path, 9999)).toBe(false);
    expect(await readServiceDescriptor(path)).not.toBeNull();

    expect(await clearServiceDescriptor(path, 4242)).toBe(true);
    expect(await readServiceDescriptor(path)).toBeNull();
  });

  it("returns null for missing, corrupt, or wrongly shaped descriptors", async () => {
    const root = tempRoot();
    const path = join(root, "service.json");
    expect(await readServiceDescriptor(path)).toBeNull();
    await writeFile(path, "{ not json");
    expect(await readServiceDescriptor(path)).toBeNull();
    await writeFile(path, JSON.stringify({ pid: "not-a-number" }));
    expect(await readServiceDescriptor(path)).toBeNull();
  });
});

describe("startup diagnostics", () => {
  it("persists the most recent startup result", async () => {
    const root = tempRoot();
    const path = join(root, "run", "startup-diagnostics.json");
    expect(await readStartupDiagnostics(path)).toBeNull();
    await writeStartupDiagnostics(path, { at: "2026-07-29T00:00:00.000Z", ok: false, pid: 1, port: 4747, code: "port_in_use", message: "端口 4747 已被占用" });
    expect(await readStartupDiagnostics(path)).toEqual({
      at: "2026-07-29T00:00:00.000Z",
      ok: false,
      pid: 1,
      port: 4747,
      code: "port_in_use",
      message: "端口 4747 已被占用",
    });
    await writeStartupDiagnostics(path, { at: "2026-07-29T01:00:00.000Z", ok: true, pid: 2, port: 4747 });
    expect((await readStartupDiagnostics(path))?.ok).toBe(true);
  });
});

describe("manual-stop marker", () => {
  it("sets, checks, and clears the marker", async () => {
    const root = tempRoot();
    const path = join(root, "run", "manual-stop");
    expect(await isManualStopSet(path)).toBe(false);
    await markManualStop(path);
    expect(await isManualStopSet(path)).toBe(true);
    await clearManualStop(path);
    expect(await isManualStopSet(path)).toBe(false);
  });
});

describe("classifyStartupFailure", () => {
  it("keeps the EADDRINUSE keyword and adds Chinese guidance for occupied ports", () => {
    const error = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:4747"), { code: "EADDRINUSE" });
    const failure = classifyStartupFailure(error, 4747);
    expect(failure.code).toBe("port_in_use");
    expect(failure.stderrText).toContain("EADDRINUSE");
    expect(failure.stderrText).toContain("4747");
    expect(failure.stderrText).toContain("zimlo status");
  });

  it("classifies JSON syntax errors as corrupt configuration with the SyntaxError keyword", () => {
    const failure = classifyStartupFailure(new SyntaxError("Unexpected token } in JSON at position 3"), 4747);
    expect(failure.code).toBe("config_corrupt");
    expect(failure.stderrText).toContain("SyntaxError");
    expect(failure.stderrText).toContain("zimlo doctor");
  });

  it("classifies missing runtime modules with the ERR_MODULE_NOT_FOUND keyword", () => {
    const failure = classifyStartupFailure(new Error("Cannot find module '/app/dist/index.js'"), 4747);
    expect(failure.code).toBe("runtime_missing");
    expect(failure.stderrText).toContain("ERR_MODULE_NOT_FOUND");
  });

  it("classifies a corrupt SQLite database as corrupt configuration", () => {
    const failure = classifyStartupFailure(new Error("file is not a database"), 4747);
    expect(failure.code).toBe("config_corrupt");
    expect(failure.stderrText).toContain("SQLITE_CORRUPT");
  });

  it("falls back to a generic startup failure", () => {
    const failure = classifyStartupFailure(new Error("boom"), 4747);
    expect(failure.code).toBe("startup_failed");
    expect(failure.stderrText).toContain("boom");
    expect(failure.stderrText).toContain("zimlo doctor");
  });
});
