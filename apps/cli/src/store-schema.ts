import type { DatabaseSync } from "node:sqlite";

// Bootstrap and additive compatibility migrations live outside ZimloStore so
// persistence operations do not also own the physical schema definition.
export function initializeStoreSchema(database: DatabaseSync): void {
  database.exec(`
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
        dedupe_key TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        content_json TEXT,
        UNIQUE(agent_id, run_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS feed_posts_timeline_idx ON feed_posts(created_at DESC);

      CREATE TABLE IF NOT EXISTS materials (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        duration_ms INTEGER,
        preview_material_id TEXT,
        origin TEXT NOT NULL,
        status TEXT NOT NULL,
        local_path TEXT,
        created_at TEXT NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS materials_created_idx ON materials(created_at DESC);

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
        material_ids_json TEXT NOT NULL DEFAULT '[]',
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
        can_approve INTEGER NOT NULL DEFAULT 1,
        can_manage_trust INTEGER NOT NULL DEFAULT 1
      );

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
        results INTEGER NOT NULL DEFAULT 1,
        failures INTEGER NOT NULL DEFAULT 1,
        critical_only INTEGER NOT NULL DEFAULT 0,
        quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
        timezone_offset_minutes INTEGER NOT NULL DEFAULT 0,
        show_task_title INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_devices (
        device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        public_key TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        environment TEXT NOT NULL DEFAULT 'production',
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS push_delivery_status (
        device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status INTEGER NOT NULL,
        attempted_at TEXT NOT NULL
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
  const feedColumns = database.prepare("PRAGMA table_info(feed_posts)").all() as Array<{ name: string }>;
  if (!feedColumns.some((column) => column.name === "content_json")) {
    database.exec("ALTER TABLE feed_posts ADD COLUMN content_json TEXT");
  }
  if (!feedColumns.some((column) => column.name === "project_id")) {
    database.exec("ALTER TABLE feed_posts ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL");
  }
  const taskCommandColumns = database.prepare("PRAGMA table_info(task_commands)").all() as Array<{ name: string }>;
  if (!taskCommandColumns.some((column) => column.name === "material_ids_json")) {
    database.exec("ALTER TABLE task_commands ADD COLUMN material_ids_json TEXT NOT NULL DEFAULT '[]'");
  }
  const projectColumns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
  if (!projectColumns.some((column) => column.name === "identity_key")) database.exec("ALTER TABLE projects ADD COLUMN identity_key TEXT");
  if (!projectColumns.some((column) => column.name === "agent_display_name")) database.exec("ALTER TABLE projects ADD COLUMN agent_display_name TEXT");
  if (!projectColumns.some((column) => column.name === "agent_avatar")) database.exec("ALTER TABLE projects ADD COLUMN agent_avatar TEXT");
  if (!projectColumns.some((column) => column.name === "agent_bio")) database.exec("ALTER TABLE projects ADD COLUMN agent_bio TEXT");
  if (!projectColumns.some((column) => column.name === "agent_default_provider")) database.exec("ALTER TABLE projects ADD COLUMN agent_default_provider TEXT");
  if (!projectColumns.some((column) => column.name === "agent_updated_at")) database.exec("ALTER TABLE projects ADD COLUMN agent_updated_at TEXT");
  database.exec("CREATE INDEX IF NOT EXISTS projects_identity_idx ON projects(identity_key)");
  const sessionColumns = database.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "project_id")) {
    database.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL");
  }
  if (!sessionColumns.some((column) => column.name === "surface")) {
    database.exec("ALTER TABLE sessions ADD COLUMN surface TEXT NOT NULL DEFAULT 'unknown'");
  }
  const deviceColumns = database.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
  if (!deviceColumns.some((column) => column.name === "can_approve")) {
    database.exec("ALTER TABLE devices ADD COLUMN can_approve INTEGER NOT NULL DEFAULT 1");
  }
  if (!deviceColumns.some((column) => column.name === "can_manage_trust")) {
    database.exec("ALTER TABLE devices ADD COLUMN can_manage_trust INTEGER NOT NULL DEFAULT 1");
  }
  const actionColumns = database.prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>;
  if (!actionColumns.some((column) => column.name === "approval_context_json")) {
    database.exec("ALTER TABLE actions ADD COLUMN approval_context_json TEXT");
  }
}

export function migrateNotificationDeliveryPolicy(database: DatabaseSync): void {
  const notificationColumns = database.prepare("PRAGMA table_info(notification_settings)").all() as Array<{ name: string }>;
  if (!notificationColumns.some((column) => column.name === "critical_only")) {
    database.exec("ALTER TABLE notification_settings ADD COLUMN critical_only INTEGER NOT NULL DEFAULT 0");
  }
  if (!notificationColumns.some((column) => column.name === "quiet_hours_enabled")) {
    database.exec("ALTER TABLE notification_settings ADD COLUMN quiet_hours_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!notificationColumns.some((column) => column.name === "timezone_offset_minutes")) {
    database.exec("ALTER TABLE notification_settings ADD COLUMN timezone_offset_minutes INTEGER NOT NULL DEFAULT 0");
  }
  const pushColumns = database.prepare("PRAGMA table_info(push_devices)").all() as Array<{ name: string }>;
  if (!pushColumns.some((column) => column.name === "environment")) {
    database.exec("ALTER TABLE push_devices ADD COLUMN environment TEXT NOT NULL DEFAULT 'production'");
  }
}
