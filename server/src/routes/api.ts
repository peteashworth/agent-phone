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
  }
}

export function callDetail(d: Deps, c: CallRow) {
  return {
    ...callSummary(d, c),
    transcript: c.transcript ? JSON.parse(c.transcript) as unknown[] : null,
    cost: { usd: c.cost_usd, elevenlabs_credits: c.el_cost_credits, twilio_usd: c.twilio_price_usd, amd: !!c.amd },
    events: callEvents(d.db, c.id),
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
