// place_call and the call record. Every guard here runs server-side; callers can't opt out of them.
import { randomBytes } from 'node:crypto'
import type { Config } from './config.ts'
import { type DB, one, all, run, audit } from './db.ts'
import { toE164 } from './phone.ts'
import { fromFor, type NumberRow } from './numbers.ts'
import type { ElevenLabsClient } from './voice/elevenlabs.ts'
import type { TwilioClient } from './voice/twilio.ts'

export type Deps = { config: Config; db: DB; elevenlabs: ElevenLabsClient; twilio: TwilioClient }

export type PlaceCallInput = { to: string; purpose: string; brief: string; plan?: string; dry_run?: boolean }

export type CallRow = {
  id: string; agent_id: string; to_e164: string; from_e164: string; from_label: string
  purpose: string; brief: string; plan: string | null; dry_run: number; status: string
  end_reason: string | null; error: string | null; created_at: string; started_at: string | null
  ended_at: string | null; duration_s: number | null; max_seconds: number
  twilio_sid: string | null; el_conversation_id: string | null
}

/** A refusal the caller should see verbatim (not a server fault). */
export class CallRefused extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

export const LIVE_STATUSES = ['queued', 'initiated', 'ringing', 'in-progress'] as const
const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled'])

export async function placeCall(d: Deps, agentId: string, input: PlaceCallInput): Promise<CallRow> {
  const { config: c, db } = d
  const refuse = (code: string, msg: string, target: string | null): never => {
    audit(db, agentId, 'call.refused', target, { code, msg, purpose: input.purpose })
    throw new CallRefused(code, msg)
  }

  const to = toE164(input.to) ?? refuse('invalid_number', `Not a valid phone number: ${input.to}`, null)
  if (!input.purpose.trim() || !input.brief.trim()) refuse('missing_fields', 'purpose and brief are required', to)

  const contact = one<{ do_not_call: number }>(db, 'SELECT do_not_call FROM contacts WHERE e164 = ?', to)
  if (contact?.do_not_call) refuse('do_not_call', `${to} is on the do-not-call list`, to)

  if (!c.ALLOWED_DESTINATIONS.includes('*') && !c.ALLOWED_DESTINATIONS.includes(to))
    refuse('destination_not_allowed', `Calls to ${to} are not allowed yet (allowed: ${c.ALLOWED_DESTINATIONS.join(', ')})`, to)

  let from: NumberRow
  try { from = fromFor(db, to) } catch (e) { return refuse('no_caller_id', (e as Error).message, to) }

  // Real dial needs both the server switch and an explicit dry_run:false from the caller.
  const dry = input.dry_run !== false || !c.DIALING_ENABLED

  if (!dry) {
    const live = one<{ id: string }>(db,
      `SELECT id FROM calls WHERE dry_run = 0 AND status IN (${LIVE_STATUSES.map(() => '?').join(',')}) LIMIT 1`, ...LIVE_STATUSES)
    if (live) refuse('call_in_progress', `Another call is still active (${live.id}); one call at a time`, to)
  }

  const id = 'call_' + randomBytes(9).toString('base64url')
  run(db, `INSERT INTO calls (id, agent_id, to_e164, from_e164, from_label, purpose, brief, plan, dry_run, status, max_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, agentId, to, from.e164, from.label, input.purpose, input.brief, input.plan ?? null, dry ? 1 : 0,
    dry ? 'dry_run' : 'queued', c.MAX_CALL_SECONDS)
  audit(db, agentId, dry ? 'call.dry_run' : 'call.place', id, { to, from: from.label })
  if (dry) {
    event(db, id, 'server', 'dry_run', { reason: input.dry_run !== false ? 'requested' : 'DIALING_ENABLED=false' })
    return getCall(db, id)!
  }

  try {
    const reg = await d.elevenlabs.registerCall({
      from: from.e164, to,
      dynamicVariables: { call_id: id, purpose: input.purpose, brief: input.brief, plan: input.plan ?? '' },
    })
    run(db, 'UPDATE calls SET el_conversation_id = ? WHERE id = ?', reg.conversationId, id)
    const call = await d.twilio.createCall({
      to, from: from.e164, twiml: reg.twiml, timeLimit: c.MAX_CALL_SECONDS, statusCallback: statusCallbackUrl(c, id),
    })
    run(db, 'UPDATE calls SET twilio_sid = ?, status = ? WHERE id = ?', call.sid, call.status || 'queued', id)
    event(db, id, 'server', 'dialed', { twilio_sid: call.sid, el_conversation_id: reg.conversationId })
  } catch (e) {
    const msg = (e as Error).message
    run(db, `UPDATE calls SET status = 'failed', error = ?, ended_at = ? WHERE id = ?`, msg, now(), id)
    event(db, id, 'server', 'dial_error', { error: msg })
    audit(db, 'system', 'call.dial_error', id, { error: msg })
  }
  return getCall(db, id)!
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
