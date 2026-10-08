// BRAIN=jasmine turns (docs/milestone-d-brain.md §2, §4-§7) and the per-turn timing log for every brain.
// The custom-LLM route runs hard stops and the AMD gate first; this file covers the code phrase, the turn job,
// fillers, the timeout exit, barge-in, and the control flags that come back with the answer.
import { createHash } from 'node:crypto'
import { type Deps, type CallRow, getCall, hangup, event } from '../calls.ts'
import { audit, one, run } from '../db.ts'
import { brainOnline, enqueueJob, awaitJob, cancelJob } from '../brainJobs.ts'
import { loadFacts, pickFacts, factsFor, filterFacts, type Fact } from '../facts.ts'
import type { FilterOptions } from './outputFilter.ts'
import { type ChatMessage, textOf } from './brain.ts'
import { findPhrase, removePhrase } from './codePhrase.ts'
import { EXIT_LINE, FILLER_LINES, FILLER2_LINE, CODE_ATTEMPT_PLACEHOLDER, speakMs } from './lines.ts'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// ---------------------------------------------------------------- timing

type Stage = 'queued' | 'picked' | 'reply' | 'filtered' | 'tts' | 'filler1' | 'filler2' | 'done'
export type TurnKind = 'brain' | 'hard_stop' | 'voicemail' | 'closing'

/** One row in call_turns per LLM request: ms offsets from the moment ElevenLabs' request arrived. */
export class TurnLog {
  readonly t0 = Date.now()
  private ms: Partial<Record<Stage, number>> = {}
  private said = ''
  outcome = 'ok'
  jobId: string | null = null
  attempts = 0
  redact: string[] = []
  private row: number | bigint = 0
  private d: Deps
  private call: CallRow
  kind: TurnKind
  constructor(d: Deps, call: CallRow, brain: string, kind: TurnKind) {
    this.d = d; this.call = call; this.kind = kind
    this.row = run(d.db, "INSERT INTO call_turns (call_id, started_at, brain, kind, outcome) VALUES (?, ?, ?, ?, 'pending')",
      call.id, new Date(this.t0).toISOString(), brain, kind).lastInsertRowid
  }
  mark(stage: Stage, at = Date.now()) { if (this.ms[stage] == null) this.ms[stage] = Math.max(at - this.t0, 0) }
  has(stage: Stage) { return this.ms[stage] != null }
  spoke(text: string) { this.said += text }
  /** Writes the row. Called once per request (also on barge-in, synchronously from the close event). */
  save() {
    this.mark('done')
    const m = this.ms
    run(this.d.db, `UPDATE call_turns SET kind = ?, job_id = ?, attempts = ?, queued_ms = ?, picked_ms = ?, reply_ms = ?, filtered_ms = ?,
                    tts_ms = ?, filler1_ms = ?, filler2_ms = ?, done_ms = ?, outcome = ?, said = ?, redact_hash = ? WHERE id = ?`,
      this.kind, this.jobId, this.attempts, m.queued ?? null, m.picked ?? null, m.reply ?? null, m.filtered ?? null, m.tts ?? null,
      m.filler1 ?? null, m.filler2 ?? null, m.done ?? null, this.outcome, this.said || null, this.redact.join(',') || null,
      this.row as number)
  }
}

/** The previous turn on this call, to tell whether the person cut it off. */
function previousTurn(d: Deps, callId: string) {
  return one<{ outcome: string; said: string | null }>(d.db,
    "SELECT outcome, said FROM call_turns WHERE call_id = ? AND outcome != 'pending' ORDER BY id DESC LIMIT 1", callId)
}

// ---------------------------------------------------------------- code phrase + payload (synchronous)

export type Prepared = {
  call: CallRow
  payload: Record<string, unknown>
  usersUpto: number
  seq: number
  filter: FilterOptions
}

const userTexts = (messages: ChatMessage[]) => messages.filter(m => m.role === 'user').map(m => textOf(m.content))

/** Removes the code phrase from every user message (for the canned/openai brains, which never take part in it). */
export function scrubMessages(phrase: string | undefined, messages: ChatMessage[]): ChatMessage[] {
  if (!phrase) return messages
  return messages.map(m => {
    if (m.role !== 'user') return m
    const r = removePhrase(textOf(m.content), phrase)
    return r.found ? { ...m, content: r.text } : m
  })
}

function factsOf(d: Deps, call: CallRow): { all: Fact[]; picked: Fact[] } {
  try {
    const all = loadFacts(d.config)
    return { all, picked: call.facts ? pickFacts(all, JSON.parse(call.facts) as string[]).picked : [] }
  } catch (e) {
    event(d.db, call.id, 'server', 'facts_error', { error: (e as Error).message })
    return { all: [], picked: [] }
  }
}

