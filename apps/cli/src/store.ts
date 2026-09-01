import { randomInt, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactText, redactUnknown } from "@zimlo/adapters";
import { CardBlockSchema, FEATURE_CAPABILITIES, ResolvedCardPresentationSchema, USER_AVATAR_IDS } from "@zimlo/protocol";
import type {
  ApprovalCategory,
  FeedCard,
  FeedPost,
  Material,
  NotificationSettings,
  PendingAction,
  Project,
  ProjectTrustPolicy,
  PushDeviceRegistration,
  Session,
  Snapshot,
  TaskCommand,
  TaskPreference,
  TaskRecord,
  TrustedWorkspace,
  TrustAuditEntry,
  UnifiedEvent,
  UserAvatarId,
  UserProfile,
} from "@zimlo/protocol";
import { ephemeralWorkspaceKind, persistableProjectForCwd, projectContextForCwd } from "./project-context.js";
import { sanitizeEventPayload } from "./sanitization.js";
import {
  actionFromRow,
  cardFromRow,
  defaultPresentation,
  deviceFromRow,
  eventFromRow,
  feedPostFromRow,
  json,
  materialFromRow,
  notificationSettingsFromRow,
  pushDeviceFromRow,
  sessionFromRow,
  taskCommandFromRow,
  taskFromRow,
  trustAuditFromRow,
  trustPolicyFromRow,
  type DeviceRecord,
  type DeviceRow,
  type StoredFeedContentV2,
  type StoredFeedContentV3,
} from "./store-codecs.js";
import { initializeStoreSchema, migrateNotificationDeliveryPolicy } from "./store-schema.js";

export type { DeviceRecord } from "./store-codecs.js";
export type FeedDecisionKind = "post" | "skip" | "implicit_skip";

interface ProjectRelations {
  locations: Map<string, string[]>;
  providers: Map<string, Project["providers"]>;
  sessionCounts: Map<string, number>;
  postCounts: Map<string, number>;
}

export function isForeignKeyConstraintFailure(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "errcode" in error
    && (error as { errcode?: unknown }).errcode === 787;
}

export class ZimloStore {
  readonly database: DatabaseSync;
  readonly rootPath: string;

