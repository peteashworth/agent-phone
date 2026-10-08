// The job queue between the droplet and Pete's host adapter (docs/milestone-d-brain.md §1-§2). The host long-polls
// GET /brain/next and answers with POST /brain/jobs/:id/result. SQLite is the record; an in-process event emitter per
// database wakes waiters without polling.
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { Config } from './config.ts'
import { type DB, one, run } from './db.ts'

export type JobType = 'call.start' | 'turn' | 'call.end'
export type JobStatus = 'queued' | 'picked' | 'done' | 'failed' | 'cancelled' | 'expired'
export type JobRow = {
  id: string; call_id: string; type: JobType; seq: number | null; payload: string; users_upto: number | null
  status: JobStatus; created_at: string; picked_at: string | null; answered_at: string | null; deadline_at: string
  result: string | null; error: string | null
}

const hubs = new WeakMap<DB, EventEmitter>()
function hub(db: DB): EventEmitter {
  let h = hubs.get(db)
  if (!h) { h = new EventEmitter(); h.setMaxListeners(0); hubs.set(db, h) }
  return h
}

const OPEN = "('queued','picked')"
const iso = (ms = Date.now()) => new Date(ms).toISOString()

export function getJob(db: DB, id: string): JobRow | undefined {
  return one<JobRow>(db, 'SELECT * FROM brain_jobs WHERE id = ?', id)
}

export function enqueueJob(db: DB, callId: string, type: JobType, payload: object, deadlineMs: number,
  extra: { seq?: number; users_upto?: number } = {}): JobRow {
  const id = 'job_' + randomBytes(9).toString('base64url')
  run(db, 'INSERT INTO brain_jobs (id, call_id, type, seq, payload, users_upto, deadline_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, callId, type, extra.seq ?? null, JSON.stringify(payload), extra.users_upto ?? null, iso(Date.now() + deadlineMs))
  hub(db).emit('queued')
  return getJob(db, id)!
}

function settle(db: DB, id: string) { hub(db).emit('job:' + id) }

/** Marks overdue open jobs expired (their answers will get 409). */
function expireOverdue(db: DB) {
  const now = iso()
  const rows = db.prepare(`SELECT id FROM brain_jobs WHERE status IN ${OPEN} AND deadline_at < ?`).all(now) as { id: string }[]
  for (const r of rows) { run(db, `UPDATE brain_jobs SET status = 'expired' WHERE id = ? AND status IN ${OPEN}`, r.id); settle(db, r.id) }
}

/** Takes the oldest queued job, if any. */
export function claimNext(db: DB): JobRow | undefined {
  expireOverdue(db)
  const job = one<JobRow>(db, "SELECT * FROM brain_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1")
  if (!job) return undefined
  const r = run(db, "UPDATE brain_jobs SET status = 'picked', picked_at = ? WHERE id = ? AND status = 'queued'", iso(), job.id)
  if (!r.changes) return undefined
  settle(db, job.id)
  return getJob(db, job.id)
}

/** The host's request went away before it got the job: put it back. */
export function unclaim(db: DB, id: string) {
  run(db, "UPDATE brain_jobs SET status = 'queued', picked_at = NULL WHERE id = ? AND status = 'picked'", id)
  hub(db).emit('queued')
}

/** Long-poll: a job as soon as one is queued, or undefined after waitMs (or when the request is aborted). */
export async function nextJob(db: DB, waitMs: number, signal?: AbortSignal): Promise<JobRow | undefined> {
  const until = Date.now() + waitMs
  for (;;) {
    const job = claimNext(db)
    if (job || signal?.aborted || Date.now() >= until) return job
    await wake(db, 'queued', Math.min(until - Date.now(), 1000), signal) // 1s re-check also catches expiries
  }
}

function wake(db: DB, name: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const h = hub(db)
    const done = () => { clearTimeout(t); h.off(name, done); signal?.removeEventListener('abort', done); resolve() }
    const t = setTimeout(done, Math.max(ms, 0))
    h.on(name, done)
    signal?.addEventListener('abort', done)
  })
}

/** Waits until the job is answered, cancelled or expired, or timeoutMs passes. Returns the row as it stands. */
export async function awaitJob(db: DB, id: string, timeoutMs: number, signal?: AbortSignal): Promise<JobRow> {
  const until = Date.now() + timeoutMs
  for (;;) {
    expireOverdue(db)
    const job = getJob(db, id)!
    if (!['queued', 'picked'].includes(job.status) || signal?.aborted || Date.now() >= until) return job
    await wake(db, 'job:' + id, Math.min(until - Date.now(), 1000), signal)
  }
}

export type SubmitOutcome = 'ok' | 'not_found' | 'conflict'

/** The host's answer. Only a picked job inside its deadline is accepted; anything else is stale (409). */
export function submitResult(db: DB, id: string, result: { error?: string } & Record<string, unknown>): SubmitOutcome {
  expireOverdue(db)
  const job = getJob(db, id)
  if (!job) return 'not_found'
  if (job.status !== 'picked') return 'conflict'
  const failed = typeof result.error === 'string'
  run(db, 'UPDATE brain_jobs SET status = ?, answered_at = ?, result = ?, error = ? WHERE id = ? AND status = \'picked\'',
    failed ? 'failed' : 'done', iso(), JSON.stringify(result), failed ? String(result.error).slice(0, 500) : null, id)
  settle(db, id)
  return 'ok'
}

export function cancelJob(db: DB, id: string, status: 'cancelled' | 'expired' = 'cancelled') {
  const r = run(db, `UPDATE brain_jobs SET status = ? WHERE id = ? AND status IN ${OPEN}`, status, id)
  if (r.changes) settle(db, id)
}

/** What the host receives: the job envelope plus its payload. */
export function jobView(job: JobRow) {
  return { job_id: job.id, type: job.type, call_id: job.call_id, deadline_at: job.deadline_at,
    ...(job.seq != null ? { seq: job.seq } : {}), ...JSON.parse(job.payload) as object }
}

// ---------------------------------------------------------------- liveness

export function markPoll(db: DB, agentId: string) {
  run(db, `INSERT INTO brain_host (id, agent_id, last_poll_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id, last_poll_at = excluded.last_poll_at`, agentId, iso())
}

/** True while a poll is held open or the last one ended less than BRAIN_OFFLINE_S ago. */
export function brainOnline(c: Config, db: DB): boolean {
  const row = one<{ last_poll_at: string }>(db, 'SELECT last_poll_at FROM brain_host WHERE id = 1')
  return !!row && Date.now() - Date.parse(row.last_poll_at) < c.BRAIN_OFFLINE_S * 1000
}

export function brainStatus(c: Config, db: DB) {
  const row = one<{ agent_id: string; last_poll_at: string }>(db, 'SELECT agent_id, last_poll_at FROM brain_host WHERE id = 1')
  const queued = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM brain_jobs WHERE status = 'queued'")!.n
  return { online: brainOnline(c, db), host: row?.agent_id ?? null, last_poll_at: row?.last_poll_at ?? null, queued }
}
