-- Inbound calls from Pete (PERSONAL_OK_NUMBERS + inbound_allowed) to our owned number, through the Pete agent.
-- For inbound rows to_e164 is still "the other party" (the caller) and from_e164 is our number, so every per-person
-- rule (code phrase, tier, DNC, check-in gaps) reads the same column either way.
ALTER TABLE calls ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound';
-- Owner of inbound rows (calls.agent_id): nobody placed them.
INSERT OR IGNORE INTO agents (id, name) VALUES ('inbound', 'Inbound calls');
