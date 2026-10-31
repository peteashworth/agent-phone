-- Nicknames / relationship labels for a contact ("sister, Steph"), comma-separated. place_call can take a name or
-- one of these instead of a number. Admin/CLI only (audited): a label decides who a word dials, so agents can't set it.
ALTER TABLE contacts ADD COLUMN label TEXT NOT NULL DEFAULT '';
