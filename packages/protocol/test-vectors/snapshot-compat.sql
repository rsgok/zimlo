INSERT OR REPLACE INTO metadata(key, value) VALUES ('host_identity_v1', 'host_snapshot_fixture');
INSERT OR REPLACE INTO user_profile(id, avatar_id, updated_at)
VALUES (1, 'user-07', '2026-09-01T09:00:00.000Z');

INSERT INTO projects(
  id, name, created_at, last_used_at, identity_key, agent_display_name,
  agent_avatar, agent_bio, agent_default_provider, agent_updated_at
) VALUES (
  'project-snapshot', 'Snapshot Project', '2026-09-01T09:00:00.000Z',
  '2026-09-01T12:00:00.000Z', 'path:snapshot-fixture', 'Snapshot Agent',
  'user-03', '负责 Snapshot 兼容验证。', 'codex', '2026-09-01T09:30:00.000Z'
);
INSERT INTO project_locations(path, project_id, first_seen_at, last_seen_at)
VALUES ('/fixture/snapshot', 'project-snapshot', '2026-09-01T09:00:00.000Z', '2026-09-01T12:00:00.000Z');

INSERT INTO sessions(
  id, project_id, provider, surface, provider_session_id, title, cwd, transcript_path,
  status, last_activity_at, created_at, active_pid, process_started_at, tty,
  correlation_uncertain, capabilities_json
) VALUES (
  'session-snapshot', 'project-snapshot', 'codex', 'cli', 'abcd1234-session',
  'Codex · abcd1234', '/fixture/snapshot', '/fixture/snapshot/transcript.jsonl',
  'running', '2026-09-01T12:01:00.000Z', '2026-09-01T10:00:00.000Z',
  4242, '2026-09-01T10:00:00.000Z', 'ttys001', 0,
  '{"discovered":true,"liveObserved":true,"replyable":true,"approvableOnce":true,"approvableSession":false,"approvablePersistent":false,"resumable":true,"diffAvailable":false}'
);
INSERT INTO events(
  sequence, id, provider, session_id, provider_session_id, turn_id, item_id,
  kind, source, occurred_at, payload_json, provenance
) VALUES (
  1, 'event-snapshot', 'codex', 'session-snapshot', 'abcd1234-session',
  'turn-snapshot', NULL, 'user_instruction', 'app_server',
  '2026-09-01T12:01:00.000Z', '{"prompt":"继续迁移完整 Snapshot"}', 'verified'
);

INSERT INTO feed_posts(
  id, project_id, task_id, run_id, agent_id, session_id, kind, title, body,
  dedupe_key, source, created_at, content_json
) VALUES (
  'post-snapshot', 'project-snapshot', 'task-snapshot', 'run-snapshot', 'codex',
  'session-snapshot', 'result', '旧标题', '旧正文', 'snapshot-result', 'agent',
  '2026-09-01T12:05:00.000Z',
  '{"presentation":{"system":"editorial","theme":"ink_classic","layout":"field_note","typography":"serif","density":"airy","mediaPlacement":"none"},"headline":"Snapshot 已兼容","takeaway":"Node 与 Rust 返回相同读模型。","highlights":["完整字段"],"blocks":[{"type":"fact","label":"状态","detail":"通过"}],"proof":"共享 fixture","content":{"type":"text"}}'
);

INSERT INTO materials(
  id, kind, name, mime_type, size_bytes, sha256, width, height, duration_ms,
  preview_material_id, origin, status, local_path, created_at, error
) VALUES (
  'material_snapshot_001', 'image', 'snapshot.png', 'image/png', 128,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  320, 180, NULL, NULL, 'agent', 'ready', '/fixture/snapshot.png',
  '2026-09-01T12:02:00.000Z', NULL
);
INSERT INTO tasks(id, run_id, agent_id, session_id, state, reason, updated_at)
VALUES (
  'task-snapshot', 'run-snapshot', 'codex', 'session-snapshot', 'user_review',
  '等待用户查看 Snapshot', '2026-09-01T12:05:00.000Z'
);
INSERT INTO task_commands(
  id, idempotency_key, kind, provider, session_id, workspace_id, cwd, text,
  material_ids_json, state, created_at, updated_at, error
) VALUES (
  'command-snapshot', 'idem-snapshot', 'follow_up', 'codex', 'session-snapshot',
  'project-snapshot', '/fixture/snapshot', '继续', '["material_snapshot_001"]',
  'queued', '2026-09-01T12:03:00.000Z', '2026-09-01T12:03:00.000Z', NULL
);

