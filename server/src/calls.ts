// place_call / confirm_call and the call record. Every guard here runs server-side; callers can't opt out of them.
import { randomBytes, createHash } from 'node:crypto'
import type { Config } from './config.ts'
import { type DB, one, all, run, audit } from './db.ts'
import { toE164 } from './phone.ts'
import { fromFor } from './numbers.ts'
import { dialChecks } from './safety.ts'
import { effective } from './settings.ts'
import type { ElevenLabsClient } from './voice/elevenlabs.ts'
import type { TwilioClient } from './voice/twilio.ts'
import type { Brain } from './voice/brain.ts'
import { loadFacts, pickFacts, factsFor } from './facts.ts'
import { brainOnline, enqueueJob, awaitJob, cancelJob } from './brainJobs.ts'
import { openerFor } from './voice/lines.ts'

export type Deps = { config: Config; db: DB; elevenlabs: ElevenLabsClient; twilio: TwilioClient; clock?: () => Date; brain?: Brain }

export type BrainKind = 'canned' | 'openai' | 'jasmine'
export type PlaceCallInput = {
  to: string; purpose: string; brief: string; plan?: string; dry_run?: boolean
  /** Withheld from every brain until the code phrase is verified on the call (jasmine brain only). */
  brief_personal?: string
  brain?: BrainKind
  /** Fact ids or topics from FACTS_FILE this call may use (share rules still apply). */
  facts?: string[]
}

export type CallRow = {
  id: string; agent_id: string; to_e164: string; from_e164: string; from_label: string
  purpose: string; brief: string; plan: string | null; dry_run: number; status: string
  end_reason: string | null; error: string | null; created_at: string; started_at: string | null
  ended_at: string | null; duration_s: number | null; max_seconds: number
  twilio_sid: string | null; el_conversation_id: string | null
  confirm_hash: string | null; confirm_expires_at: string | null; confirmed_by: string | null
  hangup_requested_at: string | null; cost_usd: number | null
  amd: number; answered_by: string | null; amd_at: string | null
  summary_title: string | null; summary: string | null; transcript: string | null
  el_cost_credits: number | null; twilio_price_usd: number | null; finalized_at: string | null; finalize_attempts: number
  recording_path: string | null; recording_bytes: number | null; recording_deleted_at: string | null
  brain: BrainKind | null; brief_personal: string | null; has_brief_personal: number; facts: string | null; tier: 'public' | 'personal'
  code_asked: number; code_attempts: number; notes: string | null; brain_seq: number
}

/** A refusal the caller should see verbatim (not a server fault). */
export class CallRefused extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

export const LIVE_STATUSES = ['warming', 'queued', 'initiated', 'ringing', 'in-progress'] as const
const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled'])
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const clock = (d: Deps) => (d.clock ?? (() => new Date()))()

/**
 * Trusted contacts: checks, then dial (or dry run). Everyone else: checks, then 'awaiting_confirmation' with a
 * one-time confirm_token that confirm_call must present (after Pete OKs it) before anything dials.
 */
