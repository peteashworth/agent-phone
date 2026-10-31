import { type DB, one, all, run, audit, tx } from './db.ts'
import { toE164 } from './phone.ts'
import { MAX_ALLOWED } from './settings.ts'

export type Contact = {
  e164: string; name: string; trusted: number; do_not_call: number; inbound_allowed: number; allowed: number; known: number; label: string
  notes: string; tz: string | null; created_at: string; updated_at: string
}
export type ContactPatch = {
  name?: string; notes?: string; trusted?: boolean; do_not_call?: boolean; inbound_allowed?: boolean; tz?: string | null; allowed?: boolean
}
const PATCHABLE = new Set(['name', 'notes', 'trusted', 'do_not_call', 'inbound_allowed', 'tz', 'allowed'])

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

/** Field-level patch. Callers decide which fields an actor may touch (agents can't set trusted/inbound_allowed/allowed). */
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

export type AdminContactPatch = { name?: string; label?: string; notes?: string; tz?: string | null; allowed?: boolean; trusted?: boolean; inbound_allowed?: boolean; known?: boolean; do_not_call?: true }
const ADMIN_FIELDS = ['name', 'label', 'notes', 'tz', 'allowed', 'trusted', 'inbound_allowed', 'known', 'do_not_call'] as const

/**
 * Pete's edits from the dashboard (admin key). Adds the contact if it's new (name required). Enforces the allowlist
 * ceiling, never clears do-not-call (CLI only), and writes one audit line per changed field: {field, old, new}.
 */
export function adminSetContact(db: DB, actor: string, phone: string, patch: AdminContactPatch): Contact {
  const e164 = normalizeOrThrow(phone)
  if ((patch as { do_not_call?: unknown }).do_not_call === false) throw new Error('Removing do-not-call is CLI-only (contact:set <phone> do_not_call 0 on the droplet)')
  if (patch.tz) patch = { ...patch, tz: validTz(patch.tz) }
  if (patch.label !== undefined) patch = { ...patch, label: cleanLabel(patch.label) }
  return tx(db, () => {
    let old = getContact(db, e164)
    if (!old) {
      if (!patch.name?.trim()) throw new Error('A new contact needs a name')
      run(db, 'INSERT INTO contacts (e164, name) VALUES (?, ?)', e164, patch.name.trim())
      audit(db, actor, 'admin.contact.add', e164, { name: patch.name.trim() })
      old = getContact(db, e164)!
    }
    if (patch.allowed && !old.allowed) {
      const n = one<{ n: number }>(db, 'SELECT count(*) AS n FROM contacts WHERE allowed = 1')!.n
      if (n >= MAX_ALLOWED) throw new Error(`The allowed list is full (${MAX_ALLOWED}); un-allow someone first`)
    }
    for (const f of ADMIN_FIELDS) {
      const v = patch[f]
      if (v === undefined) continue
      const nv = typeof v === 'boolean' ? Number(v) : f === 'name' && typeof v === 'string' ? v.trim() : v
      if (old[f] === nv) continue
      run(db, `UPDATE contacts SET ${f} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE e164 = ?`, nv, e164)
      audit(db, actor, 'admin.contact.set', e164, { field: f, old: old[f], new: nv })
    }
    return getContact(db, e164)!
  })
}

/** "Sister,  steph ,," -> "Sister, steph". Each entry is a nickname or relationship that place_call can resolve. */
export function cleanLabel(label: string): string {
  const parts = label.split(',').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean)
  if (parts.some(x => x.length > 40)) throw new Error('Each label entry must be 40 characters or less')
  if (parts.some(x => /\d/.test(x))) throw new Error('Label entries can\'t contain digits (they would look like phone numbers)')
  return [...new Set(parts)].join(', ')
}

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Contacts a spoken name could mean: the full name, any one word of it ("Stephanie" for "Stephanie Ashworth"), or a
 * label entry ("sister"). Case and punctuation are ignored; a leading "my" is dropped ("my sister"). Exact words only,
 * no prefixes or fuzzy matching, so a typo finds nobody rather than the wrong person.
 */
export function matchContacts(db: DB, query: string): Contact[] {
  const q = words(query).replace(/^my /, '')
  if (!q) return []
  return listContacts(db).filter(c => {
    const name = words(c.name)
    return name === q || name.split(' ').includes(q) || c.label.split(',').some(l => words(l) === q)
  })
}

export class ContactLookupError extends Error {
  code: 'unknown_contact' | 'ambiguous_contact'
  constructor(code: ContactLookupError['code'], message: string) { super(message); this.code = code }
}

/**
 * The one contact a name means. Opted-out rows only count when nothing else matches (then the do-not-call check
 * refuses the call as usual). Resolving never decides whether a call may happen: the number goes through the exact
 * same checks as if it had been typed.
 */
export function resolveContact(db: DB, query: string): Contact {
  const all = matchContacts(db, query)
  const live = all.filter(c => !c.do_not_call)
  const hits = live.length ? live : all
  if (!hits.length) throw new ContactLookupError('unknown_contact', `No contact matches "${query.trim()}". Use list_contacts to see names and labels, or give the number.`)
  if (hits.length > 1) throw new ContactLookupError('ambiguous_contact', `"${query.trim()}" matches ${hits.length} contacts: ` +
    hits.map(c => `${c.name}${c.label ? ` (${c.label})` : ''} ${c.e164}`).join('; ') + '. Use the full name or the number.')
  return hits[0]
}
