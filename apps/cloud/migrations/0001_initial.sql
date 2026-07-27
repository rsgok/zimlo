CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  public_key_spki TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE devices (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  apns_token TEXT,
  route_public_key TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, device_id)
);

CREATE INDEX devices_installation_active_idx
  ON devices(installation_id, active, updated_at DESC);

CREATE INDEX devices_access_token_idx
  ON devices(access_token_hash);

CREATE TABLE push_audit (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  collapse_id TEXT NOT NULL,
  status INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX push_audit_created_idx
  ON push_audit(created_at DESC);
