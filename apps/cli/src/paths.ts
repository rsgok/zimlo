import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = process.env.ZIMLO_HOME ? resolve(process.env.ZIMLO_HOME) : join(homedir(), ".zimlo");

export const ZIMLO_PATHS = {
  root,
  database: join(root, "zimlo.db"),
  config: join(root, "config.json"),
  run: join(root, "run"),
  socket: join(root, "run", "bridge.sock"),
  logs: join(root, "logs"),
} as const;
