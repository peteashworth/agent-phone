// Pete's host adapter side of BRAIN=jasmine (docs/milestone-d-brain.md §1-§2). Brain-scope bearer key only.
//   GET  {BASE_PATH}/brain/next?wait=25        long-poll: 200 + job, or 204 when nothing came within `wait` seconds
//   POST {BASE_PATH}/brain/jobs/:id/result     the answer; 409 = cancelled/expired/already answered (drop it)
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps } from '../calls.ts'
import { authenticate } from '../auth.ts'
import { nextJob, unclaim, submitResult, markPoll, jobView } from '../brainJobs.ts'

export const resultSchema = z.object({
  ready: z.boolean().optional(),                    // call.start
  say: z.string().max(4000).optional(),             // turn (may also carry [[end_call]] / [[ask_code]] / [[note: …]] tags)
  end_call: z.boolean().optional(),
  ask_code: z.boolean().optional(),
  note_for_jasmine: z.string().max(1000).nullable().optional(),
  error: z.string().max(500).optional(),            // the host couldn't answer (busy, session down): retried once
})
export type BrainResult = z.infer<typeof resultSchema>

const MAX_WAIT_S = 55

export async function brainRoutes(app: FastifyInstance, d: Deps) {
  const { db } = d

  app.get('/brain/next', async (req, reply) => {
    const host = authenticate(db, req.headers.authorization, 'brain')
    if (!host) return reply.code(401).send({ error: 'unauthorized' })
    const wait = Math.min(Math.max(Number((req.query as { wait?: string }).wait ?? 25) || 0, 0), MAX_WAIT_S)
    const ac = new AbortController()
    req.raw.on('close', () => { if (!reply.raw.writableEnded) ac.abort() })
    markPoll(db, host)
    const job = await nextJob(db, wait * 1000, ac.signal)
    markPoll(db, host)
    if (ac.signal.aborted) { if (job) unclaim(db, job.id); return reply }
    if (!job) return reply.code(204).send()
    req.log.info({ job: job.id, type: job.type, call: job.call_id }, 'brain job out')
    return jobView(job)
  })

  app.post('/brain/jobs/:id/result', async (req, reply) => {
    const host = authenticate(db, req.headers.authorization, 'brain')
    if (!host) return reply.code(401).send({ error: 'unauthorized' })
    markPoll(db, host)
    const parsed = resultSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: z.prettifyError(parsed.error) })
    const outcome = submitResult(db, (req.params as { id: string }).id, parsed.data)
    if (outcome === 'not_found') return reply.code(404).send({ error: 'no such job' })
    if (outcome === 'conflict') return reply.code(409).send({ error: 'job is no longer waiting for an answer; drop it' })
    return { ok: true }
  })
}