/** Output-filter options for this call as it stands (tier, INTIMATE_TERMS, fact allow/block lists). */
export function filterOptions(d: Deps, call: CallRow): FilterOptions {
  const { all, picked } = factsOf(d, call)
  return { personal: call.tier === 'personal', intimate: d.config.INTIMATE_TERMS, ...filterFacts(all, picked, call.tier) }
}

/**
 * §7 code phrase, then the turn payload. Synchronous so the tier is settled before the output filter is built.
 * The phrase is never stored, logged or sent: an attempt's words are replaced, a match is cut out.
 */
export function prepareJasmineTurn(d: Deps, call: CallRow, messages: ChatMessage[], log: TurnLog): Prepared {
  const { config: c, db } = d
  const users = userTexts(messages)
  const sent = one<{ n: number | null }>(db,
    "SELECT MAX(users_upto) AS n FROM brain_jobs WHERE call_id = ? AND type = 'turn' AND picked_at IS NOT NULL", call.id)?.n ?? 0
  const fresh = users.slice(Math.min(sent, users.length))
  let userText = fresh.join(' ').trim()
  let codePhrase: 'verified' | 'incorrect' | null = null
  let locked = false
  const phrase = c.CODE_PHRASE

  const hit = phrase ? fresh.filter(t => findPhrase(t, phrase)) : []
  if (hit.length) {
    log.redact.push(...hit.map(sha256))
    userText = fresh.map(t => removePhrase(t, phrase!).text).join(' ').trim()
    const canUnlock = c.PERSONAL_OK_NUMBERS.includes(call.to_e164) && call.code_attempts < c.CODE_PHRASE_MAX_ATTEMPTS
    if (call.tier !== 'personal' && canUnlock) {
      run(db, "UPDATE calls SET tier = 'personal', code_asked = 0 WHERE id = ?", call.id)
      codePhrase = 'verified'
      event(db, call.id, 'server', 'code_phrase', { result: 'verified' })
      audit(db, 'system', 'call.code_phrase', call.id, { result: 'verified' })
    } else if (call.tier !== 'personal') {
      const why = c.PERSONAL_OK_NUMBERS.includes(call.to_e164) ? 'code_phrase_locked' : 'code_phrase_wrong_callee'
      event(db, call.id, 'server', why, {})
      audit(db, 'system', 'call.' + why, call.id)
    }
  } else if (call.code_asked && call.tier !== 'personal') {
    // The brain asked; this turn was the attempt and it missed. Its words may be a near-miss of the phrase: withheld.
    log.redact.push(...fresh.map(sha256))
    userText = CODE_ATTEMPT_PLACEHOLDER
    const attempts = call.code_attempts + 1
    run(db, 'UPDATE calls SET code_asked = 0, code_attempts = ? WHERE id = ?', attempts, call.id)
    codePhrase = 'incorrect'
    locked = attempts >= c.CODE_PHRASE_MAX_ATTEMPTS
    event(db, call.id, 'server', 'code_phrase', { result: 'incorrect', attempts, locked })
    audit(db, 'system', 'call.code_phrase', call.id, { result: 'incorrect', attempts, locked })
  }

  const now = getCall(db, call.id)!
  // Personal material goes out once, with the first turn after verification that the host actually picked up.
  const personalSent = !!one(db, `SELECT 1 FROM brain_jobs WHERE call_id = ? AND type = 'turn' AND picked_at IS NOT NULL
    AND json_extract(payload, '$.code_phrase') = 'verified'`, call.id)
  if (now.tier === 'personal' && !personalSent) codePhrase = 'verified'
  const { picked } = factsOf(d, now)
  const prev = previousTurn(d, call.id)
  const lastAgent = textOf(messages.findLast(m => m.role === 'assistant')?.content).trim()
  const interrupted = prev?.said && (prev.outcome === 'barge_in' || (lastAgent && lastAgent.length < prev.said.trim().length - 2))
    ? { spoken: lastAgent || null } : null

  const seq = now.brain_seq + 1
  run(db, 'UPDATE calls SET brain_seq = ? WHERE id = ?', seq, call.id)
  return {
    call: now, seq, usersUpto: users.length, filter: filterOptions(d, now),
    payload: {
      tier: now.tier, user_text: userText, interrupted, code_phrase: codePhrase,
      ...(codePhrase === 'verified' ? { brief_personal: now.brief_personal, facts: factsFor(picked, 'code') } : {}),
      ...(locked ? { code_locked: true } : {}),
    },
  }
}

// ---------------------------------------------------------------- the turn itself

type Answer = { say: string; end_call: boolean; ask_code: boolean; note: string | null }

