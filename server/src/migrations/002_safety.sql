-- Milestone B: confirm-before-dial, per-contact timezone, cost tracking, hard-stop hangups.

ALTER TABLE contacts ADD COLUMN tz TEXT;                 -- IANA zone for calling hours; NULL = must fit every continental US zone

ALTER TABLE calls ADD COLUMN confirm_hash TEXT;          -- sha256 of the confirm token (awaiting_confirmation only)
ALTER TABLE calls ADD COLUMN confirm_expires_at TEXT;
ALTER TABLE calls ADD COLUMN confirmed_by TEXT;
ALTER TABLE calls ADD COLUMN hangup_requested_at TEXT;   -- server asked Twilio to end the call (hard stop / watchdog)
ALTER TABLE calls ADD COLUMN cost_usd REAL;              -- actual cost once known (Milestone C); else estimated from duration
CREATE UNIQUE INDEX calls_confirm ON calls(confirm_hash) WHERE confirm_hash IS NOT NULL;
