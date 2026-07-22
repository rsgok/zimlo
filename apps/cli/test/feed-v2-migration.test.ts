import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { EMPTY_CAPABILITIES } from "@zimlo/protocol";
import { ZimloStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Feed V2 storage migration", () => {
  it("moves user instructions to Task events and preserves legacy agent posts idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "zimlo-feed-v2-"));
    directories.push(directory);
    const path = join(directory, "zimlo.db");
    const seed = new ZimloStore(path);
    seed.upsertSession({
      id: "session-a",
      provider: "codex",
      providerSessionId: "run-a",
      title: "Legacy task",
      cwd: "/tmp/project",
      transcriptPath: null,
      status: "idle",
      lastActivityAt: "2026-07-21T00:00:00.000Z",
      createdAt: "2026-07-21T00:00:00.000Z",
      activePid: null,
      processStartedAt: null,
      tty: null,
      correlationUncertain: false,
      capabilities: EMPTY_CAPABILITIES,
    });
    const insert = seed.database.prepare(`
      INSERT INTO feed_posts (
        id, task_id, run_id, agent_id, session_id, kind, title, body,
        action_required, actions_json, pending_action_ids_json, dedupe_key,
        source, created_at, content_json
      ) VALUES (?, 'task-a', 'run-a', 'codex', 'session-a', ?, ?, ?, 0, '[]', '[]', ?, ?, ?, NULL)
    `);
    insert.run("user-post", "instruction", "你交给 Agent 的任务", "请修复登录问题", "instruction:1", "user", "2026-07-21T00:00:00.000Z");
    insert.run("agent-post", "result", "登录问题已修复", "刷新竞态已消除", "result:1", "agent", "2026-07-21T00:01:00.000Z");
    seed.database.prepare("DELETE FROM metadata WHERE key = 'feed_v2_migration'").run();
    seed.close();

    const migrated = new ZimloStore(path);
    expect(migrated.listFeedPosts()).toEqual([expect.objectContaining({
      id: "agent-post",
      template: "paper",
      headline: "登录问题已修复",
      takeaway: "刷新竞态已消除",
      highlights: [],
    })]);
    expect(migrated.listEvents("session-a").filter((event) => event.kind === "user_instruction")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ prompt: "请修复登录问题" }) }),
    ]);
    expect(migrated.database.prepare("SELECT COUNT(*) AS count FROM feed_posts WHERE source = 'user'").get()).toEqual({ count: 0 });
    migrated.close();

    const oldBridge = new DatabaseSync(path);
    oldBridge.prepare(`
      INSERT INTO feed_posts (
        id, task_id, run_id, agent_id, session_id, kind, title, body,
        action_required, actions_json, pending_action_ids_json, dedupe_key,
        source, created_at, content_json
      ) VALUES ('late-user-post', 'task-a', 'run-a', 'codex', 'session-a', 'instruction',
        '你交给 Agent 的任务', '迁移完成后由旧 Bridge 写入', 0, '[]', '[]', 'instruction:late',
        'user', '2026-07-21T00:02:00.000Z', NULL)
    `).run();
    oldBridge.close();

    const reopened = new ZimloStore(path);
    expect(reopened.listEvents("session-a").filter((event) => event.kind === "user_instruction")).toHaveLength(2);
    expect(reopened.database.prepare("SELECT COUNT(*) AS count FROM feed_posts WHERE source = 'user'").get()).toEqual({ count: 0 });
    reopened.close();
  });
});
