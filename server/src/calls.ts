// place_call / confirm_call and the call record. Every guard here runs server-side; callers can't opt out of them.
import { randomBytes, createHash } from 'node:crypto'
import type { Config } from './config.ts'
import { type DB, one, all, run, audit } from './db.ts'
import { toE164 } from './phone.ts'
import { fromFor } from './numbers.ts'
import { dialChecks } from './safety.ts'
import type { ElevenLabsClient } from './voice/elevenlabs.ts'
import type { TwilioClient } from './voice/twilio.ts'
import type { Brain } from './voice/brain.ts'

export type Deps = { config: Config; db: DB; elevenlabs: ElevenLabsClient; twilio: TwilioClient; clock?: () => Date; brain?: Brain }

export type PlaceCallInput = { to: string; purpose: string; brief: string; plan?: string; dry_run?: boolean }

export type CallRow = {
  id: string; agent_id: string; to_e164: string; from_e164: string; from_label: string
  purpose: string; brief: string; plan: string | null; dry_run: number; status: string
  end_reason: string | null; error: string | null; created_at: string; started_at: string | null
  ended_at: string | null; duration_s: number | null; max_seconds: number
  twilio_sid: string | null; el_conversation_id: string | null
  confirm_hash: string | null; confirm_expires_at: string | null; confirmed_by: string | null
  hangup_requested_at: string | null; cost_usd: number | null
}

/** A refusal the caller should see verbatim (not a server fault). */
export class CallRefused extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

export const LIVE_STATUSES = ['queued', 'initiated', 'ringing', 'in-progress'] as const
const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled'])
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const clock = (d: Deps) => (d.clock ?? (() => new Date()))()

/**
 * Trusted contacts: checks, then dial (or dry run). Everyone else: checks, then 'awaiting_confirmation' with a
 * one-time confirm_token that confirm_call must present (after Pete OKs it) before anything dials.
 */
