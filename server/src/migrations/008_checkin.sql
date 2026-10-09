-- Check-ins: a short "just checking in" call to Pete (PERSONAL_OK_NUMBERS, Pete agent only). One ring of
-- CHECKIN_RING_S, no redial, a machine is hung up on without a message. Window, daily cap and gaps: safety.ts.
ALTER TABLE calls ADD COLUMN checkin INTEGER NOT NULL DEFAULT 0;