export async function placeCall(d: Deps, agentId: string, input: PlaceCallInput): Promise<CallRow & { confirm_token?: string }> {
  const { db } = d, c = effective(d.config, db)
  const refuse = (code: string, msg: string, target: string | null): never => {
    audit(db, agentId, 'call.refused', target, { code, msg, purpose: input.purpose })
    throw new CallRefused(code, msg)
  }

  const to = toE164(input.to) ?? refuse('invalid_number', `Not a valid phone number: ${input.to}`, null)
  if (!input.purpose.trim() || !input.brief.trim()) refuse('missing_fields', 'purpose and brief are required', to)

  const brain: BrainKind = input.brain ?? c.BRAIN
  if (brain === 'openai' && (!c.BRAIN_URL || !c.BRAIN_MODEL)) refuse('brain_not_configured', 'brain "openai" needs BRAIN_URL and BRAIN_MODEL on the server', to)
  if (input.brief_personal?.trim()) {
    if (brain !== 'jasmine') refuse('brief_personal_needs_jasmine', 'brief_personal is only used with brain "jasmine"', to)
    if (!c.PERSONAL_OK_NUMBERS.includes(to)) refuse('brief_personal_not_allowed', `${to} can never unlock the personal tier, so brief_personal would never be used`, to)
  }
  const factSel = [...new Set(input.facts ?? [])]
  if (factSel.length) {
    let unknown: string[]
    try { unknown = pickFacts(loadFacts(c), factSel).unknown } catch (e) { return refuse('facts_unavailable', (e as Error).message, to) }
    if (unknown.length) refuse('unknown_facts', `No fact with id or topic: ${unknown.join(', ')}`, to)
  }

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
                             confirm_hash, confirm_expires_at, brain, brief_personal, has_brief_personal, facts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, agentId, to, fromE164, fromLabel, input.purpose, input.brief, input.plan ?? null, dry ? 1 : 0,
    token ? 'awaiting_confirmation' : 'pending', c.MAX_CALL_SECONDS, token && sha256(token), token && expires,
    brain, input.brief_personal?.trim() || null, input.brief_personal?.trim() ? 1 : 0, factSel.length ? JSON.stringify(factSel) : null)
  // Fact ids only, never values; brief_personal only as a flag.
  audit(db, agentId, 'call.place', id, { to, from: fromLabel, dry, needs_confirmation: !trusted, brain,
    facts: factSel, has_brief_personal: !!input.brief_personal?.trim() })

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
  const { db } = d, c = effective(d.config, db)
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
  if (call.brain === 'jasmine') {
    if (!brainOnline(c, db)) {
      run(db, "UPDATE calls SET status = 'refused', error = ? WHERE id = ?", 'brain_offline: the host adapter is not polling', id)
      audit(db, call.agent_id, 'call.refused', id, { code: 'brain_offline' })
      throw new CallRefused('brain_offline', 'Jasmine\'s phone brain (host adapter) is offline; nothing was dialed')
    }
    // Claim the line now (one call at a time), dial only once the phone session says it is ready.
    run(db, "UPDATE calls SET status = 'warming' WHERE id = ?", id)
    const job = enqueueJob(db, id, 'call.start', callStartPayload(d, getCall(db, id)!), c.WARM_TIMEOUT_S * 1000)
    event(db, id, 'server', 'warming', { job_id: job.id, timeout_s: c.WARM_TIMEOUT_S })
    const p = warmThenDial(d, id, job.id).finally(() => warming.delete(id))
    warming.set(id, p)
    return getCall(db, id)!
  }
  run(db, "UPDATE calls SET status = 'queued' WHERE id = ?", id)
  await dial(d, id)
  return getCall(db, id)!
}

/** Background warm-ups in flight (tests await these). */
export const warming = new Map<string, Promise<void>>()

/** What the phone session gets before the call: everything public, nothing from brief_personal or code facts. */
export function callStartPayload(d: Deps, call: CallRow) {
  const contact = one<{ name: string | null; trusted: number; known: number }>(d.db, 'SELECT name, trusted, known FROM contacts WHERE e164 = ?', call.to_e164)
  const picked = call.facts ? pickFacts(loadFacts(d.config), JSON.parse(call.facts) as string[]).picked : []
  return {
    callee: { name: contact?.name ?? null, relationship: contact ? (contact.trusted ? 'trusted' : 'contact') : 'unknown' },
    from_label: call.from_label, purpose: call.purpose, brief: call.brief, plan: call.plan,
    facts: factsFor(picked, 'anyone'),
    has_brief_personal: !!call.has_brief_personal,
    disclosure: openerFor(contact), // what the callee heard first
    rules: { max_seconds: call.max_seconds, tier: 'public', style: 'spoken prose, 1-3 sentences, no markdown/emoji/URLs' },
  }
}

