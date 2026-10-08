// Milestone C: answering-machine handling, the post-call record (transcript, summary, audio, real cost) and
// recording retention. Runs from the Twilio AMD webhook, the custom-LLM route, and a 30s sweep (index.ts).
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Deps, type CallRow, getCall, hangup, event, LIVE_STATUSES } from './calls.ts'
import { all, run, audit } from './db.ts'

// ---------------------------------------------------------------- answering machines

/** Twilio AnsweredBy values (plus our own 'timeout') that mean "not a person". Unsure counts as a machine. */
export const isMachine = (answeredBy: string | null) => !!answeredBy && answeredBy !== 'human'

/** Twilio's async AMD verdict. A machine ends the call (VOICEMAIL_ACTION=hangup) or gets the one fixed line first. */
export async function applyAmd(d: Deps, id: string, answeredBy: string, source: 'twilio' | 'server' = 'twilio'): Promise<void> {
  const call = getCall(d.db, id)
  if (!call || call.answered_by) return // first verdict wins (a late Twilio verdict after our timeout is history only)
  run(d.db, 'UPDATE calls SET answered_by = ?, amd_at = ? WHERE id = ?', answeredBy, now(), id)
  event(d.db, id, source, 'amd', { answered_by: answeredBy })
  if (!isMachine(answeredBy) || !(LIVE_STATUSES as readonly string[]).includes(call.status)) return
  audit(d.db, 'system', 'call.voicemail', id, { answered_by: answeredBy, action: d.config.VOICEMAIL_ACTION })
  if (d.config.VOICEMAIL_ACTION === 'hangup') return hangup(d, id, 'voicemail', 0)
  // 'message': the next LLM turn speaks VOICEMAIL_LINE and hangs up; this is the backstop if no turn ever comes.
  run(d.db, "UPDATE calls SET end_reason = 'voicemail' WHERE id = ?", id)
  setTimeout(() => void hangup(d, id, 'voicemail', 0), VOICEMAIL_BACKSTOP_MS).unref()
}
const VOICEMAIL_BACKSTOP_MS = 20_000

/** Ms past answer to wait for a verdict: Twilio's MachineDetectionTimeout plus a margin for the webhook. */
const amdWaitMs = (d: Deps) => d.config.AMD_TIMEOUT_S * 1000 + 1500

/**
 * Called before the brain speaks. Nothing personal (purpose, brief) is said until AMD says "human"; no verdict in time
 * counts as a machine. Returns the call row as it stands after the wait.
 */
export async function awaitHuman(d: Deps, call: CallRow, pollMs = 150): Promise<CallRow> {
  let c = call
  if (!c.amd || c.answered_by || c.dry_run) return c
  const deadline = Date.parse(c.started_at ?? new Date().toISOString()) + amdWaitMs(d)
  while (!c.answered_by && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs))
    c = getCall(d.db, c.id) ?? c
  }
  if (!c.answered_by) { await applyAmd(d, c.id, 'timeout', 'server'); c = getCall(d.db, c.id) ?? c }
  return c
}

// ---------------------------------------------------------------- post-call record

const MAX_FINALIZE_ATTEMPTS = 20          // ~10 min at one sweep per 30s
const PRICE_WINDOW_MS = 3 * 3600_000      // Twilio usually rates a call within minutes; stop asking after 3h
const DONE = new Set(['done', 'failed'])

type Turn = { role: 'agent' | 'user'; text: string; t: number | null }

/**
 * One pass: finalize ended calls (ElevenLabs transcript/summary/credits/audio), pick up Twilio prices, purge old
 * recordings. Returns the ids that changed (so the caller can ping the dashboard).
 */
export async function postCallSweep(d: Deps): Promise<string[]> {
  const changed = new Set<string>()
  for (const id of await finalizeCalls(d)) changed.add(id)
  for (const id of await fillPrices(d)) changed.add(id)
  for (const id of purgeRecordings(d)) changed.add(id)
  return [...changed]
}

async function finalizeCalls(d: Deps): Promise<string[]> {
  const { db, config: c } = d
  const pending = all<CallRow>(db,
    'SELECT * FROM calls WHERE finalized_at IS NULL AND dry_run = 0 AND ended_at IS NOT NULL ORDER BY ended_at LIMIT 10')
  const done: string[] = []
  for (const call of pending) {
    run(db, 'UPDATE calls SET finalize_attempts = finalize_attempts + 1 WHERE id = ?', call.id)
    const last = call.finalize_attempts + 1 >= MAX_FINALIZE_ATTEMPTS
    // Never answered (busy, no-answer, failed before connect): ElevenLabs has nothing worth keeping.
    if (!call.el_conversation_id || !call.started_at) { finish(d, call.id, 'no_conversation'); done.push(call.id); continue }
    try {
      const conv = await d.elevenlabs.getConversation(call.el_conversation_id)
      if (!DONE.has(conv.status) && !last) continue // still processing (analysis lands ~seconds after the call)
      const transcript: Turn[] = (conv.transcript ?? [])
        .filter(t => t.message)
        .map(t => ({ role: t.role === 'user' ? 'user' : 'agent', text: t.message!, t: t.time_in_call_secs ?? null }))
      run(db, 'UPDATE calls SET transcript = ?, summary = ?, summary_title = ?, el_cost_credits = ? WHERE id = ?',
        JSON.stringify(transcript), conv.analysis?.transcript_summary ?? null, conv.analysis?.call_summary_title ?? null,
        conv.metadata?.cost ?? null, call.id)
      if (c.SAVE_RECORDINGS && conv.has_audio) await saveRecording(d, call)
      updateCost(d, call.id)
      finish(d, call.id, conv.status)
      done.push(call.id)
    } catch (e) {
      event(db, call.id, 'server', 'finalize_error', { error: (e as Error).message, attempt: call.finalize_attempts + 1 })
      if (last) { finish(d, call.id, 'gave_up'); done.push(call.id) }
    }
  }
  return done
}

