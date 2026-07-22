import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactText, redactUnknown } from "@zimlo/adapters";
import type {
  FeedCard,
  FeedPost,
  FeedPostKind,
  FeedTemplate,
  PendingAction,
  Session,
  SessionCapabilities,
  Snapshot,
  TaskCommand,
  TaskRecord,
  TrustedWorkspace,
  UnifiedEvent,
} from "@zimlo/protocol";
import { sanitizeEventPayload } from "./sanitization.js";

interface DeviceRow {
  id: string;
  name: string;
  key_base64: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  is_local_admin: number;
  can_approve: number;
}

export interface DeviceRecord {
  id: string;
  name: string;
  keyBase64: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  isLocalAdmin: boolean;
  canApprove: boolean;
}

export type FeedDecisionKind = "post" | "skip" | "implicit_skip";

interface StoredFeedContentV2 {
  template: FeedTemplate;
  headline: string;
  takeaway: string;
  highlights: string[];
  proof?: string;
  actionPrompt?: string;
}

function defaultTemplate(kind: string): FeedTemplate {
  const templates: Partial<Record<FeedPostKind, FeedTemplate>> = {
    progress: "grid",
    decision: "sticky",
    attention: "marker",
    result: "paper",
    failure: "marker",
  };
  return templates[kind as FeedPostKind] ?? "paper";
}

function normalizeTemplate(value: unknown, kind: string): FeedTemplate {
  return typeof value === "string" && ["paper", "grid", "sticky", "marker", "poster"].includes(value)
    ? value as FeedTemplate
    : defaultTemplate(kind);
}

