-- Milestone C: answering-machine detection, post-call transcript/summary/recording, real costs.

ALTER TABLE calls ADD COLUMN amd INTEGER NOT NULL DEFAULT 0;   -- answering-machine detection requested on this call
ALTER TABLE calls ADD COLUMN answered_by TEXT;                 -- Twilio AnsweredBy (human, machine_start, fax, unknown) or 'timeout'
ALTER TABLE calls ADD COLUMN amd_at TEXT;

ALTER TABLE calls ADD COLUMN summary_title TEXT;               -- from the ElevenLabs post-call analysis
ALTER TABLE calls ADD COLUMN summary TEXT;
ALTER TABLE calls ADD COLUMN transcript TEXT;                  -- JSON [{role:'agent'|'user', text, t}] (t = seconds into the call)
ALTER TABLE calls ADD COLUMN el_cost_credits INTEGER;
ALTER TABLE calls ADD COLUMN twilio_price_usd REAL;            -- positive; Twilio reports it as negative, some minutes after the call
ALTER TABLE calls ADD COLUMN finalized_at TEXT;                -- post-call fetch done (or given up)
ALTER TABLE calls ADD COLUMN finalize_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE calls ADD COLUMN recording_path TEXT;              -- relative to DATA_DIR
ALTER TABLE calls ADD COLUMN recording_bytes INTEGER;
ALTER TABLE calls ADD COLUMN recording_deleted_at TEXT;        -- retention purge

CREATE INDEX calls_unfinalized ON calls(ended_at) WHERE finalized_at IS NULL AND dry_run = 0;