function finish(d: Deps, id: string, how: string) {
  run(d.db, 'UPDATE calls SET finalized_at = ? WHERE id = ?', now(), id)
  event(d.db, id, 'server', 'finalized', { how })
}

async function saveRecording(d: Deps, call: CallRow) {
  try {
    const audio = await d.elevenlabs.getAudio(call.el_conversation_id!)
    const dir = join(d.config.DATA_DIR, 'recordings')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const rel = join('recordings', `${call.id}.mp3`)
    writeFileSync(join(d.config.DATA_DIR, rel), audio, { mode: 0o600 })
    run(d.db, 'UPDATE calls SET recording_path = ?, recording_bytes = ? WHERE id = ?', rel, audio.byteLength, call.id)
  } catch (e) {
    event(d.db, call.id, 'server', 'recording_error', { error: (e as Error).message }) // the rest of the record still lands
  }
}

/** Twilio rates calls a few minutes after they end. */
async function fillPrices(d: Deps): Promise<string[]> {
  const since = new Date(Date.now() - PRICE_WINDOW_MS).toISOString()
  const rows = all<CallRow>(d.db, `SELECT * FROM calls WHERE dry_run = 0 AND twilio_sid IS NOT NULL AND twilio_price_usd IS NULL
    AND ended_at IS NOT NULL AND ended_at >= ? ORDER BY ended_at LIMIT 10`, since)
  const done: string[] = []
  for (const call of rows) {
    try {
      const tw = await d.twilio.fetchCall(call.twilio_sid!)
      if (tw.price == null) continue
      run(d.db, 'UPDATE calls SET twilio_price_usd = ? WHERE id = ?', tw.price, call.id)
      updateCost(d, call.id)
      done.push(call.id)
    } catch { /* next sweep */ }
  }
  return done
}

/** Real cost = ElevenLabs credits at the plan rate + Twilio's price + the AMD fee. Partial until both are in. */
export function updateCost(d: Deps, id: string) {
  const call = getCall(d.db, id)
  if (!call || (call.el_cost_credits == null && call.twilio_price_usd == null)) return
  const usd = (call.el_cost_credits ?? 0) * d.config.ELEVENLABS_USD_PER_CREDIT + (call.twilio_price_usd ?? 0)
    + (call.amd ? d.config.AMD_FEE_USD : 0)
  run(d.db, 'UPDATE calls SET cost_usd = ? WHERE id = ?', Math.round(usd * 10_000) / 10_000, id)
}

/** Deletes our copy of call audio after RECORDING_RETENTION_DAYS. Transcript and summary stay. */
export function purgeRecordings(d: Deps): string[] {
  const cutoff = new Date(Date.now() - d.config.RECORDING_RETENTION_DAYS * 86_400_000).toISOString()
  const rows = all<{ id: string; recording_path: string }>(d.db,
    'SELECT id, recording_path FROM calls WHERE recording_path IS NOT NULL AND recording_deleted_at IS NULL AND ended_at < ?', cutoff)
  for (const r of rows) {
    const file = join(d.config.DATA_DIR, r.recording_path)
    try { if (existsSync(file)) unlinkSync(file) } catch (e) {
      event(d.db, r.id, 'server', 'purge_error', { error: (e as Error).message }); continue
    }
    run(d.db, 'UPDATE calls SET recording_path = NULL, recording_deleted_at = ? WHERE id = ?', now(), r.id)
    audit(d.db, 'system', 'recording.purged', r.id)
  }
  return rows.map(r => r.id)
}

// ---------------------------------------------------------------- dashboard ping

/** Tells the dashboard the call log changed (it re-fetches). Fire and forget; the dashboard also polls. */
export function notifyDashboard(d: Deps, f: typeof fetch = fetch): void {
  const { DASHBOARD_NOTIFY_URL: url, DASHBOARD_NOTIFY_TOKEN: token } = d.config
  if (!url) return
  f(url, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(5000) })
    .catch(() => {})
}

const now = () => new Date().toISOString()
