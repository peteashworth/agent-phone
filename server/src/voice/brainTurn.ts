// BRAIN=jasmine turns (docs/milestone-d-brain.md §2, §4-§7) and the per-turn timing log for every brain.
// The custom-LLM route runs hard stops and the AMD gate first; this file covers the code phrase, the turn job,
// fillers, the timeout exit, barge-in, and the control flags that come back with the answer.
import { createHash } from 'node:crypto'
import { type Deps, type CallRow, getCall, hangup, event } from '../calls.ts'
import { all, audit, one, run } from '../db.ts'
import { brainOnline, enqueueJob, awaitJob, cancelJob, getJob, type JobRow } from '../brainJobs.ts'
import { loadFacts, pickFacts, factsFor, filterFacts, type Fact } from '../facts.ts'
import type { FilterOptions } from './outputFilter.ts'
import { type ChatMessage, textOf } from './brain.ts'
import { findPhrase, nearMiss, removePhrase } from './codePhrase.ts'
import { EXIT_LINE, FILLER_LINES, FILLER2_LINE, NOTICE_LINE, pickFiller, speakMs } from './lines.ts'
import { isQuestion, isGoodbye } from './question.ts'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

// ---------------------------------------------------------------- timing

type Stage = 'queued' | 'picked' | 'reply' | 'filtered' | 'tts' | 'filler1' | 'filler2' | 'done'
export type TurnKind = 'brain' | 'hard_stop' | 'voicemail' | 'closing' | 'disclosure'

/** One row in call_turns per LLM request: ms offsets from the moment ElevenLabs' request arrived. */
export class TurnLog {
  readonly t0 = Date.now()
  private ms: Partial<Record<Stage, number>> = {}
  private said = ''
  outcome = 'ok'
  jobId: string | null = null
  attempts = 0
  redact: string[] = []
  /** This turn starts with NOTICE_LINE (the callee hadn't heard the recording notice yet). */
  notice = false
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
    // A turn a later request took over (continuation) stays 'continued', whatever its own close handler says.
    run(this.d.db, `UPDATE call_turns SET kind = ?, job_id = ?, attempts = ?, queued_ms = ?, picked_ms = ?, reply_ms = ?, filtered_ms = ?,
                    tts_ms = ?, filler1_ms = ?, filler2_ms = ?, done_ms = ?,
                    outcome = CASE WHEN outcome = 'continued' THEN outcome ELSE ? END, said = ?, redact_hash = ? WHERE id = ?`,
      this.kind, this.jobId, this.attempts, m.queued ?? null, m.picked ?? null, m.reply ?? null, m.filtered ?? null, m.tts ?? null,
      m.filler1 ?? null, m.filler2 ?? null, m.done ?? null, this.outcome, this.said || null, this.redact.join(',') || null,
      this.row as number)
  }
}

/** Index in FILLER_LINES of the last first-filler this call spoke, or -1. */
function lastFiller(db: Deps['db'], callId: string): number {
  const row = one<{ said: string | null }>(db,
    "SELECT said FROM call_turns WHERE call_id = ? AND filler1_ms IS NOT NULL AND outcome != 'pending' ORDER BY id DESC LIMIT 1", callId)
  return row?.said ? FILLER_LINES.findIndex(l => row.said!.startsWith(l)) : -1
}

/**
 * When the first filler goes out, in ms after the request: this call's usual reply time (median of the last 5 brain
 * turns that got a reply) plus FILLER_ADAPT_MARGIN_MS, clamped to [FILLER_AFTER_MS, FILLER_ADAPT_MAX_MS]. The first
 * turn has no history and uses FILLER_AFTER_MS.
 */
export function firstFillerMs(d: Deps, callId: string): number {
  const c = d.config
  if (!c.FILLER_ADAPT_MAX_MS || c.FILLER_ADAPT_MAX_MS <= c.FILLER_AFTER_MS) return c.FILLER_AFTER_MS
  const ms = all<{ reply_ms: number }>(d.db, `SELECT reply_ms FROM call_turns WHERE call_id = ? AND kind = 'brain'
    AND reply_ms IS NOT NULL ORDER BY id DESC LIMIT 5`, callId).map(r => r.reply_ms).sort((a, b) => a - b)
  if (!ms.length) return c.FILLER_AFTER_MS
  const mid = ms.length % 2 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2
  return Math.round(Math.min(Math.max(c.FILLER_AFTER_MS, mid + c.FILLER_ADAPT_MARGIN_MS), c.FILLER_ADAPT_MAX_MS))
}

