// Inbound calls to our owned number. Only Pete's numbers (PERSONAL_OK_NUMBERS + contact inbound_allowed) are put
// through, to the Pete agent, with the same opener, code phrase and tier rules as his outbound calls. Everyone else
// hears NO_INCOMING_LINE (or is rejected) and never reaches ElevenLabs or the brain.
import { randomBytes } from 'node:crypto'
import { type Deps, getCall, event, hangup, callStartPayload } from './calls.ts'
import { audit, one, run } from './db.ts'
import { toE164 } from './phone.ts'
import { inboundAllowed } from './numbers.ts'
import { checkLiveCall, checkSpend } from './safety.ts'
import { effective } from './settings.ts'
import { brainOnline, enqueueJob, awaitJob, cancelJob } from './brainJobs.ts'
import { NO_INCOMING_LINE, PETE_UNAVAILABLE_LINE } from './voice/lines.ts'

type Form = Record<string, string>

const xml = (s: string) => s.replace(/[<>&'"]/g, ch => `&#${ch.charCodeAt(0)};`)
export const sayTwiml = (line: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(line)}</Say><Hangup/></Response>`
export const REJECT_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>'

/** Max-length timers for inbound calls (no Twilio TimeLimit on inbound; the watchdog backs these up). */
const timers = new Map<string, NodeJS.Timeout>()

export async function handleInbound(d: Deps, p: Form): Promise<{ twiml: string; callId?: string }> {
  const { db } = d, c = effective(d.config, db)
  const from = toE164(p.From ?? '')
  const ours = toE164(p.To ?? '') ?? p.To ?? ''
  const meta = { to: ours, sid: p.CallSid ?? null }

  if (!from || !c.PERSONAL_OK_NUMBERS.includes(from) || !inboundAllowed(db, from)) {
    audit(db, 'twilio', 'inbound.rejected', from ?? p.From ?? 'unknown', { ...meta, mode: c.INBOUND_OTHERS })
    return { twiml: c.INBOUND_OTHERS === 'reject' ? REJECT_TWIML : sayTwiml(NO_INCOMING_LINE) }
  }
  const turnAway = (code: string, line: string) => {
    audit(db, 'twilio', 'inbound.turned_away', from, { ...meta, code })
    return { twiml: sayTwiml(line) }
  }
  if (!c.INBOUND_ENABLED || !c.ELEVENLABS_PETE_AGENT_ID) return turnAway('inbound_disabled', NO_INCOMING_LINE)
  const label = one<{ label: string }>(db, 'SELECT label FROM numbers WHERE e164 = ?', ours)?.label
  if (label == null) return turnAway('unknown_number', NO_INCOMING_LINE) // a number we don't have on file
  const bad = checkLiveCall(db) ?? checkSpend(c, db, d.clock?.() ?? new Date())
  if (bad) return turnAway(bad.code, PETE_UNAVAILABLE_LINE)
  if (!brainOnline(c, db)) return turnAway('brain_offline', PETE_UNAVAILABLE_LINE)

  // Claim the line (one call at a time) before anything awaits.
  const id = 'call_' + randomBytes(9).toString('base64url')
  const at = new Date().toISOString()
  run(db, `INSERT INTO calls (id, agent_id, to_e164, from_e164, from_label, purpose, brief, dry_run, status, started_at, max_seconds,
                             twilio_sid, brain, private, el_agent_id, direction)
           VALUES (?, 'inbound', ?, ?, ?, 'Pete called in', '', 0, 'in-progress', ?, ?, ?, 'jasmine', 1, ?, 'inbound')`,
    id, from, ours, label, at, c.MAX_CALL_SECONDS, p.CallSid ?? null, c.ELEVENLABS_PETE_AGENT_ID)
  // StirVerstat = the carrier's caller-ID attestation (spoofed caller IDs rarely get TN-Validation-Passed-A).
  event(db, id, 'twilio', 'inbound', { twilio_sid: p.CallSid ?? null, stir_verstat: p.StirVerstat ?? null })
  audit(db, 'twilio', 'inbound.answered', id, { from, ...meta, stir_verstat: p.StirVerstat ?? null })

  const job = enqueueJob(db, id, 'call.start', callStartPayload(d, getCall(db, id)!), c.WARM_TIMEOUT_S * 1000)
  event(db, id, 'server', 'warming', { job_id: job.id, wait_s: c.INBOUND_WARM_WAIT_S })
  try {
    const call = getCall(db, id)!
    // Register with ElevenLabs while the phone session warms up; Pete hears ringing meanwhile.
    const [reg, warm] = await Promise.all([
      d.elevenlabs.registerCall({
        from, to: ours, agentId: c.ELEVENLABS_PETE_AGENT_ID, direction: 'inbound',
        dynamicVariables: { call_id: id, purpose: call.purpose, brief: '', plan: '' },
      }),
      awaitJob(db, job.id, c.INBOUND_WARM_WAIT_S * 1000),
    ])
    run(db, 'UPDATE calls SET el_conversation_id = ? WHERE id = ?', reg.conversationId, id)
    const ready = warm.status === 'done' && (JSON.parse(warm.result ?? '{}') as { ready?: boolean }).ready === true
    // Not ready yet: answer anyway (the opener is server text), the first turn waits for the session like any turn.
    event(db, id, 'server', ready ? 'brain_ready' : 'brain_not_ready_yet', { job_id: job.id, job_status: warm.status })
    const t = setTimeout(() => { timers.delete(id); void hangup(d, id, 'max_duration') }, call.max_seconds * 1000)
    t.unref?.()
    timers.set(id, t)
    return { twiml: reg.twiml, callId: id }
  } catch (e) {
    const msg = (e as Error).message
    cancelJob(db, job.id)
    run(db, "UPDATE calls SET status = 'failed', end_reason = 'inbound_error', error = ?, ended_at = ? WHERE id = ?", msg, new Date().toISOString(), id)
    event(db, id, 'server', 'dial_error', { error: msg })
    audit(db, 'system', 'call.dial_error', id, { error: msg })
    return { twiml: sayTwiml(PETE_UNAVAILABLE_LINE), callId: id }
  }
}
