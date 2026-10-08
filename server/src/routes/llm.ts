// ElevenLabs "custom LLM" endpoint: {BASE_PATH}/llm/v1[/chat/completions], OpenAI chat-completions format.
// Every turn passes through here, which is what makes the hard stops server-enforced: the last thing the person said
// is checked before any model runs, and on a hit we speak the close line and hang up via Twilio ourselves.
import type { FastifyInstance, FastifyReply } from 'fastify'
import { randomBytes } from 'node:crypto'
import { type Deps, type CallRow, getCall, hangup, LIVE_STATUSES } from '../calls.ts'
import { safeEqual } from '../auth.ts'
import { all, audit, run } from '../db.ts'
import { setDoNotCall } from '../contacts.ts'
import { detectHardStop, CLOSE_LINES } from '../voice/hardStops.ts'
import { OutputFilter } from '../voice/outputFilter.ts'
import { type Brain, type ChatMessage, makeBrain, cannedBrain, textOf } from '../voice/brain.ts'
import { TurnLog, prepareJasmineTurn, runJasmineTurn, scrubMessages, filterOptions, closingLine } from '../voice/brainTurn.ts'
import type { FilterOptions } from '../voice/outputFilter.ts'
import { awaitHuman, applyGreeting, isMachine } from '../postcall.ts'
import { DISCLOSURE } from '../voice/lines.ts'

type Body = { model?: string; messages?: ChatMessage[]; stream?: boolean }

const CALL_ID = /(?<![\w-])call_[A-Za-z0-9_-]{12}(?![\w-])/

/** The agent's system prompt carries "call_id: {{call_id}}"; failing that, the one live call (we only allow one). */
/** The call_id marker in the system prompt, if any (logged so a deploy can confirm ElevenLabs substitutes it). */
export function callMarker(messages: ChatMessage[]): string | null {
  for (const m of messages) if (m.role === 'system') { const id = textOf(m.content).match(CALL_ID)?.[0]; if (id) return id }
  return null
}

export function identifyCall(d: Deps, messages: ChatMessage[]): CallRow | undefined {
  for (const m of messages) {
    if (m.role !== 'system') continue
    const id = textOf(m.content).match(CALL_ID)?.[0]
    const call = id ? getCall(d.db, id) : undefined
    if (call) return call
  }
  const live = all<{ id: string }>(d.db,
    `SELECT id FROM calls WHERE dry_run = 0 AND status IN (${LIVE_STATUSES.map(() => '?').join(',')}) LIMIT 2`, ...LIVE_STATUSES)
  return live.length === 1 ? getCall(d.db, live[0].id) : undefined
}

