// Limits Pete can change from the dashboard (admin key). A saved value overrides the env; no row = env (or its default).
// The bounds here are the hard ceiling: neither the dashboard nor anyone else can save past them. Everything not listed
// (DIALING_ENABLED, secrets, code phrase, terms, brain, cost rates) stays env-only.
import { z } from 'zod'
import type { Config } from './config.ts'
import { type DB, all, one, run, audit, tx } from './db.ts'
import { toE164 } from './phone.ts'

export const SETTINGS = {
  MAX_CALL_SECONDS: { label: 'Max call length (seconds)', schema: z.number().int().min(30).max(600) },
  SPEND_CAP_DAY_USD: { label: 'Daily spend cap (USD)', schema: z.number().min(0).max(20) },
  SPEND_CAP_MONTH_USD: { label: 'Monthly spend cap (USD)', schema: z.number().min(0).max(100) },
  CALL_HOURS_START: { label: 'Calling hours start (local hour)', schema: z.number().int().min(7).max(21) },
  CALL_HOURS_END: { label: 'Calling hours end (local hour, exclusive)', schema: z.number().int().min(8).max(22) },
  CONFIRM_TTL_MIN: { label: 'Confirmation expires after (minutes)', schema: z.number().int().min(1).max(120) },
  CHECKINS_PAUSED: { label: 'Pause check-in calls', schema: z.boolean() },
  VOICEMAIL_LINE: { label: 'Voicemail line', schema: z.string().trim().min(1).max(200).regex(/^[^\r\n]*$/, 'one line') },
} as const
export type SettingKey = keyof typeof SETTINGS
type Row = { key: string; value: string; updated_at: string; updated_by: string }

/** Most allowed contacts there can ever be (code ceiling, not a setting). */
export const MAX_ALLOWED = 25

/** The config with saved overrides applied. Read per use (no restart needed); a bad row falls back to the env value. */
export function effective(c: Config, db: DB): Config {
  const out = { ...c } as Record<string, unknown>
  for (const r of all<Row>(db, 'SELECT key, value FROM settings')) {
    const spec = SETTINGS[r.key as SettingKey]
    const v = spec?.schema.safeParse(JSON.parse(r.value))
    if (v?.success) out[r.key] = v.data
  }
  // Never an empty window, whatever mix of env and saved values.
  if ((out.CALL_HOURS_END as number) <= (out.CALL_HOURS_START as number)) {
    out.CALL_HOURS_START = c.CALL_HOURS_START; out.CALL_HOURS_END = c.CALL_HOURS_END
  }
  return out as Config
}

/** For the dashboard: each setting's value now, where it comes from, the env value and the bounds. */
export function describeSettings(c: Config, db: DB) {
  const rows = new Map(all<Row>(db, 'SELECT * FROM settings').map(r => [r.key, r]))
  const eff = effective(c, db) as Record<string, unknown>
  return Object.entries(SETTINGS).map(([key, spec]) => {
    const r = rows.get(key), { minimum, maximum } = bounds(spec.schema)
    return {
      key, label: spec.label, value: eff[key], env_value: (c as Record<string, unknown>)[key],
      source: r ? 'dashboard' : 'env', updated_at: r?.updated_at ?? null, updated_by: r?.updated_by ?? null,
      type: spec.schema.type, min: minimum, max: maximum, // max = length for text
    }
  })
}

function bounds(s: z.ZodType): { minimum: number | null; maximum: number | null } {
  const j = z.toJSONSchema(s) as { minimum?: number; maximum?: number; minLength?: number; maxLength?: number }
  return { minimum: j.minimum ?? j.minLength ?? null, maximum: j.maximum ?? j.maxLength ?? null }
}

export class SettingError extends Error {}

/**
 * Saves (value) or resets to env (null) each key. All or nothing; one audit line per key that actually changed.
 * Throws SettingError on an unknown key, an out-of-bounds value, or an empty calling window.
 */
export function saveSettings(c: Config, db: DB, actor: string, patch: Record<string, unknown>): void {
  const parsed: [SettingKey, unknown][] = []
  for (const [key, raw] of Object.entries(patch)) {
    const spec = SETTINGS[key as SettingKey]
    if (!spec) throw new SettingError(`Unknown or env-only setting: ${key}`)
    if (raw === null) { parsed.push([key as SettingKey, null]); continue }
    const v = spec.schema.safeParse(raw)
    if (!v.success) throw new SettingError(`${spec.label}: ${v.error.issues.map(i => i.message).join('; ')}`)
    parsed.push([key as SettingKey, v.data])
  }
  tx(db, () => {
    const before = rawMerged(c, db), had = new Set(all<Row>(db, 'SELECT key FROM settings').map(r => r.key))
    for (const [key, v] of parsed) {
      if (v === null) { if (had.has(key)) run(db, 'DELETE FROM settings WHERE key = ?', key) }
      else run(db, `INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`, key, JSON.stringify(v), actor)
    }
    // Check the window on the raw result: effective() would quietly fall back, but a save must say no.
    const after = rawMerged(c, db)
    if ((after.CALL_HOURS_END as number) <= (after.CALL_HOURS_START as number))
      throw new SettingError(`Calling hours end (${after.CALL_HOURS_END}) must be after start (${after.CALL_HOURS_START})`)
    for (const [key, v] of parsed) {
      // Unchanged value and unchanged source (saved vs env) = nothing to log.
      if (before[key] === after[key] && had.has(key) === (v !== null)) continue
      audit(db, actor, v === null ? 'admin.setting.reset' : 'admin.setting.set', key, { field: key, old: before[key], new: after[key] })
    }
  })
}


function rawMerged(c: Config, db: DB): Record<string, unknown> {
  const out = { ...c } as Record<string, unknown>
  for (const r of all<Row>(db, 'SELECT key, value FROM settings')) if (r.key in SETTINGS) out[r.key] = JSON.parse(r.value)
  return out
}

/**
 * One-time: seeds contacts.allowed from the old ALLOWED_DESTINATIONS env (unset = Pete only, its old default). Missing
 * contacts are created. Entries that aren't phone numbers (e.g. "*") are skipped: there are no wildcards. Returns what
 * it did, or null if it already ran.
 */
export function bootstrapAllowlist(c: Config, db: DB): { allowed: string[]; skipped: string[] } | null {
  if (one(db, "SELECT 1 FROM meta WHERE key = 'allowlist_bootstrap'")) return null
  const raw = c.ALLOWED_DESTINATIONS ?? '+14358403707'
  const allowed: string[] = [], skipped: string[] = []
  tx(db, () => {
    for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
      const e164 = /^\+?[\d\s().-]+$/.test(entry) ? toE164(entry) : null
      if (!e164 || allowed.length >= MAX_ALLOWED) { skipped.push(entry); continue }
      run(db, `INSERT INTO contacts (e164, name, allowed) VALUES (?, ?, 1)
        ON CONFLICT(e164) DO UPDATE SET allowed = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        e164, 'Imported from ALLOWED_DESTINATIONS')
      allowed.push(e164)
    }
    run(db, "INSERT INTO meta (key, value) VALUES ('allowlist_bootstrap', ?)", JSON.stringify({ allowed, skipped }))
    audit(db, 'system', 'allowlist.bootstrap', null, { allowed, skipped })
  })
  return { allowed, skipped }
}
