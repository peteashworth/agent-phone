-- Pete tier: calls to/from PERSONAL_OK_NUMBERS go through the separate "Jasmine Phone — Pete" ElevenLabs agent
-- (recording off, no recording notice). The droplet keeps metadata only: no transcript, summary or audio, the
-- ElevenLabs conversation is deleted after the call, and spoken text (call_turns.said, brain job payloads/results,
-- brief/plan/notes) is scrubbed once finalized (+ PERSONAL_RETENTION_HOURS).
ALTER TABLE calls ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calls ADD COLUMN el_agent_id TEXT;
ALTER TABLE calls ADD COLUMN el_deleted_at TEXT;
ALTER TABLE calls ADD COLUMN scrubbed_at TEXT;
