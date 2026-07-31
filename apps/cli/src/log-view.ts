// Tail/follow helpers for `zimlo logs`. Kept dependency-free: follow polls
// file size and streams appended bytes, surviving truncation and rotation.
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function latestLogFile(logsDir: string): Promise<string | null> {
  try {
    const entries = await readdir(logsDir, { withFileTypes: true });
    let latest: { path: string; mtimeMs: number } | null = null;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
      const path = join(logsDir, entry.name);
      const info = await stat(path);
      if (!latest || info.mtimeMs > latest.mtimeMs) latest = { path, mtimeMs: info.mtimeMs };
    }
    return latest?.path ?? null;
  } catch {
    return null;
  }
}

export async function readTail(path: string, maxLines = 200, maxBytes = 512 * 1024): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - maxBytes);
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline >= 0) text = text.slice(newline + 1);
    }
    const lines = text.split("\n");
    return lines.length > maxLines ? lines.slice(-maxLines).join("\n") : text;
  } finally {
    await handle.close();
  }
}

// Never resolves; the CLI exits via SIGINT/SIGTERM.
export async function followFile(path: string, emit: (chunk: string) => void, pollMs = 500): Promise<void> {
  let offset = await stat(path).then((info) => info.size).catch(() => 0);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const size = await stat(path).then((info) => info.size).catch(() => null);
    if (size === null) continue;
    if (size < offset) offset = 0;
    if (size === offset) continue;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      await handle.read(buffer, 0, buffer.length, offset);
      offset = size;
      emit(buffer.toString("utf8"));
    } finally {
      await handle.close();
    }
  }
}