export async function llmRoutes(app: FastifyInstance, d: Deps) {
  const { config: c, db } = d
  // d.brain (tests) replaces whichever non-jasmine brain a call uses.
  const configured: Brain = makeBrain(c), canned = cannedBrain()
  const brainFor = (kind: string): Brain => d.brain ?? (kind === 'openai' ? configured : canned)

  const handler = async (req: { headers: Record<string, unknown>; body: unknown; log: FastifyInstance['log'] }, reply: FastifyReply) => {
    if (!c.CUSTOM_LLM_SECRET) return reply.code(503).send({ error: 'custom LLM endpoint is not configured' })
    const auth = req.headers.authorization
    if (typeof auth !== 'string' || !safeEqual(auth, `Bearer ${c.CUSTOM_LLM_SECRET}`))
      return reply.code(401).send({ error: 'unauthorized' })

    const body = (req.body ?? {}) as Body
    const messages = Array.isArray(body.messages) ? body.messages : []
    const call = identifyCall(d, messages)
    const lastUserIdx = messages.findLastIndex(m => m.role === 'user')
    const lastUser = textOf(messages[lastUserIdx]?.content)
    // Is this the person's reply to the disclosure ("…This call is being recorded.")? Holds for option A and B alike.
    const prevAgent = messages.slice(0, Math.max(lastUserIdx, 0)).findLast(m => m.role === 'assistant')
    const afterDisclosure = /being recorded/i.test(textOf(prevAgent?.content))

    // Already hanging up: keep repeating the close line, never hand the turn back to the model.
    const prior = call?.hangup_requested_at && call.end_reason?.startsWith('hard_stop:')
      ? call.end_reason.slice('hard_stop:'.length) as keyof typeof CLOSE_LINES : null
    const stop = prior ?? detectHardStop(lastUser, { afterDisclosure })
    req.log.info({ marker: callMarker(messages), call: call?.id ?? null, turns: messages.length, stop }, 'llm turn')

    const kind = call?.brain ?? c.BRAIN
    const ac = new AbortController()
    let log: TurnLog | undefined
    let filterOpts: FilterOptions = call ? filterOptions(d, call) : { intimate: c.INTIMATE_TERMS }
    let source: AsyncIterable<string>
    if (stop) {
      if (call) log = new TurnLog(d, call, kind, prior ? 'closing' : 'hard_stop')
      source = (async function* () { yield CLOSE_LINES[stop] })()
      if (!prior) {
        req.log.warn({ call: call?.id, stop }, 'hard stop')
        audit(db, 'system', 'call.hard_stop', call?.id ?? null, { stop, identified: !!call })
        if (call) {
          if (stop === 'opt_out') setDoNotCall(db, 'system', call.to_e164, `said on call ${call.id}`)
          // hangup() marks the call synchronously, then waits for the close line to play before ending it.
          void hangup(d, call.id, `hard_stop:${stop}`, c.HANGUP_DELAY_MS)
        }
      }
    } else {
      // Wait-for-hello opening (agent first_message blank): nothing has been said to the callee yet, so this turn is
      // the disclosure and nothing else. It doesn't wait for AMD: it's fixed text with nothing from the brief in it.
      const opening = !messages.some(m => m.role === 'assistant' && textOf(m.content).trim())
      // Answering machines: what the callee said feeds the verdict, then nothing from the brief is said until there is
      // one (or the wait runs out). Only machine_*/fax is a machine; unknown and timeout carry on as human.
      let now = call ? await applyGreeting(d, call, lastUser, opening) : undefined
      if (now && !opening) now = await awaitHuman(d, now)
      if (now && isMachine(now.answered_by)) {
        log = new TurnLog(d, now, kind, 'voicemail')
        req.log.info({ call: now.id, answered_by: now.answered_by }, 'voicemail')
        if (c.VOICEMAIL_ACTION === 'message') {
          source = (async function* () { yield c.VOICEMAIL_LINE })()
          void hangup(d, now.id, 'voicemail', c.HANGUP_DELAY_MS)
        } else {
          source = (async function* () {})() // already hanging up; say nothing
        }
      } else if (now?.hangup_requested_at) {
        // Ending for another reason (brain_end, timeout, watchdog): never hand the turn back to a brain.
        log = new TurnLog(d, now, kind, 'closing')
        const line = closingLine(now)
        source = (async function* () { if (line) yield line })()
      } else if (opening) {
        if (now) log = new TurnLog(d, now, kind, 'disclosure')
        source = (async function* () { yield DISCLOSURE })()
      } else if (now && kind === 'jasmine') {
        log = new TurnLog(d, now, kind, 'brain')
        const p = prepareJasmineTurn(d, now, messages, log)
        filterOpts = p.filter
        source = runJasmineTurn(d, p, log, ac.signal)
      } else {
        if (now) log = new TurnLog(d, now, kind, 'brain')
        const turnLog = log
        const inner = brainFor(kind).reply(scrubMessages(c.CODE_PHRASE, messages), ac.signal)
        source = (async function* () { for await (const t of inner) { turnLog?.mark('reply'); yield t } })()
      }
    }
    if (log && log.kind !== 'brain') log.outcome = log.kind

    const filter = new OutputFilter(c.PRIVATE_TERMS, filterOpts)
    /** Text cleared by the filter on its way to ElevenLabs. Timing counts only the answer, not fillers. */
    const out = (text: string) => {
      if (!text) return
      log?.spoke(text)
      if (log?.has('reply')) { log.mark('filtered') }
    }
    const sent = () => { if (log?.has('filtered')) log.mark('tts') }
    const id = 'chatcmpl-' + randomBytes(8).toString('hex'), created = Math.floor(Date.now() / 1000), model = body.model ?? c.BRAIN
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const finish = () => {
      log?.save()
      if (filter.blocked.length) {
        audit(db, 'system', 'llm.output_blocked', call?.id ?? null, { reasons: filter.blocked }) // reasons only, never the text
        if (call) run(db, 'INSERT INTO call_events (call_id, source, type, data) VALUES (?, ?, ?, ?)',
          call.id, 'server', 'output_blocked', JSON.stringify({ reasons: filter.blocked }))
      }
    }

    if (body.stream === false) {
      let text = ''
      try { for await (const t of source) { const o = filter.push(t); out(o); text += o } } catch (e) { req.log.error(e, 'brain failed'); if (log) log.outcome = 'error' }
      const tail = filter.flush(); out(tail); text += tail; sent()
      finish()
      return { id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: text.trim() }, finish_reason: 'stop' }] }
    }

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    let closed = false
    res.on('close', () => {
      if (res.writableEnded) return
      closed = true
      ac.abort() // barge-in: ElevenLabs dropped the request
      if (log) { log.outcome = 'barge_in'; log.save() }
    })
    res.write(chunk({ role: 'assistant', content: '' }))
    try {
      for await (const t of source) {
        if (closed) break
        const o = filter.push(t)
        if (o) { out(o); res.write(chunk({ content: o })); sent() }
      }
    } catch (e) {
      req.log.error(e, 'brain failed')
      if (log) log.outcome = 'error'
    }
    const tail = filter.flush()
    if (tail && !closed) { out(tail); res.write(chunk({ content: tail })); sent() }
    finish()
    if (!closed) { res.write(chunk({}, 'stop')); res.end('data: [DONE]\n\n') }
  }

  app.post('/llm/v1', handler)
  app.post('/llm/v1/chat/completions', handler)
}