  constructor(path: string) {
    this.rootPath = dirname(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;");
    this.migrate();
    if (existsSync(path)) chmodSync(path, 0o600);
  }

  close(): void {
    this.database.close();
  }

  materialStoragePaths(): { materials: string; staging: string } {
    const materials = join(this.rootPath, "materials");
    return { materials, staging: join(materials, ".staging") };
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
    initializeStoreSchema(this.database);
    const permissionDefaultsMigration = this.database.prepare("SELECT value FROM metadata WHERE key = 'device_permissions_default_on_v1'").get() as { value: string } | undefined;
    if (permissionDefaultsMigration?.value !== "1") {
      this.database.prepare(`
        UPDATE devices SET can_approve = 1, can_manage_trust = 1
        WHERE revoked_at IS NULL AND is_local_admin = 0
      `).run();
      this.database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('device_permissions_default_on_v1', '1')").run();
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
    this.migrateFeedV3();
    this.migrateInteractionV3();
    this.migrateNotificationResults();
    migrateNotificationDeliveryPolicy(this.database);
    this.database.prepare("UPDATE task_commands SET state = 'queued', updated_at = ?, error = NULL WHERE state IN ('dispatching', 'running')")
      .run(new Date().toISOString());
    this.database.prepare("UPDATE actions SET state = 'expired' WHERE state IN ('pending', 'submitted')").run();
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
    return row ? this.projectFromRow(row, this.loadProjectRelations(id)) : null;
  }

  listProjects(): Project[] {
    const rows = this.database.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE, id").all() as Record<string, unknown>[];
    const relations = this.loadProjectRelations();
    return rows.map((row) => this.projectFromRow(row, relations));
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
          SELECT id, kind, title, body FROM feed_posts
          WHERE source = 'agent' AND content_json IS NULL
        `).all() as Array<Record<string, unknown>>;
        const updateContent = this.database.prepare("UPDATE feed_posts SET content_json = ? WHERE id = ?");
        for (const post of legacyPosts) {
          const content: StoredFeedContentV2 = {
            template: "paper",
            headline: String(post.title).slice(0, 72),
            takeaway: String(post.body).slice(0, 320),
            highlights: [],
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

  private migrateFeedV3(): void {
    const migrationKey = "feed_card_presentation_v3";
    if (this.getMetadata(migrationKey) === "1") return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const posts = this.database.prepare("SELECT id, kind, title, body, content_json FROM feed_posts").all() as Array<Record<string, unknown>>;
      const update = this.database.prepare("UPDATE feed_posts SET content_json = ?, title = ?, body = ? WHERE id = ?");
      for (const post of posts) {
        let raw: Record<string, unknown> = {};
        try {
          raw = post.content_json ? JSON.parse(String(post.content_json)) as Record<string, unknown> : {};
        } catch {
          // Invalid local beta content is replaced with a safe, readable card.
        }
        const content = raw.content && typeof raw.content === "object" ? raw.content as StoredFeedContentV3["content"] : { type: "text" as const };
        const parsedBlocks = CardBlockSchema.array().max(8).safeParse(raw.blocks);
        const blocks = parsedBlocks.success ? parsedBlocks.data : [];
        const parsedPresentation = ResolvedCardPresentationSchema.safeParse(raw.presentation);
        const presentation = parsedPresentation.success
          ? parsedPresentation.data
          : defaultPresentation(String(post.kind), content, blocks);
        const migrated: StoredFeedContentV3 = {
          presentation,
          headline: redactText(typeof raw.headline === "string" ? raw.headline : String(post.title), 72),
          takeaway: redactText(typeof raw.takeaway === "string" ? raw.takeaway : String(post.body), 320),
          highlights: Array.isArray(raw.highlights)
            ? raw.highlights.filter((value): value is string => typeof value === "string").slice(0, 3).map((value) => redactText(value, 100))
            : [],
          blocks,
          ...(typeof raw.proof === "string" && raw.proof ? { proof: redactText(raw.proof, 160) } : {}),
          ...(content ? { content } : {}),
        };
        update.run(JSON.stringify(migrated), migrated.headline, migrated.takeaway, String(post.id));
      }
      this.database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, '1')").run(migrationKey);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateInteractionV3(): void {
    const migrationKey = "interaction_v3_migration";
    if (this.getMetadata(migrationKey) === "1") return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DROP TABLE IF EXISTS task_reviews");
      this.database.exec("DROP INDEX IF EXISTS feed_posts_timeline_idx");
      const feedColumns = this.database.prepare("PRAGMA table_info(feed_posts)").all() as Array<{ name: string }>;
      for (const name of ["action_required", "action_prompt", "actions_json", "pending_action_ids_json"]) {
        if (feedColumns.some((column) => column.name === name)) this.database.exec(`ALTER TABLE feed_posts DROP COLUMN ${name}`);
      }
      this.database.exec("CREATE INDEX IF NOT EXISTS feed_posts_timeline_idx ON feed_posts(created_at DESC)");
      const notificationColumns = this.database.prepare("PRAGMA table_info(notification_settings)").all() as Array<{ name: string }>;
      if (notificationColumns.some((column) => column.name === "reviews")) {
        this.database.exec("ALTER TABLE notification_settings DROP COLUMN reviews");
      }
      this.database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, '1')").run(migrationKey);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateNotificationResults(): void {
    const columns = this.database.prepare("PRAGMA table_info(notification_settings)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "results")) {
      this.database.exec("ALTER TABLE notification_settings ADD COLUMN results INTEGER NOT NULL DEFAULT 1");
    }
  }

  private scrubStoredContent(): void {
    const key = "content_scrub_version";
    const current = this.database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    if (Number(current?.value ?? 0) >= 4) return;
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
          const content = json<StoredFeedContentV3>(post.content_json);
          const parsedBlocks = CardBlockSchema.array().max(8).safeParse(content.blocks);
          const blocks = parsedBlocks.success ? parsedBlocks.data : [];
          const parsedPresentation = ResolvedCardPresentationSchema.safeParse(content.presentation);
          const sanitized: StoredFeedContentV3 = {
            presentation: parsedPresentation.success ? parsedPresentation.data : defaultPresentation(post.kind, content.content, blocks),
            headline: redactText(content.headline, 72),
            takeaway: redactText(content.takeaway, 320),
            highlights: (content.highlights ?? []).slice(0, 3).map((highlight) => redactText(highlight, 100)),
            blocks,
            ...(content.proof ? { proof: redactText(content.proof, 160) } : {}),
            ...(content.content ? { content: content.content } : {}),
          };
          updatePost.run(JSON.stringify(sanitized), sanitized.headline, sanitized.takeaway, post.id);
        } catch {
          const fallback: StoredFeedContentV3 = { presentation: defaultPresentation(post.kind), headline: "历史帖子", takeaway: "历史内容无法安全读取。", highlights: [], blocks: [] };
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

      this.database.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)").run(key, "4");
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
    return row ? sessionFromRow(row) : null;
  }

  getSessionByProviderId(provider: string, providerSessionId: string): Session | null {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE provider = ? AND provider_session_id = ?")
      .get(provider, providerSessionId) as Record<string, unknown> | undefined;
    return row ? sessionFromRow(row) : null;
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
      const session = sessionFromRow(checkpointMatch);
      if (!session.correlationUncertain) return session;
    }
    if (parentPid > 0) {
      const row = this.database.prepare("SELECT * FROM sessions WHERE provider = ? AND active_pid = ? ORDER BY last_activity_at DESC LIMIT 1")
        .get(provider, parentPid) as Record<string, unknown> | undefined;
      if (row) {
        const session = sessionFromRow(row);
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
      const session = sessionFromRow(openCheckpoints[0]!);
      if (!session.correlationUncertain) return session;
    }
    if (!cwd) return null;
    const rows = this.database.prepare(`
      SELECT * FROM sessions
      WHERE provider = ? AND cwd = ? AND active_pid IS NOT NULL
      ORDER BY last_activity_at DESC LIMIT 2
    `).all(provider, cwd) as Record<string, unknown>[];
    if (rows.length !== 1) return null;
    const session = sessionFromRow(rows[0]!);
    return session.correlationUncertain ? null : session;
  }

  listSessions(): Session[] {
    return (this.database.prepare("SELECT * FROM sessions ORDER BY last_activity_at DESC").all() as Record<string, unknown>[])
      .map((row) => sessionFromRow(row));
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
    return rows.map((row) => eventFromRow(row)).reverse();
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

  insertFeedPost(post: FeedPost, coalesceProgressWithinMs = 0): { post: FeedPost; inserted: boolean; coalesced: boolean } {
    const projectId = post.projectId ?? (post.sessionId ? this.getSession(post.sessionId)?.projectId ?? null : null);
    const existingDedupe = this.database.prepare(`
      SELECT * FROM feed_posts WHERE agent_id = ? AND run_id = ? AND dedupe_key = ?
    `).get(post.agentId, post.runId, post.dedupeKey) as Record<string, unknown> | undefined;
    if (existingDedupe) return { post: feedPostFromRow(existingDedupe), inserted: false, coalesced: false };

    if (post.kind === "progress" && coalesceProgressWithinMs > 0) {
      const windowStart = new Date(Date.parse(post.createdAt) - coalesceProgressWithinMs).toISOString();
      const recent = this.database.prepare(`
        SELECT * FROM feed_posts
        WHERE agent_id = ? AND run_id = ? AND task_id = ? AND kind = 'progress'
          AND source = 'agent' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1
      `).get(post.agentId, post.runId, post.taskId, windowStart) as Record<string, unknown> | undefined;
      if (recent) {
        const id = String(recent.id);
        this.database.prepare(`
          UPDATE feed_posts SET
            project_id = ?, session_id = ?, title = ?, body = ?, dedupe_key = ?,
            created_at = ?, content_json = ?
          WHERE id = ?
        `).run(
          projectId,
          post.sessionId,
          post.headline,
          post.takeaway,
          post.dedupeKey,
          post.createdAt,
          JSON.stringify({
            presentation: post.presentation,
            headline: post.headline,
            takeaway: post.takeaway,
            highlights: post.highlights,
            blocks: post.blocks,
            ...(post.proof ? { proof: post.proof } : {}),
            ...(post.content ? { content: post.content } : {}),
          } satisfies StoredFeedContentV3),
          id,
        );
        return { post: { ...post, id, projectId }, inserted: false, coalesced: true };
      }
    }
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO feed_posts (
        id, project_id, task_id, run_id, agent_id, session_id, kind, title, body,
        dedupe_key, source, created_at, content_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      post.dedupeKey,
      post.source,
      post.createdAt,
      JSON.stringify({
        presentation: post.presentation,
        headline: post.headline,
        takeaway: post.takeaway,
        highlights: post.highlights,
        blocks: post.blocks,
        ...(post.proof ? { proof: post.proof } : {}),
        ...(post.content ? { content: post.content } : {}),
      } satisfies StoredFeedContentV3),
    );
    if (result.changes > 0) {
      if (projectId) {
        this.database.prepare(`
          UPDATE projects SET last_used_at = CASE WHEN ? > last_used_at THEN ? ELSE last_used_at END WHERE id = ?
        `).run(post.createdAt, post.createdAt, projectId);
      }
      return { post: { ...post, projectId }, inserted: true, coalesced: false };
    }
    const existing = this.database.prepare(`
      SELECT * FROM feed_posts WHERE agent_id = ? AND run_id = ? AND dedupe_key = ?
    `).get(post.agentId, post.runId, post.dedupeKey) as Record<string, unknown> | undefined;
    if (!existing) throw new Error("Feed 帖子去重冲突，但无法读取原记录。");
    return { post: feedPostFromRow(existing), inserted: false, coalesced: false };
  }

  listFeedPosts(): FeedPost[] {
    return (this.database.prepare(`
      SELECT * FROM feed_posts
      WHERE source = 'agent' AND kind <> 'instruction'
      ORDER BY created_at DESC
      LIMIT 200
    `).all() as Record<string, unknown>[]).map((row) => feedPostFromRow(row));
  }

  upsertMaterial(material: Material, localPath: string | null): Material {
    this.database.prepare(`
      INSERT INTO materials (
        id, kind, name, mime_type, size_bytes, sha256, width, height, duration_ms,
        preview_material_id, origin, status, local_path, created_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, name = excluded.name, mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes, sha256 = excluded.sha256,
        width = excluded.width, height = excluded.height, duration_ms = excluded.duration_ms,
        preview_material_id = excluded.preview_material_id, origin = excluded.origin,
        status = excluded.status, local_path = excluded.local_path, error = excluded.error
    `).run(
      material.id, material.kind, material.name, material.mimeType, material.sizeBytes, material.sha256,
      material.width ?? null, material.height ?? null, material.durationMs ?? null,
      material.previewMaterialId ?? null, material.origin, material.status, localPath,
      material.createdAt, material.error ?? null,
    );
    return this.getMaterial(material.id) ?? material;
  }

  getMaterial(id: string): Material | null {
    const row = this.database.prepare("SELECT * FROM materials WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? materialFromRow(row) : null;
  }

  materialLocalPath(id: string): string | null {
    const row = this.database.prepare("SELECT local_path FROM materials WHERE id = ?").get(id) as { local_path: string | null } | undefined;
    return row?.local_path ?? null;
  }

  listMaterials(): Material[] {
    return (this.database.prepare("SELECT * FROM materials ORDER BY created_at DESC LIMIT 500").all() as Record<string, unknown>[])
      .map((row) => materialFromRow(row));
  }

  latestFeedPost(agentId: string, runId: string, since: string): FeedPost | null {
    const row = this.database.prepare(`
      SELECT * FROM feed_posts
      WHERE agent_id = ? AND run_id = ? AND source = 'agent' AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(agentId, runId, since) as Record<string, unknown> | undefined;
    return row ? feedPostFromRow(row) : null;
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

  getTask(id: string): TaskRecord | null {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? taskFromRow(row) : null;
  }

  listTasks(): TaskRecord[] {
    return (this.database.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all() as Record<string, unknown>[])
      .map((row) => taskFromRow(row));
  }

  insertTaskCommand(command: TaskCommand): { command: TaskCommand; inserted: boolean } {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO task_commands (
        id, idempotency_key, kind, provider, session_id, workspace_id, cwd,
        text, material_ids_json, state, created_at, updated_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.id,
      command.idempotencyKey,
      command.kind,
      command.provider,
      command.sessionId,
      command.workspaceId,
      command.cwd,
      command.text,
      JSON.stringify(command.materialIds ?? []),
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
        session_id = ?, workspace_id = ?, cwd = ?, text = ?, material_ids_json = ?, state = ?,
        updated_at = ?, error = ?
      WHERE id = ?
    `).run(
      command.sessionId,
      command.workspaceId,
      command.cwd,
      command.text,
      JSON.stringify(command.materialIds ?? []),
      command.state,
      command.updatedAt,
      command.error ?? null,
      command.id,
    );
    return this.getTaskCommand(command.id) ?? command;
  }

  getTaskCommand(id: string): TaskCommand | null {
    const row = this.database.prepare("SELECT * FROM task_commands WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? taskCommandFromRow(row) : null;
  }

  getTaskCommandByIdempotencyKey(key: string): TaskCommand | null {
    const row = this.database.prepare("SELECT * FROM task_commands WHERE idempotency_key = ?").get(key) as Record<string, unknown> | undefined;
    return row ? taskCommandFromRow(row) : null;
  }

  listTaskCommands(): TaskCommand[] {
    return (this.database.prepare("SELECT * FROM task_commands ORDER BY created_at DESC LIMIT 200").all() as Record<string, unknown>[])
      .map((row) => taskCommandFromRow(row));
  }

  listQueuedTaskCommands(): TaskCommand[] {
    return (this.database.prepare("SELECT * FROM task_commands WHERE state = 'queued' ORDER BY created_at ASC").all() as Record<string, unknown>[])
      .map((row) => taskCommandFromRow(row));
  }

  markFeedSeen(deviceId: string, postId: string): boolean {
    try {
      return this.database.prepare(`
        INSERT OR IGNORE INTO feed_seen(device_id, post_id, seen_at)
        SELECT ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL
        ) AND EXISTS (
          SELECT 1 FROM feed_posts WHERE id = ?
        )
      `).run(
        deviceId,
        postId,
        new Date().toISOString(),
        deviceId,
        postId,
      ).changes > 0;
    } catch (error) {
      // A stale mobile receipt can race another Zimlo process pruning its
      // device or post during app replacement. The receipt is advisory, so a
      // missing parent is a safe no-op and must never take down the Bridge.
      if (isForeignKeyConstraintFailure(error)) return false;
      throw error;
    }
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

  getTrustPolicy(projectId: string): ProjectTrustPolicy {
    const row = this.database.prepare("SELECT * FROM project_trust_policies WHERE project_id = ?")
      .get(projectId) as Record<string, unknown> | undefined;
    if (!row) {
      return { projectId, preset: "ask", autoAllow: [], updatedAt: new Date(0).toISOString(), updatedByDeviceId: "" };
    }
    return trustPolicyFromRow(row);
  }

  listTrustPolicies(): ProjectTrustPolicy[] {
    const stored = new Map((this.database.prepare("SELECT * FROM project_trust_policies").all() as Record<string, unknown>[])
      .map((row) => {
        const policy = trustPolicyFromRow(row);
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
    return (rows as Record<string, unknown>[]).map((row) => trustAuditFromRow(row));
  }

  getNotificationSettings(deviceId: string): NotificationSettings {
    const row = deviceId
      ? this.database.prepare("SELECT * FROM notification_settings WHERE device_id = ?").get(deviceId) as Record<string, unknown> | undefined
      : undefined;
    return row ? notificationSettingsFromRow(row) : {
      enabled: false,
      approvals: true,
      results: true,
      failures: true,
      criticalOnly: false,
      quietHoursEnabled: false,
      timeZoneOffsetMinutes: 0,
      showTaskTitle: false,
      updatedAt: new Date(0).toISOString(),
    };
  }

  updateNotificationSettings(deviceId: string, settings: Omit<NotificationSettings, "updatedAt">): NotificationSettings {
    const updatedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO notification_settings(
        device_id, enabled, approvals, results, failures, critical_only,
        quiet_hours_enabled, timezone_offset_minutes, show_task_title, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        enabled = excluded.enabled,
        approvals = excluded.approvals,
        results = excluded.results,
        failures = excluded.failures,
        critical_only = excluded.critical_only,
        quiet_hours_enabled = excluded.quiet_hours_enabled,
        timezone_offset_minutes = excluded.timezone_offset_minutes,
        show_task_title = excluded.show_task_title,
        updated_at = excluded.updated_at
    `).run(
      deviceId,
      settings.enabled ? 1 : 0,
      settings.approvals ? 1 : 0,
      settings.results ? 1 : 0,
      settings.failures ? 1 : 0,
      settings.criticalOnly ? 1 : 0,
      settings.quietHoursEnabled ? 1 : 0,
      settings.timeZoneOffsetMinutes,
      settings.showTaskTitle ? 1 : 0,
      updatedAt,
    );
    return { ...settings, updatedAt };
  }

  upsertPushDevice(
    deviceId: string,
    endpoint: string,
    publicKey: string,
    environment: "development" | "production" = "production",
  ): PushDeviceRegistration {
    const now = new Date().toISOString();
    const existing = this.database.prepare("SELECT registered_at FROM push_devices WHERE device_id = ?")
      .get(deviceId) as { registered_at: string } | undefined;
    this.database.prepare(`
      INSERT INTO push_devices(device_id, platform, endpoint, public_key, active, environment, registered_at, updated_at)
      VALUES (?, 'ios', ?, ?, 1, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        endpoint = excluded.endpoint,
        public_key = excluded.public_key,
        active = 1,
        environment = excluded.environment,
        updated_at = excluded.updated_at
    `).run(deviceId, endpoint, publicKey, environment, existing?.registered_at ?? now, now);
    return this.getPushDevice(deviceId)!;
  }

  getPushDevice(deviceId: string): PushDeviceRegistration | null {
    const row = this.database.prepare(`
      SELECT push_devices.*,
        push_delivery_status.kind AS last_delivery_kind,
        push_delivery_status.status AS last_delivery_status,
        push_delivery_status.attempted_at AS last_delivery_at
      FROM push_devices
      LEFT JOIN push_delivery_status USING (device_id)
      WHERE push_devices.device_id = ?
    `).get(deviceId) as Record<string, unknown> | undefined;
    return row ? pushDeviceFromRow(row) : null;
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
      registration: pushDeviceFromRow(row),
      settings: this.getNotificationSettings(String(row.device_id)),
    }));
  }

