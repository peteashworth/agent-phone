-- Known contacts get a shorter opener with their first name (src/voice/lines.ts openerFor). Admin/CLI only, audited.
-- The recording notice stays in every opener.
ALTER TABLE contacts ADD COLUMN known INTEGER NOT NULL DEFAULT 0;
