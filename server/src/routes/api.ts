// Read-only call log for the dashboard: {BASE_PATH}/api/calls[/:id[/recording]]. Bearer key, read (or agent) scope.
// Never returns brief/plan text to read-scope keys: the dashboard shows what happened, not Pete's instructions.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Deps, type CallRow, getCall, callEvents } from '../calls.ts'
import { authenticate } from '../auth.ts'
import { all } from '../db.ts'
import { getContact } from '../contacts.ts'

export function callSummary(d: Deps, c: CallRow) {
  return {
    id: c.id, status: c.status, dry_run: !!c.dry_run, to: c.to_e164, contact: getContact(d.db, c.to_e164)?.name ?? null,
    from: c.from_e164, from_label: c.from_label, agent: c.agent_id, purpose: c.purpose,
    created_at: c.created_at, started_at: c.started_at, ended_at: c.ended_at, duration_s: c.duration_s,
    end_reason: c.end_reason, error: c.error, answered_by: c.answered_by,
    summary_title: c.summary_title, summary: c.summary, cost_usd: c.cost_usd,
    has_recording: !!c.recording_path, recording_deleted: !!c.recording_deleted_at, finalized: !!c.finalized_at,
    brain: c.brain, tier: c.tier,
  }
}

type TurnRow = { id: number; started_at: string; brain: string; kind: string; job_id: string | null; attempts: number
  queued_ms: number | null; picked_ms: number | null; reply_ms: number | null; filtered_ms: number | null; tts_ms: number | null
  filler1_ms: number | null; filler2_ms: number | null; done_ms: number | null; outcome: string }

/** Per-turn timing (ms after ElevenLabs' request arrived) and a summary over the brain turns. */
export function callTurns(d: Deps, id: string) {
  const turns = all<TurnRow>(d.db, `SELECT id, started_at, brain, kind, job_id, attempts, queued_ms, picked_ms, reply_ms, filtered_ms,
    tts_ms, filler1_ms, filler2_ms, done_ms, outcome FROM call_turns WHERE call_id = ? ORDER BY id`, id)
  const brainTurns = turns.filter(t => t.kind === 'brain')
  const stat = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b)
    return v.length ? { n: v.length, median: v[Math.floor((v.length - 1) / 2)], max: v.at(-1)! } : null
  }
  const diff = (a: number | null, b: number | null) => (a != null && b != null ? a - b : null)
  return {
    turns,
    latency: {
      to_pickup_ms: stat(brainTurns.map(t => diff(t.picked_ms, t.queued_ms))), // queue wait (host poll)
      host_ms: stat(brainTurns.map(t => diff(t.reply_ms, t.picked_ms))),       // the phone session thinking
      to_reply_ms: stat(brainTurns.map(t => t.reply_ms)),                       // request -> answer
      to_tts_ms: stat(brainTurns.map(t => t.tts_ms)),                           // request -> answer text sent to ElevenLabs
      fillers: brainTurns.filter(t => t.filler1_ms != null).length,
      exits: brainTurns.filter(t => ['timeout', 'error', 'offline'].includes(t.outcome)).length,
      barge_ins: brainTurns.filter(t => t.outcome === 'barge_in').length,
    },
  }
}

export function callDetail(d: Deps, c: CallRow) {
  return {
    ...callSummary(d, c),
    transcript: c.transcript ? JSON.parse(c.transcript) as unknown[] : null,
    cost: { usd: c.cost_usd, elevenlabs_credits: c.el_cost_credits, twilio_usd: c.twilio_price_usd, amd: !!c.amd },
    events: callEvents(d.db, c.id),
    notes: JSON.parse(c.notes ?? '[]') as string[],
    ...callTurns(d, c.id),
  }
}

export async function apiRoutes(app: FastifyInstance, d: Deps) {
  const { db } = d
  const authed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const h = req.headers.authorization
    if (authenticate(db, h, 'read') || authenticate(db, h, 'agent')) return true
    void reply.code(401).send({ error: 'unauthorized' })
    return false
  }

  app.get('/api/calls', async (req, reply) => {
    if (!authed(req, reply)) return reply
    const q = req.query as { limit?: string; before?: string; status?: string }
    const where = ['1=1'], args: (string | number)[] = []
    if (q.before) { where.push('created_at < ?'); args.push(q.before) }
    if (q.status) { where.push('status = ?'); args.push(q.status) }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200)
    const rows = all<CallRow>(db, `SELECT * FROM calls WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`, ...args, limit)
    return { calls: rows.map(c => callSummary(d, c)) }
  })

  app.get('/api/calls/:id', async (req, reply) => {
    if (!authed(req, reply)) return reply
    const c = getCall(db, (req.params as { id: string }).id)
    return c ? callDetail(d, c) : reply.code(404).send({ error: 'not found' })
  })

  app.get('/api/calls/:id/recording', async (req, reply) => {
    if (!authed(req, reply)) return reply
    const c = getCall(db, (req.params as { id: string }).id)
    const file = c?.recording_path ? join(d.config.DATA_DIR, c.recording_path) : null
    if (!file || !existsSync(file)) return reply.code(404).send({ error: 'no recording' })
    return reply.type('audio/mpeg').header('cache-control', 'private, no-store').send(createReadStream(file))
  })
}
