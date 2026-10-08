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
import { type ChatMessage, makeBrain, textOf } from '../voice/brain.ts'

type Body = { model?: string; messages?: ChatMessage[]; stream?: boolean }

const CALL_ID = /(?<![\w-])call_[A-Za-z0-9_-]{12}(?![\w-])/

/** The agent's system prompt carries "call_id: {{call_id}}"; failing that, the one live call (we only allow one). */
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
  const brain = d.brain ?? makeBrain(c)

  const handler = async (req: { headers: Record<string, unknown>; body: unknown; log: FastifyInstance['log'] }, reply: FastifyReply) => {
    if (!c.CUSTOM_LLM_SECRET) return reply.code(503).send({ error: 'custom LLM endpoint is not configured' })
    const auth = req.headers.authorization
    if (typeof auth !== 'string' || !safeEqual(auth, `Bearer ${c.CUSTOM_LLM_SECRET}`))
      return reply.code(401).send({ error: 'unauthorized' })

    const body = (req.body ?? {}) as Body
    const messages = Array.isArray(body.messages) ? body.messages : []
    const call = identifyCall(d, messages)
    const lastUser = textOf(messages.filter(m => m.role === 'user').at(-1)?.content)

    // Already hanging up: keep repeating the close line, never hand the turn back to the model.
    const prior = call?.hangup_requested_at && call.end_reason?.startsWith('hard_stop:')
      ? call.end_reason.slice('hard_stop:'.length) as keyof typeof CLOSE_LINES : null
    const stop = prior ?? detectHardStop(lastUser)

    let source: AsyncIterable<string>
    if (stop) {
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
      source = brain.reply(messages)
    }

    const filter = new OutputFilter(c.PRIVATE_TERMS)
    const id = 'chatcmpl-' + randomBytes(8).toString('hex'), created = Math.floor(Date.now() / 1000), model = body.model ?? c.BRAIN
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const finish = () => {
      if (filter.blocked.length) {
        audit(db, 'system', 'llm.output_blocked', call?.id ?? null, { reasons: filter.blocked }) // reasons only, never the text
        if (call) run(db, 'INSERT INTO call_events (call_id, source, type, data) VALUES (?, ?, ?, ?)',
          call.id, 'server', 'output_blocked', JSON.stringify({ reasons: filter.blocked }))
      }
    }

    if (body.stream === false) {
      let text = ''
      try { for await (const t of source) text += filter.push(t) } catch (e) { req.log.error(e, 'brain failed') }
      text += filter.flush()
      finish()
      return { id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: text.trim() }, finish_reason: 'stop' }] }
    }

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    let closed = false
    res.on('close', () => { closed = true })
    res.write(chunk({ role: 'assistant', content: '' }))
    try {
      for await (const t of source) {
        if (closed) break
        const out = filter.push(t)
        if (out) res.write(chunk({ content: out }))
      }
    } catch (e) {
      req.log.error(e, 'brain failed')
    }
    const tail = filter.flush()
    if (tail && !closed) res.write(chunk({ content: tail }))
    finish()
    if (!closed) { res.write(chunk({}, 'stop')); res.end('data: [DONE]\n\n') }
  }

  app.post('/llm/v1', handler)
  app.post('/llm/v1/chat/completions', handler)
}