/** The previous turn on this call, to tell whether the person cut it off. */
function previousTurn(d: Deps, callId: string) {
  return one<{ outcome: string; said: string | null }>(d.db,
    "SELECT outcome, said FROM call_turns WHERE call_id = ? AND outcome NOT IN ('pending', 'continued') ORDER BY id DESC LIMIT 1", callId)
}

// ---------------------------------------------------------------- continuation

/**
 * True if the text is fillers only (or nothing): the person never heard an answer in it. Fillers and the notice only
 * ever lead a turn, so only leading ones are stripped (an answer that is just "Okay." is still an answer).
 */
export function onlyFiller(said: string | null): boolean {
  const lines = [...FILLER_LINES, FILLER2_LINE, NOTICE_LINE].map(l => l.trim())
  let s = (said ?? '').trim()
  for (let l; (l = lines.find(l => s.startsWith(l)));) s = s.slice(l.length).trim()
  return !s
}

export type Continuation = { seq: number | null; interrupted: unknown }

/**
 * ElevenLabs ends a turn on a short pause, then sends the rest of the sentence as a new request and drops the first.
 * If the previous brain turn spoke nothing but filler and was dropped less than CONTINUATION_MS ago (or is still
 * open), this request carries on that turn: its job is cancelled, the row is marked 'continued' (not barge_in), and
 * the new job gets the whole text. A turn that had started its real answer is a barge-in, as before.
 */
export function takeContinuation(d: Deps, callId: string, now = Date.now()): Continuation | null {
  const { db, config: c } = d
  if (!c.CONTINUATION_MS) return null
  const row = one<{ id: number; kind: string; started_at: string; done_ms: number | null; outcome: string; said: string | null; job_id: string | null }>(db,
    'SELECT id, kind, started_at, done_ms, outcome, said, job_id FROM call_turns WHERE call_id = ? ORDER BY id DESC LIMIT 1', callId)
  if (!row || row.kind !== 'brain' || !onlyFiller(row.said)) return null
  let job: JobRow | undefined
  if (row.outcome === 'barge_in') {
    if (now - (Date.parse(row.started_at) + (row.done_ms ?? 0)) > c.CONTINUATION_MS) return null
    job = row.job_id ? getJob(db, row.job_id) : undefined
  } else if (row.outcome === 'pending') {
    // Still open (its request hasn't been dropped yet): only a turn waiting on a host job can be taken over.
    job = one<JobRow>(db, "SELECT * FROM brain_jobs WHERE call_id = ? AND type = 'turn' AND status IN ('queued','picked') ORDER BY created_at DESC, rowid DESC LIMIT 1", callId)
    if (!job) return null
  } else return null
  run(db, "UPDATE call_turns SET outcome = 'continued' WHERE id = ?", row.id)
  if (job) cancelJob(db, job.id)
  event(db, callId, 'server', 'continuation', { turn: row.id, seq: job?.seq ?? null, picked: !!job?.picked_at })
  return { seq: job?.picked_at ? job.seq : null, interrupted: job ? (JSON.parse(job.payload) as { interrupted?: unknown }).interrupted ?? null : null }
}

// ---------------------------------------------------------------- code phrase + payload (synchronous)

