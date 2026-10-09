-- Pete manages the allowlist and limits from the dashboard (admin-scope key) instead of /etc/agent-phone.env.

-- agent_keys.scope is a CHECK constraint, so the table is rebuilt to allow 'admin'.
CREATE TABLE agent_keys_new (
  id          INTEGER PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  scope       TEXT NOT NULL CHECK (scope IN ('agent','read','brain','admin')),
  hash        TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at  TEXT
);
INSERT INTO agent_keys_new SELECT id, agent_id, scope, hash, prefix, created_at, revoked_at FROM agent_keys;
DROP TABLE agent_keys;
ALTER TABLE agent_keys_new RENAME TO agent_keys;

-- The allowlist: only contacts with allowed = 1 can be dialed (DIALING_ENABLED is still the master switch).
-- Filled once from the old ALLOWED_DESTINATIONS env on first boot (bootstrapAllowlist), after that admin/CLI only.
ALTER TABLE contacts ADD COLUMN allowed INTEGER NOT NULL DEFAULT 0;

-- Admin overrides of env settings (src/settings.ts). No row = the env value (or its default).
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                  -- JSON
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  TEXT NOT NULL
);

-- One-time markers (e.g. allowlist bootstrap done).
CREATE TABLE meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL,
  at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
