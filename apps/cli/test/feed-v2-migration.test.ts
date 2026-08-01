import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_CAPABILITIES } from "@zimlo/protocol";
import { ZimloStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Feed V3 storage migration", () => {
  it("preserves tasks and content while deleting review and card-action storage", () => {
    const directory = mkdtempSync(join(tmpdir(), "zimlo-feed-v2-"));
    directories.push(directory);
    const path = join(directory, "zimlo.db");
    const seed = new ZimloStore(path);
    seed.upsertSession({
      id: "session-a",
      provider: "codex",
      surface: "cli",
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
    seed.database.exec(`
      ALTER TABLE feed_posts ADD COLUMN action_required INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE feed_posts ADD COLUMN action_prompt TEXT;
      ALTER TABLE feed_posts ADD COLUMN actions_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE feed_posts ADD COLUMN pending_action_ids_json TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE task_reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE INDEX idx_task_reviews_session_state ON task_reviews(session_id, state);
      ALTER TABLE notification_settings ADD COLUMN reviews INTEGER NOT NULL DEFAULT 1;
    `);
    seed.database.prepare("INSERT INTO task_reviews(id, task_id, session_id, post_id, state) VALUES ('review-a', 'task-a', 'session-a', 'agent-post', 'unreviewed')").run();
    const insert = seed.database.prepare(`
      INSERT INTO feed_posts (
        id, task_id, run_id, agent_id, session_id, kind, title, body,
        action_required, actions_json, pending_action_ids_json, dedupe_key,
        source, created_at, content_json
      ) VALUES (?, 'task-a', 'run-a', 'codex', 'session-a', ?, ?, ?, 0, '[]', '[]', ?, ?, ?, NULL)
    `);
    insert.run("user-post", "instruction", "你交给 Agent 的任务", "请修复登录问题", "instruction:1", "user", "2026-07-21T00:00:00.000Z");
    insert.run("agent-post", "result", "登录问题已修复", "刷新竞态已消除", "result:1", "agent", "2026-07-21T00:01:00.000Z");
    seed.database.prepare("DELETE FROM metadata WHERE key IN ('feed_v2_migration', 'interaction_v3_migration')").run();
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
    const tables = migrated.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const feedColumns = migrated.database.prepare("PRAGMA table_info(feed_posts)").all() as Array<{ name: string }>;
    const notificationColumns = migrated.database.prepare("PRAGMA table_info(notification_settings)").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).not.toContain("task_reviews");
    for (const name of ["action_required", "action_prompt", "actions_json", "pending_action_ids_json"]) {
      expect(feedColumns.map((row) => row.name)).not.toContain(name);
    }
    expect(notificationColumns.map((row) => row.name)).not.toContain("reviews");
    expect(migrated.getSession("session-a")?.title).toBe("Legacy task");
    migrated.close();
  });
});
