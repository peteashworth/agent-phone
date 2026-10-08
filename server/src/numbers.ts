// Caller-ID selection. Server-side only: callers never pick the From number.
import { type DB, all, one } from './db.ts'

export type NumberRow = { label: string; e164: string; kind: 'owned' | 'verified'; description: string; active: number }

export function listNumbers(db: DB): NumberRow[] {
  return all<NumberRow>(db, 'SELECT * FROM numbers ORDER BY label')
}

/** First from_rule (by priority) whose to_e164 matches the destination, or the default (to_e164 NULL). */
export function fromFor(db: DB, to: string): NumberRow {
  const n = one<NumberRow>(db, `
    SELECT n.* FROM from_rules r JOIN numbers n ON n.label = r.from_label
    WHERE (r.to_e164 = ? OR r.to_e164 IS NULL) AND n.active = 1
    ORDER BY r.priority, r.id LIMIT 1`, to)
  if (!n) throw new Error('No caller-ID rule matches and no active default number is configured')
  if (n.e164 === to) throw new Error(`Caller-ID rule picked ${n.label} (${n.e164}), which is the destination itself`)
  return n
}

/** Inbound allow-list: only contacts flagged inbound_allowed may reach our owned numbers. */
export function inboundAllowed(db: DB, from: string): boolean {
  return !!one(db, 'SELECT 1 FROM contacts WHERE e164 = ? AND inbound_allowed = 1', from)
}