  notificationUnreadCount(deviceId: string, settings = this.getNotificationSettings(deviceId)): number {
    const actionCount = settings.approvals
      ? Number((this.database.prepare(`
          SELECT COUNT(*) AS count FROM actions
          WHERE state = 'pending' AND expires_at > ?
        `).get(new Date().toISOString()) as { count: number }).count)
      : 0;
    const postKinds = [
      ...(settings.results && !settings.criticalOnly ? ["result"] : []),
      ...(settings.failures ? ["failure"] : []),
    ];
    if (postKinds.length === 0) return Math.min(actionCount, 99);
    const placeholders = postKinds.map(() => "?").join(", ");
    const postCount = Number((this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM feed_posts
      LEFT JOIN feed_seen
        ON feed_seen.post_id = feed_posts.id AND feed_seen.device_id = ?
      WHERE feed_seen.post_id IS NULL AND feed_posts.kind IN (${placeholders})
    `).get(deviceId, ...postKinds) as { count: number }).count);
    return Math.min(actionCount + postCount, 99);
  }

  recordPushDelivery(
    deviceId: string,
    kind: "approval" | "approval_reminder" | "result" | "failure",
    status: number,
    attemptedAt = new Date().toISOString(),
  ): void {
    this.database.prepare(`
      INSERT INTO push_delivery_status(device_id, kind, status, attempted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        kind = excluded.kind,
        status = excluded.status,
        attempted_at = excluded.attempted_at
    `).run(deviceId, kind, status, attemptedAt);
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
      .map((row) => cardFromRow(row));
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
    return row ? actionFromRow(row) : null;
  }

  listPendingActions(): PendingAction[] {
    return (this.database
      .prepare("SELECT * FROM actions WHERE state IN ('pending', 'submitted') AND expires_at > ? ORDER BY created_at DESC")
      .all(new Date().toISOString()) as Record<string, unknown>[]).map((row) => actionFromRow(row));
  }

  listActions(): PendingAction[] {
    return (this.database
      .prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT 200")
      .all() as Record<string, unknown>[]).map((row) => actionFromRow(row));
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
    return row ? deviceFromRow(row) : null;
  }

  listDevices(): DeviceRecord[] {
    return (this.database.prepare("SELECT * FROM devices ORDER BY created_at DESC").all() as unknown as DeviceRow[])
      .map((row) => deviceFromRow(row));
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
      materials: this.listMaterials(),
      tasks: this.listTasks(),
      commands: this.listTaskCommands(),
      workspaces,
      seenPostIds: this.listSeenPostIds(deviceId),
      dismissedFeedItemIds: this.listDismissedFeedItemIds(deviceId),
      taskTimelineCursors: this.listTaskTimelineCursors(deviceId),
      taskPreferences: this.listTaskPreferences(),
      actions: this.listActions(),
      trustPolicies: this.listTrustPolicies(),
      trustAudit: this.listTrustAudit(),
      notificationSettings: this.getNotificationSettings(deviceId),
      pushDevices: this.listPushDevices(deviceId),
      features: FEATURE_CAPABILITIES,
      sequence: this.latestSequence(),
      lanApprovalsEnabled: device?.isLocalAdmin === true || device?.canApprove === true,
      trustManagementEnabled: device?.isLocalAdmin === true || device?.canManageTrust === true,
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


  private loadProjectRelations(projectId?: string): ProjectRelations {
    const suffix = projectId ? " WHERE project_id = ?" : "";
    const parameters = projectId ? [projectId] : [];
    const locations = new Map<string, string[]>();
    const providers = new Map<string, Project["providers"]>();
    const sessionCounts = new Map<string, number>();
    const postCounts = new Map<string, number>();

    const locationRows = this.database.prepare(`
      SELECT project_id, path FROM project_locations${suffix}
      ORDER BY project_id, last_seen_at DESC
    `).all(...parameters) as Array<{ project_id: string; path: string }>;
    for (const row of locationRows) {
      const values = locations.get(row.project_id) ?? [];
      values.push(row.path);
      locations.set(row.project_id, values);
    }

    const providerRows = this.database.prepare(`
      SELECT project_id, provider FROM sessions${suffix}
      GROUP BY project_id, provider ORDER BY project_id, provider
    `).all(...parameters) as Array<{ project_id: string; provider: Project["providers"][number] }>;
    for (const row of providerRows) {
      const values = providers.get(row.project_id) ?? [];
      values.push(row.provider);
      providers.set(row.project_id, values);
    }

    const sessionRows = this.database.prepare(`
      SELECT project_id, COUNT(*) AS count FROM sessions${suffix}
      GROUP BY project_id
    `).all(...parameters) as Array<{ project_id: string; count: number }>;
    for (const row of sessionRows) sessionCounts.set(row.project_id, Number(row.count));

    const postWhere = projectId ? " WHERE source = 'agent' AND project_id = ?" : " WHERE source = 'agent'";
    const postRows = this.database.prepare(`
      SELECT project_id, COUNT(*) AS count FROM feed_posts${postWhere}
      GROUP BY project_id
    `).all(...parameters) as Array<{ project_id: string; count: number }>;
    for (const row of postRows) postCounts.set(row.project_id, Number(row.count));

    return { locations, providers, sessionCounts, postCounts };
  }

  private projectFromRow(row: Record<string, unknown>, relations: ProjectRelations): Project {
    const id = String(row.id);
    const locations = relations.locations.get(id) ?? [];
    return {
      id,
      name: String(row.name),
      primaryPath: locations[0] ?? "",
      paths: locations,
      providers: relations.providers.get(id) ?? [],
      sessionCount: relations.sessionCounts.get(id) ?? 0,
      postCount: relations.postCounts.get(id) ?? 0,
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
}