export type Prepared = {
  call: CallRow
  payload: Record<string, unknown>
  usersUpto: number
  seq: number
  filter: FilterOptions
  /** The callee's latest words are a question (and not a goodbye): the brain may not end the call on this turn. */
  /** Why the brain's end_call would be refused this turn ('question' | 'no_goodbye'), or null if it's allowed. */
  keepOpen: 'question' | 'no_goodbye' | null
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
 * The phrase is never stored, logged or sent: a match is cut out. Nothing ever asks for it or hints that it exists:
 * a near-miss goes to the brain as ordinary speech, and only counts as an attempt (silent lock after the limit).
 */
export function prepareJasmineTurn(d: Deps, call: CallRow, messages: ChatMessage[], log: TurnLog, cont: Continuation | null = null): Prepared {
  const { config: c, db } = d
  const users = userTexts(messages)
  // User text the host has already answered. Jobs of continued turns don't count: their text goes out again, merged.
  const sent = one<{ n: number | null }>(db, `SELECT MAX(j.users_upto) AS n FROM brain_jobs j WHERE j.call_id = ? AND j.type = 'turn'
    AND j.picked_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM call_turns t WHERE t.job_id = j.id AND t.outcome = 'continued')`, call.id)?.n ?? 0
  let fresh = users.slice(Math.min(sent, users.length))
  // ElevenLabs may rewrite the last user message in place (fragments merged): no new message, but new words.
  if (!fresh.length && users.length) {
    fresh = users.slice(-1)
    event(db, call.id, 'server', 'user_text_rewritten', { users: users.length, sent })
  }
  // A fragment followed by the whole sentence as its own message: keep the whole sentence only.
  const norm = (t: string) => t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
  fresh = fresh.filter((t, i) => !(i + 1 < fresh.length && norm(t) && norm(fresh[i + 1]).startsWith(norm(t))))
  let userText = fresh.join(' ').trim()
  let codePhrase: 'verified' | null = null
  const phrase = c.CODE_PHRASE

  // Only Pete-agent calls (recording off, deleted after) can unlock; the number is re-checked against today's env.
  const okNumber = !!call.private && c.PERSONAL_OK_NUMBERS.includes(call.to_e164)
  const hit = phrase ? fresh.filter(t => findPhrase(t, phrase)) : []
  if (hit.length) {
    log.redact.push(...hit.map(sha256))
    userText = fresh.map(t => removePhrase(t, phrase!).text).join(' ').trim()
    const canUnlock = okNumber && call.code_attempts < c.CODE_PHRASE_MAX_ATTEMPTS
    if (call.tier !== 'personal' && canUnlock) {
      run(db, "UPDATE calls SET tier = 'personal' WHERE id = ?", call.id)
      codePhrase = 'verified'
      event(db, call.id, 'server', 'code_phrase', { result: 'verified' })
      audit(db, 'system', 'call.code_phrase', call.id, { result: 'verified' })
    } else if (call.tier !== 'personal') {
      const why = okNumber ? 'code_phrase_locked' : 'code_phrase_wrong_callee'
      event(db, call.id, 'server', why, {})
      audit(db, 'system', 'call.' + why, call.id)
    }
  } else if (phrase && okNumber && call.tier !== 'personal' && call.code_attempts < c.CODE_PHRASE_MAX_ATTEMPTS
    && fresh.some(t => nearMiss(t, phrase))) {
    // Close but no match: the words go to the brain as they are, the attempt is counted, nothing is said about it.
    const attempts = call.code_attempts + 1
    const locked = attempts >= c.CODE_PHRASE_MAX_ATTEMPTS
    run(db, 'UPDATE calls SET code_attempts = ? WHERE id = ?', attempts, call.id)
    event(db, call.id, 'server', 'code_near_miss', { attempts, locked })
    audit(db, 'system', 'call.code_near_miss', call.id, { attempts, locked })
  }

  const now = getCall(db, call.id)!
  // Personal material goes out once, with the first turn after verification that the host actually picked up.
  const personalSent = !!one(db, `SELECT 1 FROM brain_jobs WHERE call_id = ? AND type = 'turn' AND picked_at IS NOT NULL
    AND json_extract(payload, '$.code_phrase') = 'verified'`, call.id)
  if (now.tier === 'personal' && !personalSent) codePhrase = 'verified'
  const { picked } = factsOf(d, now)
  const prev = previousTurn(d, call.id)
  const lastAgent = textOf(messages.findLast(m => m.role === 'assistant')?.content).trim()
  const interrupted = cont ? cont.interrupted ?? null
    : prev?.said && (prev.outcome === 'barge_in' || (lastAgent && lastAgent.length < prev.said.trim().length - 2))
      ? { spoken: lastAgent || null } : null

  const question = isQuestion(userText)
  // The brain's [[end_call]] only goes through after the callee's own goodbye, on every call (Pete, Nov 4; after
  // call_c7j2KqyVXzK5's brain_end at 184s with Pete mid-conversation). Otherwise the callee hangs up.
  const goodbye = isGoodbye(userText)
  const keepOpen = goodbye ? null : question ? 'question' : 'no_goodbye'

  const seq = now.brain_seq + 1
  run(db, 'UPDATE calls SET brain_seq = ? WHERE id = ?', seq, call.id)
  return {
    call: now, seq, usersUpto: users.length, filter: filterOptions(d, now), keepOpen,
    payload: {
      tier: now.tier, user_text: userText, last_user_is_question: question, end_call_allowed: !keepOpen, interrupted, code_phrase: codePhrase,
      ...(codePhrase === 'verified' ? { brief_personal: now.brief_personal, facts: factsFor(picked, 'code') } : {}),
      // The host picked the job this one replaces: its answer to that one was never spoken.
      ...(cont?.seq != null ? { continues: cont.seq } : {}),
    },
  }
}

// ---------------------------------------------------------------- the turn itself

type Answer = { say: string; end_call: boolean; note: string | null }

/** The host's result; [[end_call]] / [[note: …]] tag lines in `say` are honoured too. Any other [[tag]] is dropped unspoken. */
export function parseAnswer(raw: string | null): Answer {
  const r = JSON.parse(raw ?? '{}') as { say?: string; end_call?: boolean; note_for_jasmine?: string | null }
  let say = r.say ?? '', note = r.note_for_jasmine ?? null
  const end = !!r.end_call || /\[\[\s*end_call\s*\]\]/i.test(say)
  const tagNote = say.match(/\[\[\s*note:\s*([^\]]*)\]\]/i)?.[1]?.trim()
  if (!note && tagNote) note = tagNote
  say = say.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim()
  return { say, end_call: end, note }
}

