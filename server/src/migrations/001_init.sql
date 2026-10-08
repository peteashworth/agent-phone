-- Phase 1 core tables. Timestamps are ISO-8601 UTC strings.

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,            -- e.g. 'jasmine'
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Bearer keys. Only the sha256 is stored; prefix is for display. scope 'agent' = MCP tools, 'read' = call-log API.
CREATE TABLE agent_keys (
  id          INTEGER PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  scope       TEXT NOT NULL CHECK (scope IN ('agent','read')),
  hash        TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at  TEXT
);

-- Caller IDs we may present. kind: 'owned' (Twilio number) | 'verified' (Verified Caller ID).
CREATE TABLE numbers (
  label       TEXT PRIMARY KEY,            -- 'mobile', 'line'
  e164        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('owned','verified')),
  description TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1
);

-- Server-side caller-ID rule: first match by priority wins. to_e164 NULL = default.
CREATE TABLE from_rules (
  id          INTEGER PRIMARY KEY,
  priority    INTEGER NOT NULL,
  to_e164     TEXT,
  from_label  TEXT NOT NULL REFERENCES numbers(label),
  note        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE contacts (
  e164        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  trusted     INTEGER NOT NULL DEFAULT 0,  -- whitelist: dial without confirm
  do_not_call INTEGER NOT NULL DEFAULT 0,  -- set by opt-out; blocks place_call
  inbound_allowed INTEGER NOT NULL DEFAULT 0, -- may call our owned numbers; everyone else is rejected
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE calls (
  id                  TEXT PRIMARY KEY,    -- 'call_' + random
  agent_id            TEXT NOT NULL REFERENCES agents(id),
  to_e164             TEXT NOT NULL,
  from_e164           TEXT NOT NULL,
  from_label          TEXT NOT NULL,
  purpose             TEXT NOT NULL,
  brief               TEXT NOT NULL,
  plan                TEXT,
  dry_run             INTEGER NOT NULL,
  -- dry_run | queued | ringing | in-progress | completed | busy | no-answer | failed | canceled
  status              TEXT NOT NULL,
  end_reason          TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at          TEXT,
  ended_at            TEXT,
  duration_s          INTEGER,
  max_seconds         INTEGER NOT NULL,
  twilio_sid          TEXT UNIQUE,
  el_conversation_id  TEXT UNIQUE
);
CREATE INDEX calls_created ON calls(created_at DESC);
CREATE INDEX calls_to ON calls(to_e164, created_at DESC);

-- Raw provider status history (Twilio status callbacks etc.).
CREATE TABLE call_events (
  id          INTEGER PRIMARY KEY,
  call_id     TEXT NOT NULL REFERENCES calls(id),
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source      TEXT NOT NULL,               -- 'twilio' | 'elevenlabs' | 'server'
  type        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX call_events_call ON call_events(call_id, id);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor       TEXT NOT NULL,               -- agent id, 'cli', 'system', 'twilio'
  action      TEXT NOT NULL,
  target      TEXT,
  meta        TEXT NOT NULL DEFAULT '{}'
);
