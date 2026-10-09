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

/** Calls that actually went out (or are going out): a refused, expired or unconfirmed one never rang anything. */
const DIALED = `dry_run = 0 AND (twilio_sid IS NOT NULL OR status IN (${[...LIVE].map(s => `'${s}'`).join(',')}))`

/**
 * Check-in rules on top of the normal ones: pause switch, CHECKIN_TZ window, daily cap, gap since the last check-in,
 * and quiet time after any other call with the number. Missed check-ins count (one ring, no redial).
 */
export function checkCheckin(c: Config, db: DB, to: string, at: Date, exceptId = ''): Refusal | null {
  if (c.CHECKINS_PAUSED) return { code: 'checkins_paused', message: 'Check-in calls are paused (dashboard Limits tab or CLI checkins:resume)' }
  const h = localHour(c.CHECKIN_TZ, at)
  if (h < c.CHECKIN_HOURS_START || h >= c.CHECKIN_HOURS_END)
    return { code: 'outside_checkin_hours', message: `It's ${h}:00 in ${c.CHECKIN_TZ}; check-ins are allowed ${c.CHECKIN_HOURS_START}:00-${c.CHECKIN_HOURS_END}:00` }
  const checkins = all<{ created_at: string }>(db,
    `SELECT created_at FROM calls WHERE to_e164 = ? AND checkin = 1 AND id != ? AND ${DIALED} AND created_at >= ? ORDER BY created_at DESC`,
    to, exceptId, new Date(at.getTime() - 2 * 86400_000).toISOString())
  const today = localDate(c.CHECKIN_TZ, at)
  const n = checkins.filter(r => localDate(c.CHECKIN_TZ, new Date(r.created_at)) === today).length
  if (n >= c.CHECKIN_MAX_PER_DAY)
    return { code: 'checkin_cap', message: `Already ${n} check-in${n === 1 ? '' : 's'} today (max ${c.CHECKIN_MAX_PER_DAY})` }
  const gapMs = c.CHECKIN_MIN_GAP_H * 3600_000
  if (checkins[0] && at.getTime() - Date.parse(checkins[0].created_at) < gapMs)
    return { code: 'checkin_too_soon', message: `Last check-in was at ${checkins[0].created_at}; at least ${c.CHECKIN_MIN_GAP_H}h between check-ins` }
  const recent = one<{ id: string }>(db,
    `SELECT id FROM calls WHERE to_e164 = ? AND checkin = 0 AND id != ? AND ${DIALED} AND COALESCE(ended_at, created_at) >= ? LIMIT 1`,
    to, exceptId, new Date(at.getTime() - c.CHECKIN_QUIET_H * 3600_000).toISOString())
  if (recent) return { code: 'checkin_quiet', message: `Another call with ${to} (${recent.id}) was less than ${c.CHECKIN_QUIET_H}h ago` }
  return null
}

/** Everything that must hold at the moment we dial. Dry runs skip the live-call and spend checks (they cost nothing). */
export function dialChecks(c: Config, db: DB, to: string, dry: boolean, at: Date, exceptId = '', checkin = false): Refusal | null {
  const tz = one<{ tz: string | null }>(db, 'SELECT tz FROM contacts WHERE e164 = ?', to)?.tz ?? null
  // A check-in has its own window (CHECKIN_TZ, 9-21 by default) in place of the general calling hours.
  return checkDestination(c, db, to) ?? (checkin ? checkCheckin(c, db, to, at, exceptId) : checkHours(c, tz, at)) ??
    (dry ? null : checkLiveCall(db, exceptId) ?? checkSpend(c, db, at, exceptId))
}

const round = (n: number) => Math.round(n * 100) / 100