/** The host's result; [[end_call]] / [[ask_code]] / [[note: …]] tag lines in `say` are honoured too. */
export function parseAnswer(raw: string | null): Answer {
  const r = JSON.parse(raw ?? '{}') as { say?: string; end_call?: boolean; ask_code?: boolean; note_for_jasmine?: string | null }
  let say = r.say ?? '', note = r.note_for_jasmine ?? null
  const end = !!r.end_call || /\[\[\s*end_call\s*\]\]/i.test(say)
  const ask = !!r.ask_code || /\[\[\s*ask_code\s*\]\]/i.test(say)
  const tagNote = say.match(/\[\[\s*note:\s*([^\]]*)\]\]/i)?.[1]?.trim()
  if (!note && tagNote) note = tagNote
  say = say.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim()
  return { say, end_call: end, ask_code: ask, note }
}

/** What to say for a turn on a call that's already being hung up (not a hard stop; that's handled before). */
export function closingLine(call: CallRow): string {
  return call.end_reason === 'brain_timeout' || call.end_reason === 'brain_offline' ? EXIT_LINE : ''
}

/**
 * Sends the turn job and streams: fillers while it's pending, then the answer. Ends the call itself on timeout, host
 * failure (after one retry), an offline host, or [[end_call]]. Barge-in (signal) cancels the job.
 */
export async function* runJasmineTurn(d: Deps, p: Prepared, log: TurnLog, signal: AbortSignal): AsyncGenerator<string> {
  const { config: c, db } = d
  const id = p.call.id
  const exit = (reason: 'brain_timeout' | 'brain_offline', outcome: string) => {
    log.outcome = outcome
    event(db, id, 'server', reason, { seq: p.seq, attempts: log.attempts })
    void hangup(d, id, reason, speakMs(EXIT_LINE, c.HANGUP_DELAY_MS))
    return EXIT_LINE
  }
  if (!brainOnline(c, db)) { yield exit('brain_offline', 'offline'); return }

  const deadline = log.t0 + c.TURN_TIMEOUT_S * 1000
  const send = () => {
    log.attempts++
    const job = enqueueJob(db, id, 'turn', p.payload, deadline - Date.now(), { seq: p.seq, users_upto: p.usersUpto })
    log.jobId = job.id
    log.mark('queued')
    return job.id
  }
  let jobId = send()
  const fillers: { at: number; stage: 'filler1' | 'filler2'; line: string }[] = [
    { at: log.t0 + c.FILLER_AFTER_MS, stage: 'filler1' as const, line: FILLER_LINES[p.seq % FILLER_LINES.length] },
    ...(c.FILLER2_AFTER_MS ? [{ at: log.t0 + c.FILLER2_AFTER_MS, stage: 'filler2' as const, line: FILLER2_LINE }] : []),
  ].filter(f => f.at < deadline)

  for (;;) {
    const wakeAt = Math.min(deadline, ...fillers.map(f => f.at))
    const job = await awaitJob(db, jobId, Math.max(wakeAt - Date.now(), 0), signal)
    if (job.picked_at) log.mark('picked', Date.parse(job.picked_at))
    if (signal.aborted) {
      cancelJob(db, jobId)
      log.outcome = 'barge_in'
      return
    }
    if (job.status === 'done') {
      log.mark('reply', job.answered_at ? Date.parse(job.answered_at) : Date.now())
      const a = parseAnswer(job.result)
      if (a.note) {
        const notes = JSON.parse(getCall(db, id)!.notes ?? '[]') as string[]
        run(db, 'UPDATE calls SET notes = ? WHERE id = ?', JSON.stringify([...notes, a.note.slice(0, 1000)]), id)
      }
      if (a.ask_code && getCall(db, id)!.tier !== 'personal') run(db, 'UPDATE calls SET code_asked = 1 WHERE id = ?', id)
      if (a.say) yield a.say
      if (a.end_call) {
        log.outcome = 'end_call'
        void hangup(d, id, 'brain_end', speakMs(a.say, c.HANGUP_DELAY_MS))
      }
      return
    }
    if (job.status === 'failed' && log.attempts < 2 && Date.now() < deadline) {
      event(db, id, 'server', 'brain_retry', { seq: p.seq, error: job.error })
      jobId = send()
      continue
    }
    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired' || Date.now() >= deadline) {
      cancelJob(db, jobId, 'expired')
      yield exit('brain_timeout', job.status === 'failed' ? 'error' : 'timeout')
      return
    }
    // Still pending: is a filler due?
    const due = fillers.findIndex(f => Date.now() >= f.at)
    if (due >= 0) {
      const [f] = fillers.splice(due, 1)
      log.mark(f.stage)
      yield f.line
    }
  }
}

