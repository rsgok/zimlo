import { randomInt, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactText, redactUnknown } from "@zimlo/adapters";
import { FEATURE_CAPABILITIES, USER_AVATAR_IDS } from "@zimlo/protocol";
import type {
  ApprovalCategory,
  FeedCard,
  FeedPost,
  FeedPostKind,
  FeedTemplate,
  NotificationSettings,
  PendingAction,
  Project,
  ProjectTrustPolicy,
  PushDeviceRegistration,
  ReviewBundle,
  Session,
  SessionCapabilities,
  Snapshot,
  TaskCommand,
  TaskPreference,
  TaskRecord,
  TaskReview,
  TrustedWorkspace,
  TrustAuditEntry,
  UnifiedEvent,
  UserAvatarId,
  UserProfile,
} from "@zimlo/protocol";
import { ephemeralWorkspaceKind, persistableProjectForCwd, projectContextForCwd } from "./project-context.js";
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
  can_manage_trust: number;
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
  canManageTrust: boolean;
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

  getMetadata(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMetadata(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  deleteMetadata(key: string): void {
    this.database.prepare("DELETE FROM metadata WHERE key = ?").run(key);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_last_used_idx ON projects(last_used_at DESC);

      CREATE TABLE IF NOT EXISTS project_locations (
        path TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_locations_project_idx ON project_locations(project_id, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        surface TEXT NOT NULL DEFAULT 'unknown',
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
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
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

      CREATE TABLE IF NOT EXISTS feed_dismissed (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        dismissed_at TEXT NOT NULL,
        PRIMARY KEY(device_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS task_timeline_cursors (
        device_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY(device_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS task_preferences (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        pinned_at TEXT,
        archived_at TEXT
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
        can_approve INTEGER NOT NULL DEFAULT 0,
        can_manage_trust INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS task_reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        post_id TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        state TEXT NOT NULL,
        bundle_json TEXT NOT NULL,
        decision_note TEXT,
        decided_by_device_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        legacy INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, version)
      );
      CREATE INDEX IF NOT EXISTS task_reviews_attention_idx ON task_reviews(state, updated_at DESC);

      CREATE TABLE IF NOT EXISTS project_trust_policies (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        preset TEXT NOT NULL,
        auto_allow_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by_device_id TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trust_audit (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        category TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        action_summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trust_audit_created_idx ON trust_audit(created_at DESC);

      CREATE TABLE IF NOT EXISTS notification_settings (
        device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        approvals INTEGER NOT NULL DEFAULT 1,
        failures INTEGER NOT NULL DEFAULT 1,
        reviews INTEGER NOT NULL DEFAULT 1,
        show_task_title INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_devices (
        device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        public_key TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        avatar_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
    if (!feedColumns.some((column) => column.name === "project_id")) {
      this.database.exec("ALTER TABLE feed_posts ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL");
    }
    const projectColumns = this.database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === "identity_key")) this.database.exec("ALTER TABLE projects ADD COLUMN identity_key TEXT");
    if (!projectColumns.some((column) => column.name === "agent_display_name")) this.database.exec("ALTER TABLE projects ADD COLUMN agent_display_name TEXT");
    if (!projectColumns.some((column) => column.name === "agent_avatar")) this.database.exec("ALTER TABLE projects ADD COLUMN agent_avatar TEXT");
    if (!projectColumns.some((column) => column.name === "agent_bio")) this.database.exec("ALTER TABLE projects ADD COLUMN agent_bio TEXT");
    if (!projectColumns.some((column) => column.name === "agent_default_provider")) this.database.exec("ALTER TABLE projects ADD COLUMN agent_default_provider TEXT");
    if (!projectColumns.some((column) => column.name === "agent_updated_at")) this.database.exec("ALTER TABLE projects ADD COLUMN agent_updated_at TEXT");
    this.database.exec("CREATE INDEX IF NOT EXISTS projects_identity_idx ON projects(identity_key)");
    const sessionColumns = this.database.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "project_id")) {
      this.database.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL");
    }
    if (!sessionColumns.some((column) => column.name === "surface")) {
      this.database.exec("ALTER TABLE sessions ADD COLUMN surface TEXT NOT NULL DEFAULT 'unknown'");
    }
    const deviceColumns = this.database.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
    if (!deviceColumns.some((column) => column.name === "can_approve")) {
      this.database.exec("ALTER TABLE devices ADD COLUMN can_approve INTEGER NOT NULL DEFAULT 0");
    }
    if (!deviceColumns.some((column) => column.name === "can_manage_trust")) {
      this.database.exec("ALTER TABLE devices ADD COLUMN can_manage_trust INTEGER NOT NULL DEFAULT 0");
    }
    const actionColumns = this.database.prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>;
    if (!actionColumns.some((column) => column.name === "approval_context_json")) {
      this.database.exec("ALTER TABLE actions ADD COLUMN approval_context_json TEXT");
    }
    this.database.prepare("INSERT OR IGNORE INTO user_profile(id, avatar_id, updated_at) VALUES (1, ?, ?)")
      .run(USER_AVATAR_IDS[randomInt(USER_AVATAR_IDS.length)] ?? USER_AVATAR_IDS[0], new Date().toISOString());
    const projectBackfill = this.database.prepare("SELECT value FROM metadata WHERE key = 'project_backfill_v1'").get() as { value: string } | undefined;
    if (projectBackfill?.value !== "1") {
      this.backfillProjects();
      this.database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('project_backfill_v1', '1')").run();
    }
    this.cleanupEphemeralProjects();
    this.backfillAgentAvatars();
    this.migrateFeedV2();
    this.database.prepare("UPDATE task_commands SET state = 'queued', updated_at = ?, error = NULL WHERE state IN ('dispatching', 'running')")
      .run(new Date().toISOString());
    this.database.prepare("UPDATE actions SET state = 'expired' WHERE state IN ('pending', 'submitted')").run();
    this.clearInactiveActionLinks();
    this.scrubStoredContent();
  }

  ensureProjectForCwd(cwd: string | null, seenAt: string, createdAt = seenAt): Project | null {
    if (ephemeralWorkspaceKind(cwd)) {
      const context = projectContextForCwd(cwd);
      if (!context) return null;
      const matched = this.database.prepare("SELECT id FROM projects WHERE identity_key = ?").get(context.identityKey) as { id: string } | undefined;
      if (!matched) return null;
      this.database.prepare(`
        UPDATE projects SET last_used_at = CASE WHEN ? > last_used_at THEN ? ELSE last_used_at END
        WHERE id = ?
      `).run(seenAt, seenAt, matched.id);
      return this.getProject(matched.id);
    }
    const identity = persistableProjectForCwd(cwd);
    if (!identity) return null;
    const location = this.database.prepare("SELECT project_id FROM project_locations WHERE path = ?").get(identity.root) as { project_id: string } | undefined;
    const matched = this.database.prepare("SELECT id FROM projects WHERE identity_key = ?").get(identity.identityKey) as { id: string } | undefined;
    const projectId = location?.project_id ?? matched?.id ?? `project:${randomUUID()}`;
    const avatar = USER_AVATAR_IDS[randomInt(USER_AVATAR_IDS.length)] ?? USER_AVATAR_IDS[0];
    this.database.prepare(`
      INSERT INTO projects(id, name, identity_key, agent_avatar, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        identity_key = COALESCE(projects.identity_key, excluded.identity_key),
        created_at = CASE WHEN excluded.created_at < projects.created_at THEN excluded.created_at ELSE projects.created_at END,
        last_used_at = CASE WHEN excluded.last_used_at > projects.last_used_at THEN excluded.last_used_at ELSE projects.last_used_at END
    `).run(projectId, identity.name, identity.identityKey, avatar, createdAt, seenAt);
    this.database.prepare(`
      INSERT INTO project_locations(path, project_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        project_id = excluded.project_id,
        first_seen_at = CASE WHEN excluded.first_seen_at < project_locations.first_seen_at THEN excluded.first_seen_at ELSE project_locations.first_seen_at END,
        last_seen_at = CASE WHEN excluded.last_seen_at > project_locations.last_seen_at THEN excluded.last_seen_at ELSE project_locations.last_seen_at END
    `).run(identity.root, projectId, createdAt, seenAt);
    return this.getProject(projectId);
  }

  getProject(id: string): Project | null {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.projectFromRow(row) : null;
  }

  listProjects(): Project[] {
    return (this.database.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE, id").all() as Record<string, unknown>[])
      .map((row) => this.projectFromRow(row));
  }

  updateAgentProfile(projectId: string, profile: {
    displayName: string;
    avatar: string;
    bio: string;
    defaultProvider: Project["agentProfile"]["defaultProvider"];
  }): Project | null {
    const updatedAt = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE projects SET agent_display_name = ?, agent_avatar = ?, agent_bio = ?, agent_default_provider = ?, agent_updated_at = ?
      WHERE id = ?
    `).run(profile.displayName.trim(), profile.avatar.trim(), profile.bio.trim(), profile.defaultProvider, updatedAt, projectId);
    return Number(result.changes) > 0 ? this.getProject(projectId) : null;
  }

  private backfillProjects(): void {
    const sessions = this.database.prepare(`
      SELECT id, cwd, created_at, last_activity_at
      FROM sessions
      WHERE cwd IS NOT NULL AND project_id IS NULL
    `).all() as Array<{
      id: string;
      cwd: string;
      created_at: string;
      last_activity_at: string;
    }>;
    const updateSession = this.database.prepare("UPDATE sessions SET project_id = ? WHERE id = ?");
    for (const session of sessions) {
      const project = this.ensureProjectForCwd(session.cwd, session.last_activity_at, session.created_at);
      if (project) updateSession.run(project.id, session.id);
    }
    this.database.prepare(`
      UPDATE feed_posts SET project_id = (
        SELECT sessions.project_id FROM sessions WHERE sessions.id = feed_posts.session_id
      )
      WHERE project_id IS NULL AND session_id IS NOT NULL
    `).run();
    this.database.prepare(`
      UPDATE task_commands SET workspace_id = (
        SELECT project_locations.project_id FROM project_locations WHERE project_locations.path = task_commands.cwd
      )
      WHERE cwd <> '' AND EXISTS (SELECT 1 FROM project_locations WHERE project_locations.path = task_commands.cwd)
    `).run();
  }

  private backfillAgentAvatars(): void {
    const projects = this.database.prepare("SELECT id FROM projects WHERE agent_avatar IS NULL OR trim(agent_avatar) = ''")
      .all() as Array<{ id: string }>;
    const update = this.database.prepare("UPDATE projects SET agent_avatar = ? WHERE id = ?");
    for (const project of projects) {
      update.run(USER_AVATAR_IDS[randomInt(USER_AVATAR_IDS.length)] ?? USER_AVATAR_IDS[0], project.id);
    }
  }

  private cleanupEphemeralProjects(): void {
    const locations = this.database.prepare("SELECT path FROM project_locations").all() as Array<{ path: string }>;
    const ephemeralPaths = locations
      .map((location) => location.path)
      .filter((path) => ephemeralWorkspaceKind(path) !== null);
    if (ephemeralPaths.length === 0) return;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removeLocation = this.database.prepare("DELETE FROM project_locations WHERE path = ?");
      for (const path of ephemeralPaths) removeLocation.run(path);

      const orphaned = this.database.prepare(`
        SELECT projects.id FROM projects
        WHERE NOT EXISTS (
          SELECT 1 FROM project_locations WHERE project_locations.project_id = projects.id
        )
      `).all() as Array<{ id: string }>;
      const clearCommand = this.database.prepare("UPDATE task_commands SET workspace_id = NULL WHERE workspace_id = ?");
      const removeProject = this.database.prepare("DELETE FROM projects WHERE id = ?");
      for (const project of orphaned) {
        clearCommand.run(project.id);
        removeProject.run(project.id);
      }

      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
    const inferredProject = this.ensureProjectForCwd(session.cwd, session.lastActivityAt, session.createdAt);
    const projectId = ephemeralWorkspaceKind(session.cwd)
      ? inferredProject?.id ?? null
      : session.projectId ?? inferredProject?.id ?? null;
    this.database.prepare(`
      INSERT INTO sessions (
        id, project_id, provider, surface, provider_session_id, title, cwd, transcript_path, status,
        last_activity_at, created_at, active_pid, process_started_at, tty,
        correlation_uncertain, capabilities_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = CASE
          WHEN excluded.cwd IS NOT NULL THEN excluded.project_id
          ELSE COALESCE(excluded.project_id, sessions.project_id)
        END,
        surface = CASE WHEN excluded.surface = 'unknown' THEN sessions.surface ELSE excluded.surface END,
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
      projectId,
      session.provider,
      session.surface ?? "unknown",
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
    if (projectId) {
      this.database.prepare("UPDATE feed_posts SET project_id = ? WHERE session_id = ? AND project_id IS NULL")
        .run(projectId, session.id);
    }
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
    const checkpointMatch = this.database.prepare(`
      SELECT sessions.* FROM feed_checkpoints
      JOIN sessions ON sessions.id = feed_checkpoints.session_id
      WHERE feed_checkpoints.agent_id = ? AND feed_checkpoints.task_id = ?
      ORDER BY feed_checkpoints.started_at DESC LIMIT 1
    `).get(provider, taskId) as Record<string, unknown> | undefined;
    if (checkpointMatch) {
      const session = this.sessionFromRow(checkpointMatch);
      if (!session.correlationUncertain) return session;
    }
    if (parentPid > 0) {
      const row = this.database.prepare("SELECT * FROM sessions WHERE provider = ? AND active_pid = ? ORDER BY last_activity_at DESC LIMIT 1")
        .get(provider, parentPid) as Record<string, unknown> | undefined;
      if (row) {
        const session = this.sessionFromRow(row);
        if (!session.correlationUncertain) return session;
      }
    }
    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1_000).toISOString();
    const openCheckpoints = this.database.prepare(`
      SELECT sessions.* FROM feed_checkpoints
      JOIN sessions ON sessions.id = feed_checkpoints.session_id
      WHERE feed_checkpoints.agent_id = ? AND feed_checkpoints.decision_kind IS NULL
        AND feed_checkpoints.started_at >= ?
      ORDER BY feed_checkpoints.started_at DESC LIMIT 2
    `).all(provider, cutoff) as Record<string, unknown>[];
    if (openCheckpoints.length === 1) {
      const session = this.sessionFromRow(openCheckpoints[0]!);
      if (!session.correlationUncertain) return session;
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
    const projectId = post.projectId ?? (post.sessionId ? this.getSession(post.sessionId)?.projectId ?? null : null);
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO feed_posts (
        id, project_id, task_id, run_id, agent_id, session_id, kind, title, body,
        action_required, actions_json, pending_action_ids_json, dedupe_key,
        source, created_at, content_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      post.id,
      projectId,
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
    if (result.changes > 0) {
      if (projectId) {
        this.database.prepare(`
          UPDATE projects SET last_used_at = CASE WHEN ? > last_used_at THEN ? ELSE last_used_at END WHERE id = ?
        `).run(post.createdAt, post.createdAt, projectId);
      }
      return { post: { ...post, projectId }, inserted: true };
    }
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

  latestResultFeedPost(sessionId: string): FeedPost | null {
    const row = this.database.prepare(`
      SELECT * FROM feed_posts
      WHERE session_id = ? AND source = 'agent' AND kind = 'result'
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId) as Record<string, unknown> | undefined;
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

  dismissFeedItem(deviceId: string, itemId: string): boolean {
    return this.database.prepare(`
      INSERT OR IGNORE INTO feed_dismissed(device_id, item_id, dismissed_at) VALUES (?, ?, ?)
    `).run(deviceId, itemId, new Date().toISOString()).changes > 0;
  }

  setFeedItemDismissed(deviceId: string, itemId: string, dismissed: boolean): void {
    if (dismissed) {
      this.database.prepare(`
        INSERT OR IGNORE INTO feed_dismissed(device_id, item_id, dismissed_at) VALUES (?, ?, ?)
      `).run(deviceId, itemId, new Date().toISOString());
    } else {
      this.database.prepare("DELETE FROM feed_dismissed WHERE device_id = ? AND item_id = ?").run(deviceId, itemId);
    }
  }

  listDismissedFeedItemIds(deviceId: string): string[] {
    if (!deviceId) return [];
    return (this.database.prepare("SELECT item_id FROM feed_dismissed WHERE device_id = ?").all(deviceId) as Array<{ item_id: string }>)
      .map((row) => row.item_id);
  }

  markTaskTimelineSeen(deviceId: string, sessionId: string, itemId: string): void {
    this.database.prepare(`
      INSERT INTO task_timeline_cursors(device_id, session_id, item_id, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, session_id) DO UPDATE SET item_id = excluded.item_id, seen_at = excluded.seen_at
    `).run(deviceId, sessionId, itemId, new Date().toISOString());
  }

  listTaskTimelineCursors(deviceId: string): Record<string, string> {
    return Object.fromEntries((this.database.prepare("SELECT session_id, item_id FROM task_timeline_cursors WHERE device_id = ?").all(deviceId) as Array<{ session_id: string; item_id: string }>)
      .map((row) => [row.session_id, row.item_id]));
  }

  setTaskPinned(sessionId: string, pinned: boolean): TaskPreference {
    const pinnedAt = pinned ? new Date().toISOString() : null;
    this.database.prepare(`
      INSERT INTO task_preferences(session_id, pinned_at, archived_at) VALUES (?, ?, NULL)
      ON CONFLICT(session_id) DO UPDATE SET pinned_at = excluded.pinned_at
    `).run(sessionId, pinnedAt);
    return this.getTaskPreference(sessionId);
  }

  setTaskArchived(sessionId: string, archived: boolean): TaskPreference {
    const archivedAt = archived ? new Date().toISOString() : null;
    this.database.prepare(`
      INSERT INTO task_preferences(session_id, pinned_at, archived_at) VALUES (?, NULL, ?)
      ON CONFLICT(session_id) DO UPDATE SET archived_at = excluded.archived_at
    `).run(sessionId, archivedAt);
    return this.getTaskPreference(sessionId);
  }

  getTaskPreference(sessionId: string): TaskPreference {
    const row = this.database.prepare("SELECT session_id, pinned_at, archived_at FROM task_preferences WHERE session_id = ?").get(sessionId) as { session_id: string; pinned_at: string | null; archived_at: string | null } | undefined;
    return { sessionId, pinnedAt: row?.pinned_at ?? null, archivedAt: row?.archived_at ?? null };
  }

  listTaskPreferences(): TaskPreference[] {
    return (this.database.prepare("SELECT session_id, pinned_at, archived_at FROM task_preferences").all() as Array<{ session_id: string; pinned_at: string | null; archived_at: string | null }>)
      .map((row) => ({ sessionId: row.session_id, pinnedAt: row.pinned_at, archivedAt: row.archived_at }));
  }

  createTaskReview(input: {
    taskId: string;
    sessionId: string;
    postId: string;
    bundle: ReviewBundle;
    createdAt: string;
    legacy?: boolean;
  }): TaskReview {
    const existing = this.database.prepare("SELECT * FROM task_reviews WHERE post_id = ?").get(input.postId) as Record<string, unknown> | undefined;
    if (existing) return this.taskReviewFromRow(existing);
    const current = this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM task_reviews WHERE session_id = ?")
      .get(input.sessionId) as { version: number };
    this.database.prepare("UPDATE task_reviews SET state = 'superseded', updated_at = ? WHERE session_id = ? AND state = 'unreviewed'")
      .run(input.createdAt, input.sessionId);
    const review: TaskReview = {
      id: `review:${randomUUID()}`,
      taskId: input.taskId,
      sessionId: input.sessionId,
      postId: input.postId,
      version: Number(current.version) + 1,
      state: "unreviewed",
      bundle: input.bundle,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      legacy: input.legacy ?? false,
    };
    this.database.prepare(`
      INSERT INTO task_reviews(
        id, task_id, session_id, post_id, version, state, bundle_json,
        decision_note, decided_by_device_id, created_at, updated_at, legacy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    `).run(
      review.id,
      review.taskId,
      review.sessionId,
      review.postId,
      review.version,
      review.state,
      JSON.stringify(review.bundle),
      review.createdAt,
      review.updatedAt,
      review.legacy ? 1 : 0,
    );
    return review;
  }

  getTaskReview(id: string): TaskReview | null {
    const row = this.database.prepare("SELECT * FROM task_reviews WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.taskReviewFromRow(row) : null;
  }

  getTaskReviewByPost(postId: string): TaskReview | null {
    const row = this.database.prepare("SELECT * FROM task_reviews WHERE post_id = ?").get(postId) as Record<string, unknown> | undefined;
    return row ? this.taskReviewFromRow(row) : null;
  }

  listTaskReviews(sessionId?: string): TaskReview[] {
    const rows = sessionId
      ? this.database.prepare("SELECT * FROM task_reviews WHERE session_id = ? ORDER BY version DESC").all(sessionId)
      : this.database.prepare("SELECT * FROM task_reviews ORDER BY updated_at DESC LIMIT 200").all();
    return (rows as Record<string, unknown>[]).map((row) => this.taskReviewFromRow(row));
  }

  respondToTaskReview(input: {
    reviewId: string;
    decision: "accept" | "request_changes";
    note?: string;
    deviceId: string;
    updatedAt: string;
  }): TaskReview | null {
    const review = this.getTaskReview(input.reviewId);
    if (!review || review.state !== "unreviewed") return review;
    const state = input.decision === "accept" ? "accepted" : "changes_requested";
    this.database.prepare(`
      UPDATE task_reviews SET state = ?, decision_note = ?, decided_by_device_id = ?, updated_at = ? WHERE id = ?
    `).run(state, input.note?.trim() || null, input.deviceId, input.updatedAt, input.reviewId);
    return this.getTaskReview(input.reviewId);
  }

  getTrustPolicy(projectId: string): ProjectTrustPolicy {
    const row = this.database.prepare("SELECT * FROM project_trust_policies WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    if (!row) {
      return { projectId, preset: "ask", autoAllow: [], updatedAt: new Date(0).toISOString(), updatedByDeviceId: "" };
    }
    return this.trustPolicyFromRow(row);
  }

  listTrustPolicies(): ProjectTrustPolicy[] {
    const stored = new Map((this.database.prepare("SELECT * FROM project_trust_policies").all() as Record<string, unknown>[])
      .map((row) => {
        const policy = this.trustPolicyFromRow(row);
        return [policy.projectId, policy] as const;
      }));
    return this.listProjects().map((project) => stored.get(project.id) ?? this.getTrustPolicy(project.id));
  }

  updateTrustPolicy(projectId: string, preset: ProjectTrustPolicy["preset"], deviceId: string): ProjectTrustPolicy {
    const updatedAt = new Date().toISOString();
    const autoAllow: ApprovalCategory[] = preset === "safe_automation" ? ["read", "search", "test", "build"] : [];
    this.database.prepare(`
      INSERT INTO project_trust_policies(project_id, preset, auto_allow_json, updated_at, updated_by_device_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        preset = excluded.preset,
        auto_allow_json = excluded.auto_allow_json,
        updated_at = excluded.updated_at,
        updated_by_device_id = excluded.updated_by_device_id
    `).run(projectId, preset, JSON.stringify(autoAllow), updatedAt, deviceId);
    return { projectId, preset, autoAllow, updatedAt, updatedByDeviceId: deviceId };
  }

  insertTrustAudit(entry: TrustAuditEntry): TrustAuditEntry {
    this.database.prepare(`
      INSERT OR IGNORE INTO trust_audit(
        id, project_id, session_id, device_id, category, decision, reason, action_summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.projectId,
      entry.sessionId,
      entry.deviceId,
      entry.category,
      entry.decision,
      entry.reason,
      entry.actionSummary,
      entry.createdAt,
    );
    return entry;
  }

  listTrustAudit(projectId?: string, limit = 100): TrustAuditEntry[] {
    const rows = projectId
      ? this.database.prepare("SELECT * FROM trust_audit WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit)
      : this.database.prepare("SELECT * FROM trust_audit ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Record<string, unknown>[]).map((row) => this.trustAuditFromRow(row));
  }

  getNotificationSettings(deviceId: string): NotificationSettings {
    const row = deviceId
      ? this.database.prepare("SELECT * FROM notification_settings WHERE device_id = ?").get(deviceId) as Record<string, unknown> | undefined
      : undefined;
    return row ? this.notificationSettingsFromRow(row) : {
      enabled: false,
      approvals: true,
      failures: true,
      reviews: true,
      showTaskTitle: false,
      updatedAt: new Date(0).toISOString(),
    };
  }

  updateNotificationSettings(deviceId: string, settings: Omit<NotificationSettings, "updatedAt">): NotificationSettings {
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO notification_settings(device_id, enabled, approvals, failures, reviews, show_task_title, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        enabled = excluded.enabled,
        approvals = excluded.approvals,
        failures = excluded.failures,
        reviews = excluded.reviews,
        show_task_title = excluded.show_task_title,
        updated_at = excluded.updated_at
    `).run(
      deviceId,
      settings.enabled ? 1 : 0,
      settings.approvals ? 1 : 0,
      settings.failures ? 1 : 0,
      settings.reviews ? 1 : 0,
      settings.showTaskTitle ? 1 : 0,
      updatedAt,
    );
    return { ...settings, updatedAt };
  }

  upsertPushDevice(deviceId: string, endpoint: string, publicKey: string): PushDeviceRegistration {
    const now = new Date().toISOString();
    const existing = this.database.prepare("SELECT registered_at FROM push_devices WHERE device_id = ?")
      .get(deviceId) as { registered_at: string } | undefined;
    this.database.prepare(`
      INSERT INTO push_devices(device_id, platform, endpoint, public_key, active, registered_at, updated_at)
      VALUES (?, 'ios', ?, ?, 1, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        endpoint = excluded.endpoint,
        public_key = excluded.public_key,
        active = 1,
        updated_at = excluded.updated_at
    `).run(deviceId, endpoint, publicKey, existing?.registered_at ?? now, now);
    return this.getPushDevice(deviceId)!;
  }

  getPushDevice(deviceId: string): PushDeviceRegistration | null {
    const row = this.database.prepare("SELECT * FROM push_devices WHERE device_id = ?").get(deviceId) as Record<string, unknown> | undefined;
    return row ? this.pushDeviceFromRow(row) : null;
  }

  listPushDevices(deviceId = ""): PushDeviceRegistration[] {
    if (!deviceId) return [];
    const registration = this.getPushDevice(deviceId);
    return registration ? [registration] : [];
  }

  listActivePushDevices(): Array<{ registration: PushDeviceRegistration; settings: NotificationSettings }> {
    const rows = this.database.prepare(`
      SELECT push_devices.* FROM push_devices
      JOIN devices ON devices.id = push_devices.device_id
      WHERE push_devices.active = 1 AND devices.revoked_at IS NULL
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      registration: this.pushDeviceFromRow(row),
      settings: this.getNotificationSettings(String(row.device_id)),
    }));
  }

  unregisterPushDevice(deviceId: string): void {
    this.database.prepare("UPDATE push_devices SET active = 0, updated_at = ? WHERE device_id = ?")
      .run(new Date().toISOString(), deviceId);
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
      INSERT INTO actions (action_id, session_id, upstream_request_id, kind, title, detail, decisions_json, expires_at, state, created_at, resolved_at, approval_context_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(action_id) DO UPDATE SET
        decisions_json = excluded.decisions_json,
        expires_at = excluded.expires_at,
        state = excluded.state,
        resolved_at = excluded.resolved_at,
        approval_context_json = excluded.approval_context_json
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
      action.approvalContext ? JSON.stringify(action.approvalContext) : null,
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
      INSERT INTO devices(id, name, key_base64, created_at, last_seen_at, revoked_at, is_local_admin, can_approve, can_manage_trust)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, key_base64 = excluded.key_base64,
        last_seen_at = excluded.last_seen_at, revoked_at = excluded.revoked_at, is_local_admin = excluded.is_local_admin,
        can_approve = excluded.can_approve, can_manage_trust = excluded.can_manage_trust
    `).run(
      device.id,
      device.name,
      device.keyBase64,
      device.createdAt,
      device.lastSeenAt,
      device.revokedAt,
      device.isLocalAdmin ? 1 : 0,
      device.canApprove ? 1 : 0,
      device.canManageTrust ? 1 : 0,
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

  setDeviceTrustManagement(id: string, enabled: boolean): DeviceRecord | null {
    this.database.prepare("UPDATE devices SET can_manage_trust = ? WHERE id = ? AND revoked_at IS NULL AND is_local_admin = 0")
      .run(enabled ? 1 : 0, id);
    return this.getDevice(id);
  }

  getUserProfile(): UserProfile {
    const row = this.database.prepare("SELECT avatar_id, updated_at FROM user_profile WHERE id = 1")
      .get() as { avatar_id: string; updated_at: string } | undefined;
    const avatarId = USER_AVATAR_IDS.includes(row?.avatar_id as UserAvatarId)
      ? row!.avatar_id as UserAvatarId
      : USER_AVATAR_IDS[0];
    return { avatarId, updatedAt: row?.updated_at ?? new Date(0).toISOString() };
  }

  updateUserProfile(avatarId: UserAvatarId): UserProfile {
    const updatedAt = new Date().toISOString();
    this.database.prepare("UPDATE user_profile SET avatar_id = ?, updated_at = ? WHERE id = 1")
      .run(avatarId, updatedAt);
    return { avatarId, updatedAt };
  }

  snapshot(_lanApprovalsEnabled: boolean, deviceId: string, workspaces: TrustedWorkspace[]): Snapshot {
    const device = deviceId ? this.getDevice(deviceId) : null;
    return {
      userProfile: this.getUserProfile(),
      projects: this.listProjects(),
      sessions: this.listSessions(),
      cards: [],
      posts: this.listFeedPosts(),
      tasks: this.listTasks(),
      commands: this.listTaskCommands(),
      workspaces,
      seenPostIds: this.listSeenPostIds(deviceId),
      dismissedFeedItemIds: this.listDismissedFeedItemIds(deviceId),
      taskTimelineCursors: this.listTaskTimelineCursors(deviceId),
      taskPreferences: this.listTaskPreferences(),
      actions: this.listActions(),
      reviews: this.listTaskReviews(),
      trustPolicies: this.listTrustPolicies(),
      trustAudit: this.listTrustAudit(),
      notificationSettings: this.getNotificationSettings(deviceId),
      pushDevices: this.listPushDevices(deviceId),
      features: FEATURE_CAPABILITIES,
      sequence: this.latestSequence(),
      lanApprovalsEnabled: device?.isLocalAdmin === true || device?.canApprove === true,
    };
  }

  prune(retentionDays = 7): void {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    this.database.prepare("DELETE FROM events WHERE occurred_at < ? AND kind != 'user_instruction'").run(cutoff);
    this.database.prepare("DELETE FROM cards WHERE updated_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM feed_posts WHERE created_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM feed_checkpoints WHERE started_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM actions WHERE created_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM idempotency WHERE created_at < ?").run(cutoff);
    this.database.prepare("DELETE FROM trust_audit WHERE created_at < ?").run(new Date(Date.now() - 30 * 86_400_000).toISOString());
  }

  private sessionFromRow(row: Record<string, unknown>): Session {
    return {
      id: String(row.id),
      projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
      provider: row.provider as Session["provider"],
      surface: (row.surface ?? "unknown") as Session["surface"],
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

  private projectFromRow(row: Record<string, unknown>): Project {
    const id = String(row.id);
    const locations = this.database.prepare("SELECT path FROM project_locations WHERE project_id = ? ORDER BY last_seen_at DESC")
      .all(id) as Array<{ path: string }>;
    const providers = this.database.prepare("SELECT DISTINCT provider FROM sessions WHERE project_id = ? ORDER BY provider")
      .all(id) as Array<{ provider: Project["providers"][number] }>;
    const sessionCount = this.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?")
      .get(id) as { count: number };
    const postCount = this.database.prepare("SELECT COUNT(*) AS count FROM feed_posts WHERE project_id = ? AND source = 'agent'")
      .get(id) as { count: number };
    return {
      id,
      name: String(row.name),
      primaryPath: locations[0]?.path ?? "",
      paths: locations.map((location) => location.path),
      providers: providers.map((provider) => provider.provider),
      sessionCount: Number(sessionCount.count),
      postCount: Number(postCount.count),
      agentProfile: {
        displayName: row.agent_display_name ? String(row.agent_display_name) : String(row.name),
        avatar: row.agent_avatar ? String(row.agent_avatar) : USER_AVATAR_IDS[0],
        bio: row.agent_bio ? String(row.agent_bio) : `负责 ${String(row.name)} 项目的长期工作与上下文。`,
        defaultProvider: row.agent_default_provider === "codex" || row.agent_default_provider === "claude" ? row.agent_default_provider : null,
        updatedAt: row.agent_updated_at ? String(row.agent_updated_at) : String(row.created_at),
      },
      createdAt: String(row.created_at),
      lastUsedAt: String(row.last_used_at),
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
      projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
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

  private taskReviewFromRow(row: Record<string, unknown>): TaskReview {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      sessionId: String(row.session_id),
      postId: String(row.post_id),
      version: Number(row.version),
      state: row.state as TaskReview["state"],
      bundle: json<ReviewBundle>(String(row.bundle_json)),
      ...(row.decision_note ? { decisionNote: String(row.decision_note) } : {}),
      ...(row.decided_by_device_id ? { decidedByDeviceId: String(row.decided_by_device_id) } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      legacy: Number(row.legacy) === 1,
    };
  }

  private trustPolicyFromRow(row: Record<string, unknown>): ProjectTrustPolicy {
    return {
      projectId: String(row.project_id),
      preset: row.preset as ProjectTrustPolicy["preset"],
      autoAllow: json<ApprovalCategory[]>(String(row.auto_allow_json)),
      updatedAt: String(row.updated_at),
      updatedByDeviceId: String(row.updated_by_device_id),
    };
  }

  private trustAuditFromRow(row: Record<string, unknown>): TrustAuditEntry {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      sessionId: String(row.session_id),
      deviceId: String(row.device_id),
      category: row.category as TrustAuditEntry["category"],
      decision: row.decision as TrustAuditEntry["decision"],
      reason: String(row.reason),
      actionSummary: String(row.action_summary),
      createdAt: String(row.created_at),
    };
  }

  private notificationSettingsFromRow(row: Record<string, unknown>): NotificationSettings {
    return {
      enabled: Number(row.enabled) === 1,
      approvals: Number(row.approvals) === 1,
      failures: Number(row.failures) === 1,
      reviews: Number(row.reviews) === 1,
      showTaskTitle: Number(row.show_task_title) === 1,
      updatedAt: String(row.updated_at),
    };
  }

  private pushDeviceFromRow(row: Record<string, unknown>): PushDeviceRegistration {
    return {
      deviceId: String(row.device_id),
      platform: "ios",
      endpoint: String(row.endpoint),
      publicKey: String(row.public_key),
      active: Number(row.active) === 1,
      registeredAt: String(row.registered_at),
      updatedAt: String(row.updated_at),
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
      ...(row.approval_context_json ? { approvalContext: json(String(row.approval_context_json)) } : {}),
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
      canManageTrust: row.can_manage_trust === 1,
    };
  }
}
