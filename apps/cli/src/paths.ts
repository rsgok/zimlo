import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = process.env.ZIMLO_HOME ? resolve(process.env.ZIMLO_HOME) : join(homedir(), ".zimlo");

export const ZIMLO_PATHS = {
  root,
  database: join(root, "zimlo.db"),
  config: join(root, "config.json"),
  run: join(root, "run"),
  socket: join(root, "run", "bridge.sock"),
  serviceLock: join(root, "run", "service.lock"),
  service: join(root, "run", "service.json"),
  startupDiagnostics: join(root, "run", "startup-diagnostics.json"),
  manualStop: join(root, "run", "manual-stop"),
  logs: join(root, "logs"),
  materials: join(root, "materials"),
  materialStaging: join(root, "materials", ".staging"),
  autostartLog: join(root, "logs", "autostart.log"),
} as const;