async function warmThenDial(d: Deps, id: string, jobId: string): Promise<void> {
  const { config: c, db } = d
  const job = await awaitJob(db, jobId, c.WARM_TIMEOUT_S * 1000)
  const ready = job.status === 'done' && (JSON.parse(job.result ?? '{}') as { ready?: boolean }).ready === true
  const call = getCall(db, id)!
  if (call.status !== 'warming') return // cancelled meanwhile
  if (!ready) {
    cancelJob(db, jobId, 'expired')
    const why = job.status === 'done' ? 'host answered without ready:true' : job.status === 'failed' ? 'host error' : 'no answer in time'
    run(db, "UPDATE calls SET status = 'failed', end_reason = 'brain_not_ready', error = ?, ended_at = ? WHERE id = ?", `brain_not_ready: ${why}`, now(), id)
    event(db, id, 'server', 'brain_not_ready', { job_status: job.status })
    audit(db, 'system', 'call.brain_not_ready', id, { job_status: job.status })
    return
  }
  // Time has passed (up to WARM_TIMEOUT_S): check again before dialing. The live-call check skips this call itself.
  const bad = dialChecks(effective(c, db), db, call.to_e164, false, clock(d), id)
  if (bad) {
    run(db, "UPDATE calls SET status = 'refused', error = ?, ended_at = ? WHERE id = ?", `${bad.code}: ${bad.message}`, now(), id)
    audit(db, call.agent_id, 'call.refused', id, bad)
    return
  }
  event(db, id, 'server', 'brain_ready', { job_id: jobId })
  run(db, "UPDATE calls SET status = 'queued' WHERE id = ?", id)
  await dial(d, id)
}

async function dial(d: Deps, id: string): Promise<void> {
  const { config: c, db } = d
  const call = getCall(db, id)!
  try {
    const reg = await d.elevenlabs.registerCall({
      from: call.from_e164, to: call.to_e164,
      dynamicVariables: { call_id: id, purpose: call.purpose, brief: call.brief, plan: call.plan ?? '' },
    })
    run(db, 'UPDATE calls SET el_conversation_id = ? WHERE id = ?', reg.conversationId, id)
    const tw = await d.twilio.createCall({
      to: call.to_e164, from: call.from_e164, twiml: reg.twiml, timeLimit: call.max_seconds, statusCallback: statusCallbackUrl(c, id),
      ...(c.AMD_ENABLED ? { amd: { callback: webhookUrl(c, 'amd', id), timeoutS: c.AMD_TIMEOUT_S } } : {}),
    })
    if (c.AMD_ENABLED) run(db, 'UPDATE calls SET amd = 1 WHERE id = ?', id)
    run(db, 'UPDATE calls SET twilio_sid = ?, status = ? WHERE id = ?', tw.sid, tw.status || 'queued', id)
    event(db, id, 'server', 'dialed', { twilio_sid: tw.sid, el_conversation_id: reg.conversationId })
  } catch (e) {
    const msg = (e as Error).message
    run(db, `UPDATE calls SET status = 'failed', error = ?, ended_at = ? WHERE id = ?`, msg, now(), id)
    event(db, id, 'server', 'dial_error', { error: msg })
    audit(db, 'system', 'call.dial_error', id, { error: msg })
  }
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
  return webhookUrl(c, 'status', id)
}

export function webhookUrl(c: Config, kind: 'status' | 'amd', id: string): string {
  const q = new URLSearchParams({ call: id })
  if (!c.TWILIO_AUTH_TOKEN && c.WEBHOOK_TOKEN) q.set('t', c.WEBHOOK_TOKEN)
  return `${c.PUBLIC_BASE_URL}/twilio/${kind}?${q}`
}

/** Applies a Twilio status callback. Returns false if the call is unknown or the CallSid doesn't match. */
export function applyTwilioStatus(db: DB, id: string, p: Record<string, string>): boolean {
  const call = getCall(db, id)
  if (!call || (call.twilio_sid && p.CallSid && call.twilio_sid !== p.CallSid)) return false
  const status = p.CallStatus
  event(db, id, 'twilio', status || 'unknown', p)
  if (!status || TERMINAL.has(call.status)) {
    // Late/duplicate events are kept as history only, but a late duration still counts.
    if (p.CallDuration && !call.duration_s && Number(p.CallDuration) > 0) run(db, 'UPDATE calls SET duration_s = ? WHERE id = ?', Number(p.CallDuration), id)
    return true
  }
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

export function event(db: DB, callId: string, source: string, type: string, data: object) {
  run(db, 'INSERT INTO call_events (call_id, source, type, data) VALUES (?, ?, ?, ?)', callId, source, type, JSON.stringify(data))
}

const now = () => new Date().toISOString()
