// Preflight rules for dialing. Pure functions over (config, db, now) so they can run both at place_call and again at
// confirm_call / dial time.
import type { Config } from './config.ts'
import { type DB, one, all } from './db.ts'

export type Refusal = { code: string; message: string }

/** Hour (0-23) in a zone. */
export function localHour(tz: string, at: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(at))
}

/** Local YYYY-MM-DD in a zone. */
export function localDate(tz: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

// Unknown destination zone: the window must hold at both ends of the continental US (so also everything in between).
const US_SPAN = ['America/New_York', 'America/Los_Angeles']

export function checkHours(c: Config, tz: string | null, at: Date): Refusal | null {
  const zones = tz ? [tz] : US_SPAN
  const bad = zones.find(z => { const h = localHour(z, at); return h < c.CALL_HOURS_START || h >= c.CALL_HOURS_END })
  if (!bad) return null
  return {
    code: 'outside_calling_hours',
    message: `It's ${localHour(bad, at)}:00 in ${bad}; calls are allowed ${c.CALL_HOURS_START}:00-${c.CALL_HOURS_END}:00 local` +
      (tz ? '' : ' (destination time zone unknown, so the window must fit both US coasts; set the contact\'s tz to narrow it)'),
  }
}

type CostRow = { created_at: string; status: string; duration_s: number | null; max_seconds: number; cost_usd: number | null }
const LIVE = new Set(['warming', 'queued', 'initiated', 'ringing', 'in-progress'])

/** Actual cost if known; else billed minutes x rate; live calls reserve their worst case. */
export function callCost(c: Config, r: CostRow): number {
  if (r.cost_usd != null) return r.cost_usd
  if (LIVE.has(r.status)) return (r.max_seconds / 60) * c.COST_PER_MIN_USD
  return r.duration_s ? Math.ceil(r.duration_s / 60) * c.COST_PER_MIN_USD : 0
}

export function spend(c: Config, db: DB, at: Date, exceptId = ''): { day: number; month: number } {
  const since = new Date(at.getTime() - 32 * 86400_000).toISOString()
  const rows = all<CostRow>(db,
    'SELECT created_at, status, duration_s, max_seconds, cost_usd FROM calls WHERE dry_run = 0 AND created_at >= ? AND id != ?', since, exceptId)
  const today = localDate(c.BILLING_TZ, at), month = today.slice(0, 7)
  let day = 0, mon = 0
  for (const r of rows) {
    const d = localDate(c.BILLING_TZ, new Date(r.created_at)), cost = callCost(c, r)
    if (d === today) day += cost
    if (d.startsWith(month)) mon += cost
  }
  return { day: round(day), month: round(mon) }
}

export function checkSpend(c: Config, db: DB, at: Date, exceptId = ''): Refusal | null {
  const s = spend(c, db, at, exceptId), reserve = (c.MAX_CALL_SECONDS / 60) * c.COST_PER_MIN_USD
  if (s.day + reserve > c.SPEND_CAP_DAY_USD)
    return { code: 'spend_cap_day', message: `Daily cap $${c.SPEND_CAP_DAY_USD}: spent ~$${s.day}, a call reserves up to $${round(reserve)}` }
  if (s.month + reserve > c.SPEND_CAP_MONTH_USD)
    return { code: 'spend_cap_month', message: `Monthly cap $${c.SPEND_CAP_MONTH_USD}: spent ~$${s.month}, a call reserves up to $${round(reserve)}` }
  return null
}

export function checkLiveCall(db: DB, exceptId = ''): Refusal | null {
  const live = one<{ id: string }>(db,
    `SELECT id FROM calls WHERE dry_run = 0 AND id != ? AND status IN (${[...LIVE].map(s => `'${s}'`).join(',')}) LIMIT 1`, exceptId)
  return live ? { code: 'call_in_progress', message: `Another call is still active (${live.id}); one call at a time` } : null
}

export function checkDestination(c: Config, db: DB, to: string): Refusal | null {
  if (one(db, 'SELECT 1 FROM contacts WHERE e164 = ? AND do_not_call = 1', to))
    return { code: 'do_not_call', message: `${to} is on the do-not-call list` }
  // The allowlist: an explicit per-contact flag, set by Pete (dashboard admin key or CLI). No wildcards.
  if (!one(db, 'SELECT 1 FROM contacts WHERE e164 = ? AND allowed = 1', to))
    return { code: 'destination_not_allowed', message: `${to} is not on the allowed list (Pete can allow it on the dashboard Calls page)` }
  return null
}

/** Everything that must hold at the moment we dial. Dry runs skip the live-call and spend checks (they cost nothing). */
export function dialChecks(c: Config, db: DB, to: string, dry: boolean, at: Date, exceptId = ''): Refusal | null {
  const tz = one<{ tz: string | null }>(db, 'SELECT tz FROM contacts WHERE e164 = ?', to)?.tz ?? null
  return checkDestination(c, db, to) ?? checkHours(c, tz, at) ?? (dry ? null : checkLiveCall(db, exceptId) ?? checkSpend(c, db, at, exceptId))
}

const round = (n: number) => Math.round(n * 100) / 100