function json<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class ZimloStore {
  readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
    this.migrate();
    if (existsSync(path)) chmodSync(path, 0o600);
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT,
        transcript_path TEXT,
        status TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        active_pid INTEGER,
        process_started_at TEXT,
        tty TEXT,
        correlation_uncertain INTEGER NOT NULL DEFAULT 0,
        capabilities_json TEXT NOT NULL,
        UNIQUE(provider, provider_session_id)
      );
      CREATE INDEX IF NOT EXISTS sessions_activity_idx ON sessions(last_activity_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        provider_session_id TEXT NOT NULL,
        turn_id TEXT,
        item_id TEXT,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        provenance TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS events_occurred_idx ON events(occurred_at);

      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL,
        action_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        provenance TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cards_feed_idx ON cards(priority DESC, updated_at DESC);

      CREATE TABLE IF NOT EXISTS feed_posts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        action_required INTEGER NOT NULL DEFAULT 0,
        actions_json TEXT NOT NULL,
        pending_action_ids_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        content_json TEXT,
        UNIQUE(agent_id, run_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS feed_posts_timeline_idx ON feed_posts(action_required DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        state TEXT NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_updated_idx ON tasks(updated_at DESC);

      CREATE TABLE IF NOT EXISTS task_commands (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        workspace_id TEXT,
        cwd TEXT NOT NULL,
        text TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS task_commands_state_idx ON task_commands(state, created_at);

      CREATE TABLE IF NOT EXISTS feed_seen (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
        seen_at TEXT NOT NULL,
        PRIMARY KEY(device_id, post_id)
      );

      CREATE TABLE IF NOT EXISTS feed_checkpoints (
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        task_id TEXT,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL,
        decision_kind TEXT,
        decision_at TEXT,
        decision_ref TEXT,
        PRIMARY KEY(agent_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS actions (
        action_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        upstream_request_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        decisions_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS actions_state_idx ON actions(state, expires_at);

      CREATE TABLE IF NOT EXISTS file_offsets (
        path TEXT PRIMARY KEY,
        offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        modified_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_base64 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT,
        is_local_admin INTEGER NOT NULL DEFAULT 0,
        can_approve INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const feedColumns = this.database.prepare("PRAGMA table_info(feed_posts)").all() as Array<{ name: string }>;
    if (!feedColumns.some((column) => column.name === "content_json")) {
      this.database.exec("ALTER TABLE feed_posts ADD COLUMN content_json TEXT");
    }
    const deviceColumns = this.database.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
    if (!deviceColumns.some((column) => column.name === "can_approve")) {
      this.database.exec("ALTER TABLE devices ADD COLUMN can_approve INTEGER NOT NULL DEFAULT 0");
    }
    this.migrateFeedV2();
    this.database.prepare("UPDATE task_commands SET state = 'queued', updated_at = ?, error = NULL WHERE state IN ('dispatching', 'running')")
      .run(new Date().toISOString());
    this.database.prepare("UPDATE actions SET state = 'expired' WHERE state IN ('pending', 'submitted')").run();
    this.clearInactiveActionLinks();
    this.scrubStoredContent();
  }

  private clearInactiveActionLinks(): void {
    const active = new Set((this.database.prepare(`
      SELECT action_id FROM actions
      WHERE state IN ('pending', 'submitted') AND expires_at > ?
    `).all(new Date().toISOString()) as Array<{ action_id: string }>).map((row) => row.action_id));
    const posts = this.database.prepare("SELECT id, pending_action_ids_json FROM feed_posts WHERE action_required = 1").all() as Array<{ id: string; pending_action_ids_json: string }>;
    const update = this.database.prepare("UPDATE feed_posts SET pending_action_ids_json = ?, action_required = ? WHERE id = ?");
    for (const post of posts) {
      let linked: string[] = [];
      try {
        linked = json<string[]>(post.pending_action_ids_json).filter((id) => active.has(id));
      } catch {
        // Invalid historical linkage is cleared rather than keeping a stale card pinned.
      }
      if (linked.length > 0) update.run(JSON.stringify(linked), 1, post.id);
      else update.run("[]", 0, post.id);
    }
  }

  private migrateFeedV2(): void {
    const migrationKey = "feed_v2_migration";
    const current = this.database.prepare("SELECT value FROM metadata WHERE key = ?").get(migrationKey) as { value: string } | undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // Run this sweep on every startup. An older Bridge may continue writing
      // V1 instruction posts after the original one-shot migration completed.
      const userPosts = this.database.prepare(`
        SELECT id, run_id, agent_id, session_id, body, created_at
        FROM feed_posts WHERE source = 'user' AND session_id IS NOT NULL
      `).all() as Array<Record<string, unknown>>;
      const insertInstruction = this.database.prepare(`
        INSERT OR IGNORE INTO events (
          id, provider, session_id, provider_session_id, kind, source,
          occurred_at, payload_json, provenance
        ) VALUES (?, ?, ?, ?, 'user_instruction', 'hook', ?, ?, 'verified')
      `);
      for (const post of userPosts) {
        insertInstruction.run(
          `feed-instruction:${String(post.id)}`,
          String(post.agent_id),
          String(post.session_id),
          String(post.run_id),
          String(post.created_at),
          JSON.stringify(sanitizeEventPayload({ prompt: String(post.body), migratedFromFeed: true })),
        );
      }
      this.database.prepare("DELETE FROM feed_posts WHERE source = 'user' AND session_id IS NOT NULL").run();

      if (Number(current?.value ?? 0) < 1) {
        const legacyPosts = this.database.prepare(`
          SELECT id, kind, title, body, action_required FROM feed_posts
          WHERE source = 'agent' AND content_json IS NULL
        `).all() as Array<Record<string, unknown>>;
        const updateContent = this.database.prepare("UPDATE feed_posts SET content_json = ? WHERE id = ?");
        for (const post of legacyPosts) {
          const content: StoredFeedContentV2 = {
            template: defaultTemplate(String(post.kind)),
            headline: String(post.title).slice(0, 72),
            takeaway: String(post.body).slice(0, 320),
            highlights: [],
            ...(Number(post.action_required) === 1 ? { actionPrompt: "需要你处理这项任务。" } : {}),
          };
          updateContent.run(JSON.stringify(content), String(post.id));
        }
      }
      this.database.prepare(`
        INSERT INTO metadata(key, value) VALUES (?, '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(migrationKey);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private scrubStoredContent(): void {
    const key = "content_scrub_version";
    const current = this.database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    if (Number(current?.value ?? 0) >= 3) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const events = this.database.prepare("SELECT sequence, payload_json FROM events").all() as Array<{ sequence: number; payload_json: string }>;
      const updateEvent = this.database.prepare("UPDATE events SET payload_json = ? WHERE sequence = ?");
      for (const event of events) {
        try {
          updateEvent.run(JSON.stringify(sanitizeEventPayload(JSON.parse(event.payload_json))), event.sequence);
        } catch {
          updateEvent.run(JSON.stringify({ redacted: true, reason: "invalid historical payload" }), event.sequence);
        }
      }

      const cards = this.database.prepare("SELECT id, summary FROM cards").all() as Array<{ id: string; summary: string }>;
      const updateCard = this.database.prepare("UPDATE cards SET summary = ? WHERE id = ?");
      for (const card of cards) updateCard.run(redactText(card.summary, 520), card.id);

      const posts = this.database.prepare("SELECT id, kind, content_json FROM feed_posts WHERE content_json IS NOT NULL").all() as Array<{ id: string; kind: string; content_json: string }>;
      const updatePost = this.database.prepare("UPDATE feed_posts SET content_json = ?, title = ?, body = ? WHERE id = ?");
      for (const post of posts) {
        try {
          const content = json<StoredFeedContentV2>(post.content_json);
          const sanitized: StoredFeedContentV2 = {
            template: normalizeTemplate(content.template, post.kind),
            headline: redactText(content.headline, 72),
            takeaway: redactText(content.takeaway, 320),
            highlights: (content.highlights ?? []).slice(0, 3).map((highlight) => redactText(highlight, 100)),
            ...(content.proof ? { proof: redactText(content.proof, 160) } : {}),
            ...(content.actionPrompt ? { actionPrompt: redactText(content.actionPrompt, 240) } : {}),
          };
          updatePost.run(JSON.stringify(sanitized), sanitized.headline, sanitized.takeaway, post.id);
        } catch {
          const fallback: StoredFeedContentV2 = { template: "paper", headline: "历史帖子", takeaway: "历史内容无法安全读取。", highlights: [] };
          updatePost.run(JSON.stringify(fallback), fallback.headline, fallback.takeaway, post.id);
        }
      }

      const actions = this.database.prepare("SELECT action_id, detail, decisions_json FROM actions").all() as Array<{ action_id: string; detail: string; decisions_json: string }>;
      const updateAction = this.database.prepare("UPDATE actions SET detail = ?, decisions_json = ? WHERE action_id = ?");
      for (const action of actions) {
        let decisions: unknown = [];
        try {
          decisions = redactUnknown(JSON.parse(action.decisions_json));
        } catch {
          // Invalid historical decisions cannot be replayed and are replaced safely.
        }
        updateAction.run(redactText(action.detail, 800), JSON.stringify(decisions), action.action_id);
      }

      const idempotency = this.database.prepare("SELECT key, result_json FROM idempotency").all() as Array<{ key: string; result_json: string }>;
      const updateIdempotency = this.database.prepare("UPDATE idempotency SET result_json = ? WHERE key = ?");
      for (const item of idempotency) {
        try {
          updateIdempotency.run(JSON.stringify(redactUnknown(JSON.parse(item.result_json))), item.key);
        } catch {
          updateIdempotency.run(JSON.stringify({ ok: false, message: "历史结果已安全移除。" }), item.key);
        }
      }

      this.database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)").run(key, "3");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  upsertSession(session: Session): Session {
    this.database.prepare(`
      INSERT INTO sessions (
        id, provider, provider_session_id, title, cwd, transcript_path, status,
        last_activity_at, created_at, active_pid, process_started_at, tty,
        correlation_uncertain, capabilities_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        cwd = COALESCE(excluded.cwd, sessions.cwd),
        transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
        status = excluded.status,
        last_activity_at = CASE WHEN excluded.last_activity_at > sessions.last_activity_at THEN excluded.last_activity_at ELSE sessions.last_activity_at END,
        active_pid = excluded.active_pid,
        process_started_at = excluded.process_started_at,
        tty = excluded.tty,
        correlation_uncertain = excluded.correlation_uncertain,
        capabilities_json = excluded.capabilities_json
    `).run(
      session.id,
      session.provider,
      session.providerSessionId,
      session.title,
      session.cwd,
      session.transcriptPath,
      session.status,
      session.lastActivityAt,
      session.createdAt,
      session.activePid,
      session.processStartedAt,
      session.tty,
      session.correlationUncertain ? 1 : 0,
      JSON.stringify(session.capabilities),
    );
    return this.getSession(session.id) ?? session;
  }

  getSession(id: string): Session | null {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.sessionFromRow(row) : null;
  }

  getSessionByProviderId(provider: string, providerSessionId: string): Session | null {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE provider = ? AND provider_session_id = ?")
      .get(provider, providerSessionId) as Record<string, unknown> | undefined;
    return row ? this.sessionFromRow(row) : null;
  }

  findSessionForAgentTool(provider: Session["provider"], parentPid: number, cwd: string, taskId: string): Session | null {
    const direct = this.getSessionByProviderId(provider, taskId);
    if (direct) return direct;
    if (parentPid > 0) {
      const row = this.database.prepare("SELECT * FROM sessions WHERE provider = ? AND active_pid = ? ORDER BY last_activity_at DESC LIMIT 1")
        .get(provider, parentPid) as Record<string, unknown> | undefined;
      if (row) {
        const session = this.sessionFromRow(row);
        if (!session.correlationUncertain) return session;
      }
    }
    if (!cwd) return null;
    const rows = this.database.prepare(`
      SELECT * FROM sessions
      WHERE provider = ? AND cwd = ? AND active_pid IS NOT NULL
      ORDER BY last_activity_at DESC LIMIT 2
    `).all(provider, cwd) as Record<string, unknown>[];
    if (rows.length !== 1) return null;
    const session = this.sessionFromRow(rows[0]!);
    return session.correlationUncertain ? null : session;
  }

  listSessions(): Session[] {
    return (this.database.prepare("SELECT * FROM sessions ORDER BY last_activity_at DESC").all() as Record<string, unknown>[])
      .map((row) => this.sessionFromRow(row));
  }

  firstTaskInput(sessionId: string): string | null {
    const row = this.database.prepare(`
      SELECT payload_json FROM events
      WHERE session_id = ? AND kind = 'user_instruction'
      ORDER BY sequence ASC LIMIT 1
    `).get(sessionId) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      const payload = json<unknown>(row.payload_json);
      if (typeof payload === "string") return payload;
      if (payload && typeof payload === "object") {
        const prompt = (payload as Record<string, unknown>).prompt;
        if (typeof prompt === "string") return prompt;
      }
    } catch {
      // Invalid historical payloads do not block the task list.
    }
    return null;
  }

  clearInactiveProcesses(activePids: Set<number>): { changed: Session[]; removed: string[] } {
    const changed: Session[] = [];
    const removed: string[] = [];
    for (const session of this.listSessions()) {
      if (session.activePid === null || activePids.has(session.activePid)) continue;
      if (session.providerSessionId.startsWith("process:")) {
        this.database.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
        removed.push(session.id);
        continue;
      }
      const capabilities = {
        ...session.capabilities,
        liveObserved: false,
        replyable: session.cwd !== null,
        resumable: session.cwd !== null,
      };
      changed.push(this.upsertSession({ ...session, activePid: null, processStartedAt: null, tty: null, status: "idle", capabilities }));
    }
    return { changed, removed };
  }

  insertEvent(event: UnifiedEvent): { event: UnifiedEvent; inserted: boolean } {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO events (
        id, provider, session_id, provider_session_id, turn_id, item_id, kind,
        source, occurred_at, payload_json, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.provider,
      event.sessionId,
      event.providerSessionId,
      event.turnId ?? null,
      event.itemId ?? null,
      event.kind,
      event.source,
      event.occurredAt,
      JSON.stringify(event.payload),
      event.provenance,
    );
    const row = this.database.prepare("SELECT sequence FROM events WHERE id = ?").get(event.id) as { sequence: number };
    return { event: { ...event, sequence: Number(row.sequence) }, inserted: result.changes > 0 };
  }

  listEvents(sessionId: string, limit = 200): UnifiedEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY sequence DESC LIMIT ?")
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map((row) => this.eventFromRow(row)).reverse();
  }

  latestSequence(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events").get() as { sequence: number };
    return Number(row.sequence);
  }

  upsertCard(card: FeedCard): FeedCard {
    this.database.prepare(`
      INSERT INTO cards (id, session_id, turn_id, kind, title, summary, priority, status, action_ids_json, updated_at, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        priority = excluded.priority,
        status = excluded.status,
        action_ids_json = excluded.action_ids_json,
        updated_at = excluded.updated_at,
        provenance = excluded.provenance
    `).run(
      card.id,
      card.sessionId,
      card.turnId,
      card.kind,
      card.title,
      card.summary,
      card.priority,
      card.status,
      JSON.stringify(card.actionIds),
      card.updatedAt,
      card.provenance,
    );
    return card;
  }

  insertFeedPost(post: FeedPost): { post: FeedPost; inserted: boolean } {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO feed_posts (
        id, task_id, run_id, agent_id, session_id, kind, title, body,
        action_required, actions_json, pending_action_ids_json, dedupe_key,
        source, created_at, content_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      post.id,
      post.taskId,
      post.runId,
      post.agentId,
      post.sessionId,
      post.kind,
      post.headline,
      post.takeaway,
      post.actionRequired ? 1 : 0,
      JSON.stringify(post.actions),
      JSON.stringify(post.pendingActionIds),
      post.dedupeKey,
      post.source,
      post.createdAt,
      JSON.stringify({
        template: post.template,
        headline: post.headline,
        takeaway: post.takeaway,
        highlights: post.highlights,
        ...(post.proof ? { proof: post.proof } : {}),
        ...(post.actionPrompt ? { actionPrompt: post.actionPrompt } : {}),
      } satisfies StoredFeedContentV2),
    );
    if (result.changes > 0) return { post, inserted: true };
    const existing = this.database.prepare(`
      SELECT * FROM feed_posts WHERE agent_id = ? AND run_id = ? AND dedupe_key = ?
    `).get(post.agentId, post.runId, post.dedupeKey) as Record<string, unknown> | undefined;
    if (!existing) throw new Error("Feed 帖子去重冲突，但无法读取原记录。");
    return { post: this.feedPostFromRow(existing), inserted: false };
  }

  listFeedPosts(): FeedPost[] {
    return (this.database.prepare(`
      SELECT * FROM feed_posts
      WHERE source = 'agent' AND kind <> 'instruction'
      ORDER BY action_required DESC, created_at DESC
      LIMIT 200
    `).all() as Record<string, unknown>[]).map((row) => this.feedPostFromRow(row));
  }

  latestFeedPost(agentId: string, runId: string, since: string): FeedPost | null {
    const row = this.database.prepare(`
      SELECT * FROM feed_posts
      WHERE agent_id = ? AND run_id = ? AND source = 'agent' AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(agentId, runId, since) as Record<string, unknown> | undefined;
    return row ? this.feedPostFromRow(row) : null;
  }

  linkPendingAction(sessionId: string, actionId: string): FeedPost | null {
    const row = this.database.prepare(`
      SELECT * FROM feed_posts
      WHERE session_id = ? AND action_required = 1 AND kind = 'attention' AND source = 'agent'
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const post = this.feedPostFromRow(row);
    if (post.pendingActionIds.includes(actionId)) return post;
    const next = [...post.pendingActionIds, actionId];
    this.database.prepare("UPDATE feed_posts SET pending_action_ids_json = ? WHERE id = ?")
      .run(JSON.stringify(next), post.id);
    return { ...post, pendingActionIds: next };
  }

  unlinkPendingAction(actionId: string): FeedPost[] {
    const rows = this.database.prepare(`
      SELECT * FROM feed_posts WHERE pending_action_ids_json LIKE ?
    `).all(`%${actionId}%`) as Record<string, unknown>[];
    const updated: FeedPost[] = [];
    for (const row of rows) {
      const post = this.feedPostFromRow(row);
      if (!post.pendingActionIds.includes(actionId)) continue;
      const pendingActionIds = post.pendingActionIds.filter((id) => id !== actionId);
      this.database.prepare(`
        UPDATE feed_posts SET pending_action_ids_json = ?, action_required = ? WHERE id = ?
      `).run(JSON.stringify(pendingActionIds), pendingActionIds.length > 0 ? 1 : 0, post.id);
      updated.push({ ...post, pendingActionIds, actionRequired: pendingActionIds.length > 0 });
    }
    return updated;
  }

  upsertTask(task: TaskRecord): TaskRecord {
    this.database.prepare(`
      INSERT INTO tasks (id, run_id, agent_id, session_id, state, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        run_id = excluded.run_id,
        agent_id = excluded.agent_id,
        session_id = excluded.session_id,
        state = excluded.state,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `).run(task.id, task.runId, task.agentId, task.sessionId, task.state, task.reason, task.updatedAt);
    return task;
  }

  listTasks(): TaskRecord[] {
    return (this.database.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all() as Record<string, unknown>[])
      .map((row) => this.taskFromRow(row));
  }

  insertTaskCommand(command: TaskCommand): { command: TaskCommand; inserted: boolean } {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO task_commands (
        id, idempotency_key, kind, provider, session_id, workspace_id, cwd,
        text, state, created_at, updated_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.id,
      command.idempotencyKey,
      command.kind,
      command.provider,
      command.sessionId,
      command.workspaceId,
      command.cwd,
      command.text,
      command.state,
      command.createdAt,
      command.updatedAt,
      command.error ?? null,
    );
    const stored = this.getTaskCommandByIdempotencyKey(command.idempotencyKey);
    if (!stored) throw new Error("任务指令未能持久化。");
    return { command: stored, inserted: result.changes > 0 };
  }

  updateTaskCommand(command: TaskCommand): TaskCommand {
    this.database.prepare(`
      UPDATE task_commands SET
        session_id = ?, workspace_id = ?, cwd = ?, text = ?, state = ?,
        updated_at = ?, error = ?
      WHERE id = ?
    `).run(
      command.sessionId,
      command.workspaceId,
      command.cwd,
      command.text,
      command.state,
      command.updatedAt,
      command.error ?? null,
      command.id,
    );
    return this.getTaskCommand(command.id) ?? command;
  }

  getTaskCommand(id: string): TaskCommand | null {
    const row = this.database.prepare("SELECT * FROM task_commands WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.taskCommandFromRow(row) : null;
  }

  getTaskCommandByIdempotencyKey(key: string): TaskCommand | null {
    const row = this.database.prepare("SELECT * FROM task_commands WHERE idempotency_key = ?").get(key) as Record<string, unknown> | undefined;
    return row ? this.taskCommandFromRow(row) : null;
  }

  listTaskCommands(): TaskCommand[] {
    return (this.database.prepare("SELECT * FROM task_commands ORDER BY created_at DESC LIMIT 200").all() as Record<string, unknown>[])
      .map((row) => this.taskCommandFromRow(row));
  }

  listQueuedTaskCommands(): TaskCommand[] {
    return (this.database.prepare("SELECT * FROM task_commands WHERE state = 'queued' ORDER BY created_at ASC").all() as Record<string, unknown>[])
      .map((row) => this.taskCommandFromRow(row));
  }

  markFeedSeen(deviceId: string, postId: string): boolean {
    return this.database.prepare(`
      INSERT OR IGNORE INTO feed_seen(device_id, post_id, seen_at) VALUES (?, ?, ?)
    `).run(deviceId, postId, new Date().toISOString()).changes > 0;
  }

  listSeenPostIds(deviceId: string): string[] {
    if (!deviceId) return [];
    return (this.database.prepare("SELECT post_id FROM feed_seen WHERE device_id = ?").all(deviceId) as Array<{ post_id: string }>)
      .map((row) => row.post_id);
  }

  lanApprovalsEnabled(): boolean {
    const row = this.database.prepare("SELECT value FROM metadata WHERE key = 'lan_approvals_enabled'").get() as { value: string } | undefined;
    return row?.value === "1";
  }

  setLanApprovalsEnabled(enabled: boolean): void {
    this.database.prepare(`
      INSERT INTO metadata(key, value) VALUES ('lan_approvals_enabled', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(enabled ? "1" : "0");
  }

  beginFeedCheckpoint(input: { agentId: string; runId: string; taskId?: string; sessionId: string | null; startedAt: string }): void {
    this.database.prepare(`
      INSERT INTO feed_checkpoints (agent_id, run_id, task_id, session_id, started_at, decision_kind, decision_at, decision_ref)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(agent_id, run_id) DO UPDATE SET
        task_id = COALESCE(excluded.task_id, feed_checkpoints.task_id),
        session_id = COALESCE(excluded.session_id, feed_checkpoints.session_id),
        started_at = excluded.started_at,
        decision_kind = NULL,
        decision_at = NULL,
        decision_ref = NULL
    `).run(input.agentId, input.runId, input.taskId ?? null, input.sessionId, input.startedAt);
  }

  recordFeedDecision(input: { agentId: string; runId: string; taskId: string; kind: FeedDecisionKind; at: string; ref: string }): void {
    this.database.prepare(`
      INSERT INTO feed_checkpoints (agent_id, run_id, task_id, session_id, started_at, decision_kind, decision_at, decision_ref)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(agent_id, run_id) DO UPDATE SET
        task_id = excluded.task_id,
        decision_kind = excluded.decision_kind,
        decision_at = excluded.decision_at,
        decision_ref = excluded.decision_ref
    `).run(input.agentId, input.runId, input.taskId, input.at, input.kind, input.at, input.ref);
  }

  getFeedCheckpoint(agentId: string, runId: string): {
    taskId: string | null;
    startedAt: string;
    decisionKind: FeedDecisionKind | null;
    decisionAt: string | null;
    decisionRef: string | null;
  } | null {
    const row = this.database.prepare(`
      SELECT task_id, started_at, decision_kind, decision_at, decision_ref
      FROM feed_checkpoints WHERE agent_id = ? AND run_id = ?
    `).get(agentId, runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      taskId: row.task_id === null ? null : String(row.task_id),
      startedAt: String(row.started_at),
      decisionKind: row.decision_kind === null ? null : row.decision_kind as FeedDecisionKind,
      decisionAt: row.decision_at === null ? null : String(row.decision_at),
      decisionRef: row.decision_ref === null ? null : String(row.decision_ref),
    };
  }

  finalizeOpenFeedCheckpoints(at: string, ref: string): number {
    const result = this.database.prepare(`
      UPDATE feed_checkpoints
      SET decision_kind = 'implicit_skip', decision_at = ?, decision_ref = ?
      WHERE decision_kind IS NULL
    `).run(at, ref);
    return Number(result.changes);
  }

  listCards(): FeedCard[] {
    return (this.database.prepare(`
      WITH ranked AS (
        SELECT cards.*, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY updated_at DESC) AS session_rank
        FROM cards
      )
      SELECT * FROM ranked
      WHERE session_rank <= 3 OR (kind = 'attention' AND status = 'active')
      ORDER BY priority DESC, updated_at DESC
      LIMIT 200
    `).all() as Record<string, unknown>[])
      .map((row) => this.cardFromRow(row));
  }

  resolveActionCards(actionId: string): FeedCard[] {
    const changed: FeedCard[] = [];
    for (const card of this.listCards()) {
      if (!card.actionIds.includes(actionId)) continue;
      const actionIds = card.actionIds.filter((id) => id !== actionId);
      changed.push(this.upsertCard({ ...card, actionIds, status: actionIds.length === 0 ? "resolved" : card.status, updatedAt: new Date().toISOString() }));
    }
    return changed;
  }

  upsertAction(action: PendingAction): PendingAction {
    this.database.prepare(`
      INSERT INTO actions (action_id, session_id, upstream_request_id, kind, title, detail, decisions_json, expires_at, state, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(action_id) DO UPDATE SET
        decisions_json = excluded.decisions_json,
        expires_at = excluded.expires_at,
        state = excluded.state,
        resolved_at = excluded.resolved_at
    `).run(
      action.actionId,
      action.sessionId,
      action.upstreamRequestId ?? null,
      action.kind,
      action.title,
      action.detail,
      JSON.stringify(action.availableDecisions),
      action.expiresAt,
      action.state,
      action.createdAt,
      action.resolvedAt ?? null,
    );
    return action;
  }

  getAction(actionId: string): PendingAction | null {
    const row = this.database.prepare("SELECT * FROM actions WHERE action_id = ?").get(actionId) as Record<string, unknown> | undefined;
    return row ? this.actionFromRow(row) : null;
  }

  listPendingActions(): PendingAction[] {
    return (this.database
      .prepare("SELECT * FROM actions WHERE state IN ('pending', 'submitted') AND expires_at > ? ORDER BY created_at DESC")
      .all(new Date().toISOString()) as Record<string, unknown>[]).map((row) => this.actionFromRow(row));
  }

  listActions(): PendingAction[] {
    return (this.database
      .prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT 200")
      .all() as Record<string, unknown>[]).map((row) => this.actionFromRow(row));
  }

  getOffset(path: string): number | null {
    const row = this.database.prepare("SELECT offset FROM file_offsets WHERE path = ?").get(path) as { offset: number } | undefined;
    return row ? Number(row.offset) : null;
  }

  setOffset(path: string, offset: number, size: number, modifiedAt: string): void {
    this.database.prepare(`
      INSERT INTO file_offsets(path, offset, size, modified_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size, modified_at = excluded.modified_at
    `).run(path, offset, size, modifiedAt);
  }

  saveIdempotentResult(key: string, actionId: string, result: unknown): void {
    this.database.prepare("INSERT OR IGNORE INTO idempotency(key, action_id, result_json, created_at) VALUES (?, ?, ?, ?)")
      .run(key, actionId, JSON.stringify(result), new Date().toISOString());
  }

  getIdempotentResult(key: string): unknown | null {
    const row = this.database.prepare("SELECT result_json FROM idempotency WHERE key = ?").get(key) as { result_json: string } | undefined;
    return row ? json(row.result_json) : null;
  }

  upsertDevice(device: DeviceRecord): DeviceRecord {
    this.database.prepare(`
      INSERT INTO devices(id, name, key_base64, created_at, last_seen_at, revoked_at, is_local_admin, can_approve)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, key_base64 = excluded.key_base64,
        last_seen_at = excluded.last_seen_at, revoked_at = excluded.revoked_at, is_local_admin = excluded.is_local_admin,
        can_approve = excluded.can_approve
    `).run(
      device.id,
      device.name,
      device.keyBase64,
      device.createdAt,
      device.lastSeenAt,
      device.revokedAt,
      device.isLocalAdmin ? 1 : 0,
      device.canApprove ? 1 : 0,
    );
    return device;
  }

  getDevice(id: string): DeviceRecord | null {
    const row = this.database.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
    return row ? this.deviceFromRow(row) : null;
  }

  listDevices(): DeviceRecord[] {
    return (this.database.prepare("SELECT * FROM devices ORDER BY created_at DESC").all() as unknown as DeviceRow[])
      .map((row) => this.deviceFromRow(row));
  }

  revokeDevice(id: string): boolean {
    return this.database.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id).changes > 0;
  }

  setDeviceApproval(id: string, enabled: boolean): DeviceRecord | null {
    this.database.prepare("UPDATE devices SET can_approve = ? WHERE id = ? AND revoked_at IS NULL AND is_local_admin = 0")
      .run(enabled ? 1 : 0, id);
    return this.getDevice(id);
  }

  snapshot(_lanApprovalsEnabled: boolean, deviceId: string, workspaces: TrustedWorkspace[]): Snapshot {
    const device = deviceId ? this.getDevice(deviceId) : null;
    return {
      sessions: this.listSessions(),
      cards: [],
      posts: this.listFeedPosts(),
      tasks: this.listTasks(),
      commands: this.listTaskCommands(),
      workspaces,
      seenPostIds: this.listSeenPostIds(deviceId),
      actions: this.listActions(),
      sequence: this.latestSequence(),
      lanApprovalsEnabled: device?.isLocalAdmin === true || device?.canApprove === true,
    };
  }

  prune(retentionDays = 7): void {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    this.database.prepare("DELETE FROM events WHERE occurred_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM cards WHERE updated_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM feed_posts WHERE created_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM tasks WHERE updated_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM task_commands WHERE updated_at < ? AND state IN ('completed', 'failed', 'canceled')").run(cutoff);
    this.database.prepare("DELETE FROM feed_checkpoints WHERE started_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM actions WHERE created_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM idempotency WHERE created_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM sessions WHERE last_activity_at < ? AND active_pid IS NULL").run(cutoff);
  }

  private sessionFromRow(row: Record<string, unknown>): Session {
    return {
      id: String(row.id),
      provider: row.provider as Session["provider"],
      providerSessionId: String(row.provider_session_id),
      title: String(row.title),
      cwd: row.cwd === null ? null : String(row.cwd),
      transcriptPath: row.transcript_path === null ? null : String(row.transcript_path),
      status: row.status as Session["status"],
      lastActivityAt: String(row.last_activity_at),
      createdAt: String(row.created_at),
      activePid: row.active_pid === null ? null : Number(row.active_pid),
      processStartedAt: row.process_started_at === null ? null : String(row.process_started_at),
      tty: row.tty === null ? null : String(row.tty),
      correlationUncertain: Number(row.correlation_uncertain) === 1,
      capabilities: json<SessionCapabilities>(String(row.capabilities_json)),
    };
  }

  private eventFromRow(row: Record<string, unknown>): UnifiedEvent {
    return {
      id: String(row.id),
      sequence: Number(row.sequence),
      provider: row.provider as UnifiedEvent["provider"],
      sessionId: String(row.session_id),
      providerSessionId: String(row.provider_session_id),
      ...(row.turn_id === null ? {} : { turnId: String(row.turn_id) }),
      ...(row.item_id === null ? {} : { itemId: String(row.item_id) }),
      kind: row.kind as UnifiedEvent["kind"],
      source: row.source as UnifiedEvent["source"],
      occurredAt: String(row.occurred_at),
      payload: json(String(row.payload_json)),
      provenance: row.provenance as UnifiedEvent["provenance"],
    };
  }

  private cardFromRow(row: Record<string, unknown>): FeedCard {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      kind: row.kind as FeedCard["kind"],
      title: String(row.title),
      summary: String(row.summary),
      priority: Number(row.priority),
      status: row.status as FeedCard["status"],
      actionIds: json<string[]>(String(row.action_ids_json)),
      updatedAt: String(row.updated_at),
      provenance: row.provenance as FeedCard["provenance"],
    };
  }

  private feedPostFromRow(row: Record<string, unknown>): FeedPost {
    let content: StoredFeedContentV2;
    try {
      content = row.content_json
        ? json<StoredFeedContentV2>(String(row.content_json))
        : {
            template: defaultTemplate(String(row.kind)),
            headline: String(row.title).slice(0, 72),
            takeaway: String(row.body).slice(0, 320),
            highlights: [],
          };
    } catch {
      content = {
        template: defaultTemplate(String(row.kind)),
        headline: String(row.title).slice(0, 72),
        takeaway: String(row.body).slice(0, 320),
        highlights: [],
      };
    }
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      runId: String(row.run_id),
      agentId: String(row.agent_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      kind: row.kind as FeedPost["kind"],
      template: normalizeTemplate(content.template, String(row.kind)),
      headline: content.headline,
      takeaway: content.takeaway,
      highlights: content.highlights,
      ...(content.proof ? { proof: content.proof } : {}),
      actionRequired: Number(row.action_required) === 1,
      ...(Number(row.action_required) === 1 && content.actionPrompt ? { actionPrompt: content.actionPrompt } : {}),
      actions: json<FeedPost["actions"]>(String(row.actions_json)),
      pendingActionIds: json<string[]>(String(row.pending_action_ids_json)),
      dedupeKey: String(row.dedupe_key),
      source: "agent",
      createdAt: String(row.created_at),
    };
  }

  private taskFromRow(row: Record<string, unknown>): TaskRecord {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      agentId: String(row.agent_id),
      sessionId: row.session_id === null ? null : String(row.session_id),
      state: row.state as TaskRecord["state"],
      reason: String(row.reason),
      updatedAt: String(row.updated_at),
    };
  }

  private taskCommandFromRow(row: Record<string, unknown>): TaskCommand {
    return {
      id: String(row.id),
      idempotencyKey: String(row.idempotency_key),
      kind: row.kind as TaskCommand["kind"],
      provider: row.provider as TaskCommand["provider"],
      sessionId: row.session_id === null ? null : String(row.session_id),
      workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
      cwd: String(row.cwd),
      text: String(row.text),
      state: row.state as TaskCommand["state"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      ...(row.error === null ? {} : { error: String(row.error) }),
    };
  }

  private actionFromRow(row: Record<string, unknown>): PendingAction {
    return {
      actionId: String(row.action_id),
      sessionId: String(row.session_id),
      ...(row.upstream_request_id === null ? {} : { upstreamRequestId: String(row.upstream_request_id) }),
      kind: row.kind as PendingAction["kind"],
      title: String(row.title),
      detail: String(row.detail),
      availableDecisions: json(String(row.decisions_json)),
      expiresAt: String(row.expires_at),
      state: row.state as PendingAction["state"],
      createdAt: String(row.created_at),
      ...(row.resolved_at === null ? {} : { resolvedAt: String(row.resolved_at) }),
    };
  }

  private deviceFromRow(row: DeviceRow): DeviceRecord {
    return {
      id: row.id,
      name: row.name,
      keyBase64: row.key_base64,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      isLocalAdmin: row.is_local_admin === 1,
      canApprove: row.can_approve === 1,
    };
  }
}
