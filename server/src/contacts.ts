import { type DB, one, all, run, audit } from './db.ts'
import { toE164 } from './phone.ts'

export type Contact = {
  e164: string; name: string; trusted: number; do_not_call: number; inbound_allowed: number
  notes: string; tz: string | null; created_at: string; updated_at: string
}
export type ContactPatch = { name?: string; notes?: string; trusted?: boolean; do_not_call?: boolean; inbound_allowed?: boolean; tz?: string | null }
const PATCHABLE = new Set(['name', 'notes', 'trusted', 'do_not_call', 'inbound_allowed', 'tz'])

/** An IANA time zone the runtime knows (e.g. America/Denver), normalised; throws otherwise. */
export function validTz(tz: string): string {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone }
  catch { throw new Error(`Not an IANA time zone: ${tz} (e.g. America/Denver)`) }
}

export function normalizeOrThrow(phone: string): string {
  const e = toE164(phone)
  if (!e) throw new Error(`Not a valid phone number: ${phone}`)
  return e
}

export function getContact(db: DB, phone: string): Contact | undefined {
  return one<Contact>(db, 'SELECT * FROM contacts WHERE e164 = ?', toE164(phone) ?? phone)
}

export function listContacts(db: DB): Contact[] {
  return all<Contact>(db, 'SELECT * FROM contacts ORDER BY name')
}

export function addContact(db: DB, actor: string, phone: string, name: string, notes = ''): Contact {
  const e164 = normalizeOrThrow(phone)
  if (getContact(db, e164)) throw new Error(`Contact ${e164} already exists; use update_contact`)
  run(db, 'INSERT INTO contacts (e164, name, notes) VALUES (?, ?, ?)', e164, name, notes)
  audit(db, actor, 'contact.add', e164, { name })
  return getContact(db, e164)!
}

/** Field-level patch. Callers decide which fields an actor may touch (agents can't set trusted/inbound_allowed). */
export function updateContact(db: DB, actor: string, phone: string, patch: ContactPatch): Contact {
  const e164 = normalizeOrThrow(phone)
  if (!getContact(db, e164)) throw new Error(`No contact ${e164}`)
  if (patch.tz) patch = { ...patch, tz: validTz(patch.tz) }
  const sets: string[] = [], args: (string | number | null)[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !PATCHABLE.has(k)) continue
    sets.push(`${k} = ?`); args.push(typeof v === 'boolean' ? Number(v) : v)
  }
  if (sets.length) {
    run(db, `UPDATE contacts SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE e164 = ?`, ...args, e164)
    audit(db, actor, 'contact.update', e164, patch)
  }
  return getContact(db, e164)!
}

/** Opt-out: works for numbers that aren't contacts yet. Only the CLI can undo it. */
export function setDoNotCall(db: DB, actor: string, phone: string, reason: string): void {
  const e164 = normalizeOrThrow(phone)
  run(db, `INSERT INTO contacts (e164, name, do_not_call, notes) VALUES (?, ?, 1, ?)
           ON CONFLICT(e164) DO UPDATE SET do_not_call = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    e164, 'Unknown (opted out)', `Opted out: ${reason}`)
  audit(db, actor, 'contact.do_not_call', e164, { reason })
}
