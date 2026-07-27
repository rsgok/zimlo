import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireServiceInstance,
  ServiceAlreadyRunningError,
} from "../src/service-instance.js";

describe("service instance ownership", () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("allows only one live service for a ZIMLO_HOME", async () => {
    root = await mkdtemp(join(tmpdir(), "zimlo-instance-"));
    const lockPath = join(root, "run", "service.lock");
    const first = await acquireServiceInstance({
      lockPath,
      entrypoint: "/Applications/Zimlo.app/Contents/runtime/index.js",
      pid: 101,
      processAlive: (pid) => pid === 101,
      installExitCleanup: false,
    });

    await expect(acquireServiceInstance({
      lockPath,
      entrypoint: "/tmp/other.js",
      pid: 202,
      processAlive: (pid) => pid === 101,
      installExitCleanup: false,
    })).rejects.toBeInstanceOf(ServiceAlreadyRunningError);

    await first.release();
    const second = await acquireServiceInstance({
      lockPath,
      entrypoint: "/tmp/other.js",
      pid: 202,
      processAlive: () => false,
      installExitCleanup: false,
    });
    expect(second.owner.pid).toBe(202);
    await second.release();
  });

  it("reclaims a stale lock left by a dead process", async () => {
    root = await mkdtemp(join(tmpdir(), "zimlo-instance-"));
    const lockPath = join(root, "run", "service.lock");
    const stale = await acquireServiceInstance({
      lockPath,
      entrypoint: "/tmp/stale.js",
      pid: 303,
      processAlive: () => false,
      installExitCleanup: false,
    });
    const ownerBefore = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    expect(ownerBefore.pid).toBe(303);

    const recovered = await acquireServiceInstance({
      lockPath,
      entrypoint: "/tmp/recovered.js",
      pid: 404,
      processAlive: () => false,
      installExitCleanup: false,
    });
    expect(recovered.owner.pid).toBe(404);
    await recovered.release();
    await stale.release();
  });
});