/** What to say for a turn on a call that's already being hung up (not a hard stop; that's handled before). */
export function closingLine(call: CallRow): string {
  return ['brain_timeout', 'brain_offline', 'brain_error'].includes(call.end_reason ?? '') ? EXIT_LINE : ''
}

/** True if this call already spoke the line (closing lines are said once; later closing turns stay silent). */
export function alreadySaid(db: Deps['db'], callId: string, line: string): boolean {
  return all<{ said: string }>(db, 'SELECT said FROM call_turns WHERE call_id = ? AND said IS NOT NULL', callId).some(r => r.said.includes(line))
}

/**
 * Sends the turn job and streams: fillers while it's pending, then the answer. Ends the call itself on timeout, host
 * failure (after one retry), an offline host, or [[end_call]] (refused while the callee's question is open). Barge-in
 * (signal) cancels the job.
 */
export async function* runJasmineTurn(d: Deps, p: Prepared, log: TurnLog, signal: AbortSignal): AsyncGenerator<string> {
  const { config: c, db } = d
  const id = p.call.id
  // A recording notice said ahead of this turn may still be playing: the hangup waits for it as well.
  const noticeLeft = () => log.notice ? Math.max(log.t0 + speakMs(NOTICE_LINE, 0) - Date.now(), 0) : 0
  const exit = (reason: 'brain_timeout' | 'brain_offline', outcome: string) => {
    log.outcome = outcome
    event(db, id, 'server', reason, { seq: p.seq, attempts: log.attempts })
    void hangup(d, id, reason, speakMs(EXIT_LINE, c.HANGUP_DELAY_MS) + noticeLeft())
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
  const f1 = firstFillerMs(d, id)
  // The second filler keeps its gap after the first if the first moved past it.
  const f2 = c.FILLER2_AFTER_MS ? Math.max(c.FILLER2_AFTER_MS, f1 + c.FILLER2_AFTER_MS - c.FILLER_AFTER_MS) : 0
  let jobId = send()
  const fillers: { at: number; stage: 'filler1' | 'filler2'; line: string }[] = [
    { at: log.t0 + f1, stage: 'filler1' as const, line: FILLER_LINES[pickFiller(lastFiller(db, id))] },
    ...(f2 ? [{ at: log.t0 + f2, stage: 'filler2' as const, line: FILLER2_LINE }] : []),
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
    // Cancelled by someone else = a newer request took this turn over (takeContinuation). Say nothing more.
    if (job.status === 'cancelled') { log.outcome = 'continued'; return }
    if (job.status === 'done') {
      log.mark('reply', job.answered_at ? Date.parse(job.answered_at) : Date.now())
      const a = parseAnswer(job.result)
      if (a.note) {
        const notes = JSON.parse(getCall(db, id)!.notes ?? '[]') as string[]
        run(db, 'UPDATE calls SET notes = ? WHERE id = ?', JSON.stringify([...notes, a.note.slice(0, 1000)]), id)
      }
      if (a.say) yield a.say
      if (a.end_call && p.keepOpen) {
        // Never hang up without the callee's goodbye: the line is said, the call stays up, the brain gets the next turn.
        log.outcome = 'end_call_refused'
        event(db, id, 'server', 'end_call_refused', { seq: p.seq, reason: p.keepOpen })
      } else if (a.end_call) {
        log.outcome = 'end_call'
        void hangup(d, id, 'brain_end', speakMs(a.say, c.HANGUP_DELAY_MS) + noticeLeft())
      }
      return
    }
    if (job.status === 'failed' && log.attempts < 2 && Date.now() < deadline) {
      event(db, id, 'server', 'brain_retry', { seq: p.seq, error: job.error })
      jobId = send()
      continue
    }
    if (job.status === 'failed' || job.status === 'expired' || Date.now() >= deadline) {
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

