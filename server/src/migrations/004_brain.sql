-- Milestone D: Jasmine as the phone brain (docs/milestone-d-brain.md). Brain-scope keys for the host adapter, the
-- job queue it long-polls, per-call brain/tier/code-phrase state, and per-turn timing.

-- agent_keys.scope is a CHECK constraint, so the table is rebuilt to allow 'brain'.
CREATE TABLE agent_keys_new (
  id          INTEGER PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  scope       TEXT NOT NULL CHECK (scope IN ('agent','read','brain')),
  hash        TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at  TEXT
);
INSERT INTO agent_keys_new SELECT id, agent_id, scope, hash, prefix, created_at, revoked_at FROM agent_keys;
DROP TABLE agent_keys;
ALTER TABLE agent_keys_new RENAME TO agent_keys;

ALTER TABLE calls ADD COLUMN brain TEXT;                                -- canned | openai | jasmine (NULL = config BRAIN at the time)
ALTER TABLE calls ADD COLUMN brief_personal TEXT;                       -- withheld until the code phrase is verified; cleared at finalize
ALTER TABLE calls ADD COLUMN has_brief_personal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN facts TEXT;                                -- JSON: fact ids/topics picked for this call
ALTER TABLE calls ADD COLUMN tier TEXT NOT NULL DEFAULT 'public';       -- public | personal
ALTER TABLE calls ADD COLUMN code_asked INTEGER NOT NULL DEFAULT 0;     -- the brain asked for the code phrase; next user turn is an attempt
ALTER TABLE calls ADD COLUMN code_attempts INTEGER NOT NULL DEFAULT 0;  -- misses (never the text)
ALTER TABLE calls ADD COLUMN notes TEXT;                                -- JSON array of note_for_jasmine strings
ALTER TABLE calls ADD COLUMN brain_seq INTEGER NOT NULL DEFAULT 0;      -- turn jobs sent

CREATE TABLE brain_jobs (
  id           TEXT PRIMARY KEY,                -- job_…
  call_id      TEXT NOT NULL REFERENCES calls(id),
  type         TEXT NOT NULL CHECK (type IN ('call.start','turn','call.end')),
  seq          INTEGER,
  payload      TEXT NOT NULL,                   -- JSON sent to the host (never the code phrase)
  users_upto   INTEGER,                         -- turn jobs: user message count this job covers
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','picked','done','failed','cancelled','expired')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  picked_at    TEXT,
  answered_at  TEXT,
  deadline_at  TEXT NOT NULL,
  result       TEXT,                            -- JSON from the host
  error        TEXT
);
CREATE INDEX brain_jobs_queue ON brain_jobs(status, created_at);
CREATE INDEX brain_jobs_call ON brain_jobs(call_id);

-- One row: when the host adapter last polled (liveness).
CREATE TABLE brain_host (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  agent_id      TEXT NOT NULL,
  last_poll_at  TEXT NOT NULL
);

-- Per-turn latency breakdown. *_ms are milliseconds after the turn request arrived from ElevenLabs.
CREATE TABLE call_turns (
  id            INTEGER PRIMARY KEY,
  call_id       TEXT NOT NULL REFERENCES calls(id),
  started_at    TEXT NOT NULL,
  brain         TEXT NOT NULL,
  kind          TEXT NOT NULL,                  -- brain | hard_stop | voicemail | closing
  job_id        TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,     -- jobs sent (2 = one retry)
  queued_ms     INTEGER,                        -- job created
  picked_ms     INTEGER,                        -- host picked it up
  reply_ms      INTEGER,                        -- host's answer arrived
  filtered_ms   INTEGER,                        -- first sentence of the answer cleared the output filter
  tts_ms        INTEGER,                        -- first answer text written to ElevenLabs (TTS can start)
  filler1_ms    INTEGER,
  filler2_ms    INTEGER,
  done_ms       INTEGER,
  outcome       TEXT,                           -- ok | timeout | barge_in | error | offline | hard_stop | voicemail | closing
  said          TEXT,                           -- what we streamed (fillers included), for interruption detection
  redact_hash   TEXT                            -- sha256 of a user text to redact from the stored transcript (code phrase turns)
);
CREATE INDEX call_turns_call ON call_turns(call_id, id);