INSERT INTO devices(
  id, name, key_base64, created_at, last_seen_at, revoked_at,
  is_local_admin, can_approve, can_manage_trust
) VALUES (
  'device-local-snapshot', 'Fixture Mac', 'fixture-key',
  '2026-09-01T09:00:00.000Z', '2026-09-01T12:00:00.000Z', NULL, 1, 1, 1
);
INSERT INTO feed_seen(device_id, post_id, seen_at)
VALUES ('device-local-snapshot', 'post-snapshot', '2026-09-01T12:06:00.000Z');
INSERT INTO feed_dismissed(device_id, item_id, dismissed_at)
VALUES ('device-local-snapshot', 'post:old', '2026-09-01T12:06:00.000Z');
INSERT INTO task_timeline_cursors(device_id, session_id, item_id, seen_at)
VALUES ('device-local-snapshot', 'session-snapshot', 'event:event-snapshot', '2026-09-01T12:06:00.000Z');
INSERT INTO task_preferences(session_id, pinned_at, archived_at)
VALUES ('session-snapshot', '2026-09-01T12:07:00.000Z', NULL);

INSERT INTO actions(
  action_id, session_id, upstream_request_id, kind, title, detail, decisions_json,
  expires_at, state, created_at, resolved_at, approval_context_json
) VALUES (
  'action-snapshot', 'session-snapshot', 'request-snapshot', 'approval',
  '允许运行测试', 'cargo test',
  '[{"id":"allow-once","label":"允许一次","scope":"once","value":true,"risk":"low"}]',
  '2030-09-01T12:10:00.000Z', 'pending', '2026-09-01T12:04:00.000Z', NULL,
  '{"category":"test","projectId":"project-snapshot","cwd":"/fixture/snapshot","command":"cargo test","segments":["cargo test"],"withinProject":true,"reason":"运行测试"}'
);
INSERT INTO project_trust_policies(
  project_id, preset, auto_allow_json, updated_at, updated_by_device_id
) VALUES (
  'project-snapshot', 'safe_automation', '["read","search","test","build"]',
  '2026-09-01T12:08:00.000Z', 'device-local-snapshot'
);
INSERT INTO trust_audit(
  id, project_id, session_id, device_id, category, decision, reason,
  action_summary, created_at
) VALUES (
  'audit-snapshot', 'project-snapshot', 'session-snapshot', 'device-local-snapshot',
  'test', 'auto_allowed', '安全自动化', 'cargo test', '2026-09-01T12:09:00.000Z'
);
INSERT INTO notification_settings(
  device_id, enabled, approvals, results, failures, critical_only,
  quiet_hours_enabled, timezone_offset_minutes, show_task_title, updated_at
) VALUES (
  'device-local-snapshot', 1, 1, 1, 1, 0, 1, 480, 1,
  '2026-09-01T12:10:00.000Z'
);
INSERT INTO push_devices(
  device_id, platform, endpoint, public_key, active, environment, registered_at, updated_at
) VALUES (
  'device-local-snapshot', 'ios', 'fixture-endpoint', 'fixture-public-key', 1,
  'development', '2026-09-01T11:00:00.000Z', '2026-09-01T12:00:00.000Z'
);
INSERT INTO push_delivery_status(device_id, kind, status, attempted_at)
VALUES ('device-local-snapshot', 'result', 200, '2026-09-01T12:11:00.000Z');
