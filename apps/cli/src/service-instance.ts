import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ServiceOwner {
  pid: number;
  token: string;
  entrypoint: string;
  startedAt: string;
}

export interface ServiceInstanceOptions {
  lockPath: string;
  entrypoint: string;
  pid?: number;
  processAlive?: (pid: number) => boolean;
  installExitCleanup?: boolean;
}

export interface ServiceInstanceLease {
  owner: ServiceOwner;
  release(): Promise<void>;
}

export class ServiceAlreadyRunningError extends Error {
  readonly owner: ServiceOwner;

  constructor(owner: ServiceOwner) {
    super(`Zimlo 已在运行（PID ${owner.pid}）。`);
    this.name = "ServiceAlreadyRunningError";
    this.owner = owner;
  }
}

function isServiceOwner(value: unknown): value is ServiceOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<ServiceOwner>;
  return Number.isInteger(owner.pid)
    && Number(owner.pid) > 0
    && typeof owner.token === "string"
    && owner.token.length > 0
    && typeof owner.entrypoint === "string"
    && typeof owner.startedAt === "string";
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(lockPath: string): Promise<ServiceOwner | null> {
  const ownerPath = join(lockPath, "owner.json");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const value: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
      return isServiceOwner(value) ? value : null;
    } catch {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return null;
}

export async function readServiceLockOwner(lockPath: string): Promise<ServiceOwner | null> {
  return readOwner(lockPath);
}

export async function acquireServiceInstance(options: ServiceInstanceOptions): Promise<ServiceInstanceLease> {
  const owner: ServiceOwner = {
    pid: options.pid ?? process.pid,
    token: randomUUID(),
    entrypoint: options.entrypoint,
    startedAt: new Date().toISOString(),
  };
  const alive = options.processAlive ?? processAlive;
  await mkdir(dirname(options.lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mkdir(options.lockPath, { mode: 0o700 });
      await writeFile(
        join(options.lockPath, "owner.json"),
        `${JSON.stringify(owner, null, 2)}\n`,
        { mode: 0o600 },
      );

      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        const current = await readOwner(options.lockPath);
        if (current?.token === owner.token) {
          await rm(options.lockPath, { recursive: true, force: true });
        }
      };
      if (options.installExitCleanup !== false) {
        process.once("exit", () => {
          try {
            const current = JSON.parse(readFileSync(join(options.lockPath, "owner.json"), "utf8")) as unknown;
            if (isServiceOwner(current) && current.token === owner.token) {
              rmSync(options.lockPath, { recursive: true, force: true });
            }
          } catch {
            // A crash leaves a stale lock that the next process safely reclaims.
          }
        });
      }
      return { owner, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readOwner(options.lockPath);
      if (existing && alive(existing.pid)) throw new ServiceAlreadyRunningError(existing);
      await rm(options.lockPath, { recursive: true, force: true });
    }
  }
  throw new Error("无法取得 Zimlo 服务所有权，请重新打开应用。");
}