export async function placeCall(d: Deps, agentId: string, input: PlaceCallInput): Promise<CallRow & { confirm_token?: string }> {
  const { config: c, db } = d
  const refuse = (code: string, msg: string, target: string | null): never => {
    audit(db, agentId, 'call.refused', target, { code, msg, purpose: input.purpose })
    throw new CallRefused(code, msg)
  }

  const to = toE164(input.to) ?? refuse('invalid_number', `Not a valid phone number: ${input.to}`, null)
  if (!input.purpose.trim() || !input.brief.trim()) refuse('missing_fields', 'purpose and brief are required', to)

  let fromLabel = '', fromE164 = ''
  try { ({ label: fromLabel, e164: fromE164 } = fromFor(db, to)) } catch (e) { refuse('no_caller_id', (e as Error).message, to) }

  // Real dial needs both the server switch and an explicit dry_run:false from the caller.
  const dry = input.dry_run !== false || !c.DIALING_ENABLED
  const bad = dialChecks(c, db, to, dry, clock(d))
  if (bad) refuse(bad.code, bad.message, to)

  const trusted = !!one(db, 'SELECT 1 FROM contacts WHERE e164 = ? AND trusted = 1', to)
  const id = 'call_' + randomBytes(9).toString('base64url')
  const token = trusted ? null : 'cfm_' + randomBytes(18).toString('base64url')
  const expires = new Date(clock(d).getTime() + c.CONFIRM_TTL_MIN * 60_000).toISOString()
  run(db, `INSERT INTO calls (id, agent_id, to_e164, from_e164, from_label, purpose, brief, plan, dry_run, status, max_seconds,
                             confirm_hash, confirm_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, agentId, to, fromE164, fromLabel, input.purpose, input.brief, input.plan ?? null, dry ? 1 : 0,
    token ? 'awaiting_confirmation' : 'pending', c.MAX_CALL_SECONDS, token && sha256(token), token && expires)
  audit(db, agentId, 'call.place', id, { to, from: fromLabel, dry, needs_confirmation: !trusted })

  if (token) {
    event(db, id, 'server', 'awaiting_confirmation', { expires_at: expires })
    return { ...getCall(db, id)!, confirm_token: token }
  }
  return startCall(d, id)
}

/** Second step for non-trusted destinations. Re-runs every check, since time has passed. */
export async function confirmCall(d: Deps, agentId: string, token: string): Promise<CallRow> {
  const { db } = d
  const call = one<CallRow>(db, "SELECT * FROM calls WHERE confirm_hash = ? AND status = 'awaiting_confirmation'", sha256(token))
  if (!call) throw new CallRefused('invalid_token', 'Unknown or already-used confirm token')
  if (call.confirm_expires_at! < clock(d).toISOString()) {
    run(db, "UPDATE calls SET status = 'expired', confirm_hash = NULL WHERE id = ?", call.id)
    event(db, call.id, 'server', 'confirmation_expired', {})
    throw new CallRefused('token_expired', 'Confirmation window expired; place the call again')
  }
  run(db, 'UPDATE calls SET confirm_hash = NULL, confirmed_by = ? WHERE id = ?', agentId, call.id)
  audit(db, agentId, 'call.confirm', call.id)
  return startCall(d, call.id)
}

async function startCall(d: Deps, id: string): Promise<CallRow> {
  const { config: c, db } = d
  const call = getCall(db, id)!
  const dry = !!call.dry_run || !c.DIALING_ENABLED
  // Synchronous check-then-claim: nothing awaits between the live-call check and status='queued'.
  const bad = dialChecks(c, db, call.to_e164, dry, clock(d))
  if (bad) {
    run(db, "UPDATE calls SET status = 'refused', error = ? WHERE id = ?", `${bad.code}: ${bad.message}`, id)
    audit(db, call.agent_id, 'call.refused', id, bad)
    throw new CallRefused(bad.code, bad.message)
  }
  if (dry) {
    run(db, "UPDATE calls SET status = 'dry_run', dry_run = 1 WHERE id = ?", id)
    event(db, id, 'server', 'dry_run', { reason: call.dry_run ? 'requested' : 'DIALING_ENABLED=false' })
    return getCall(db, id)!
  }
  run(db, "UPDATE calls SET status = 'queued' WHERE id = ?", id)

  try {
    const reg = await d.elevenlabs.registerCall({
      from: call.from_e164, to: call.to_e164,
      dynamicVariables: { call_id: id, purpose: call.purpose, brief: call.brief, plan: call.plan ?? '' },
    })
    run(db, 'UPDATE calls SET el_conversation_id = ? WHERE id = ?', reg.conversationId, id)
    const tw = await d.twilio.createCall({
      to: call.to_e164, from: call.from_e164, twiml: reg.twiml, timeLimit: call.max_seconds, statusCallback: statusCallbackUrl(c, id),
    })
    run(db, 'UPDATE calls SET twilio_sid = ?, status = ? WHERE id = ?', tw.sid, tw.status || 'queued', id)
    event(db, id, 'server', 'dialed', { twilio_sid: tw.sid, el_conversation_id: reg.conversationId })
  } catch (e) {
    const msg = (e as Error).message
    run(db, `UPDATE calls SET status = 'failed', error = ?, ended_at = ? WHERE id = ?`, msg, now(), id)
    event(db, id, 'server', 'dial_error', { error: msg })
    audit(db, 'system', 'call.dial_error', id, { error: msg })
  }
  return getCall(db, id)!
}

/** Server-enforced hangup (hard stop, watchdog). Waits delayMs so a close line can finish playing. */
export async function hangup(d: Deps, id: string, reason: string, delayMs = 0): Promise<void> {
  const call = getCall(d.db, id)
  if (!call || TERMINAL.has(call.status)) return
  run(d.db, 'UPDATE calls SET end_reason = ?, hangup_requested_at = COALESCE(hangup_requested_at, ?) WHERE id = ?', reason, now(), id)
  event(d.db, id, 'server', 'hangup_requested', { reason, delay_ms: delayMs })
  audit(d.db, 'system', 'call.hangup', id, { reason })
  if (delayMs) await new Promise(r => setTimeout(r, delayMs))
  if (!call.twilio_sid) return
  try { await d.twilio.endCall(call.twilio_sid) } catch (e) {
    event(d.db, id, 'server', 'hangup_error', { error: (e as Error).message }) // watchdog retries
  }
}

const WATCHDOG_GRACE_S = 180, HANGUP_RETRY_S = 30

/**
 * Belt and braces for calls that should be over: Twilio's TimeLimit normally ends them and status callbacks normally
 * tell us. If a live call is past max_seconds + grace, or a requested hangup hasn't landed, ask Twilio and end it.
 */
export async function watchdog(d: Deps): Promise<string[]> {
  const at = clock(d).getTime(), acted: string[] = []
  const live = all<CallRow>(d.db,
    `SELECT * FROM calls WHERE dry_run = 0 AND status IN (${LIVE_STATUSES.map(() => '?').join(',')})`, ...LIVE_STATUSES)
  for (const call of live) {
    const overdue = at - Date.parse(call.created_at) > (call.max_seconds + WATCHDOG_GRACE_S) * 1000
    const stuckHangup = !!call.hangup_requested_at && at - Date.parse(call.hangup_requested_at) > HANGUP_RETRY_S * 1000
    if (!overdue && !stuckHangup) continue
    acted.push(call.id)
    if (!call.twilio_sid) {
      run(d.db, "UPDATE calls SET status = 'failed', error = 'watchdog: never reached Twilio', ended_at = ? WHERE id = ?", now(), call.id)
      event(d.db, call.id, 'server', 'watchdog_failed', {})
      continue
    }
    try {
      const tw = await d.twilio.fetchCall(call.twilio_sid)
      applyTwilioStatus(d.db, call.id,
        { CallSid: call.twilio_sid, CallStatus: tw.status, ...(tw.duration != null ? { CallDuration: String(tw.duration) } : {}) })
      if (TERMINAL.has(tw.status)) continue
      if (!call.end_reason) run(d.db, "UPDATE calls SET end_reason = 'watchdog' WHERE id = ?", call.id)
      event(d.db, call.id, 'server', 'watchdog_hangup', { twilio_status: tw.status, overdue, stuckHangup })
      audit(d.db, 'system', 'call.watchdog', call.id, { twilio_status: tw.status })
      await d.twilio.endCall(call.twilio_sid)
    } catch (e) {
      event(d.db, call.id, 'server', 'watchdog_error', { error: (e as Error).message })
    }
  }
  return acted
}

export function statusCallbackUrl(c: Config, id: string): string {
  const q = new URLSearchParams({ call: id })
  if (!c.TWILIO_AUTH_TOKEN && c.WEBHOOK_TOKEN) q.set('t', c.WEBHOOK_TOKEN)
  return `${c.PUBLIC_BASE_URL}/twilio/status?${q}`
}

/** Applies a Twilio status callback. Returns false if the call is unknown or the CallSid doesn't match. */
export function applyTwilioStatus(db: DB, id: string, p: Record<string, string>): boolean {
  const call = getCall(db, id)
  if (!call || (call.twilio_sid && p.CallSid && call.twilio_sid !== p.CallSid)) return false
  const status = p.CallStatus
  event(db, id, 'twilio', status || 'unknown', p)
  if (!status || TERMINAL.has(call.status)) return true // late/duplicate events are kept as history only
  const at = now()
  if (status === 'in-progress' && !call.started_at) run(db, 'UPDATE calls SET started_at = ? WHERE id = ?', at, id)
  if (TERMINAL.has(status)) {
    const dur = p.CallDuration ? Number(p.CallDuration) : null
    run(db, `UPDATE calls SET status = ?, ended_at = ?, duration_s = ?, end_reason = COALESCE(end_reason, ?),
             twilio_sid = COALESCE(twilio_sid, ?) WHERE id = ?`,
      status, at, dur, status === 'completed' ? 'hangup' : status, p.CallSid ?? null, id)
  } else {
    run(db, 'UPDATE calls SET status = ?, twilio_sid = COALESCE(twilio_sid, ?) WHERE id = ?', status, p.CallSid ?? null, id)
  }
  return true
}

export function getCall(db: DB, id: string): CallRow | undefined {
  return one<CallRow>(db, 'SELECT * FROM calls WHERE id = ?', id)
}

export function listCalls(db: DB, f: { limit?: number; status?: string; to?: string } = {}): CallRow[] {
  const where: string[] = [], args: (string | number)[] = []
  if (f.status) { where.push('status = ?'); args.push(f.status) }
  if (f.to) { where.push('to_e164 = ?'); args.push(toE164(f.to) ?? f.to) }
  const sql = `SELECT * FROM calls ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`
  return all<CallRow>(db, sql, ...args, Math.min(Math.max(f.limit ?? 20, 1), 100))
}

export function callEvents(db: DB, id: string) {
  return all<{ at: string; source: string; type: string }>(db, 'SELECT at, source, type FROM call_events WHERE call_id = ? ORDER BY id', id)
}

function event(db: DB, callId: string, source: string, type: string, data: object) {
  run(db, 'INSERT INTO call_events (call_id, source, type, data) VALUES (?, ?, ?, ?)', callId, source, type, JSON.stringify(data))
}

const now = () => new Date().toISOString()
