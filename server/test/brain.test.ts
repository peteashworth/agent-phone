import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'
import { createKey } from '../src/auth.ts'
import { placeCall, getCall, warming, CallRefused } from '../src/calls.ts'
import { claimNext, submitResult, markPoll, getJob, enqueueJob, type JobRow } from '../src/brainJobs.ts'
import { TurnLog, prepareJasmineTurn, runJasmineTurn } from '../src/voice/brainTurn.ts'
import { EXIT_LINE, FILLER_LINES, FILLER2_LINE, CODE_ATTEMPT_PLACEHOLDER } from '../src/voice/lines.ts'
import { findPhrase, removePhrase } from '../src/voice/codePhrase.ts'
import { OutputFilter } from '../src/voice/outputFilter.ts'
import { redact } from '../src/postcall.ts'
import { callDetail } from '../src/routes/api.ts'
import { all } from '../src/db.ts'
import { setup, LIVE_ENV } from './helpers.ts'

const SECRET = 'x'.repeat(32)
const AUTH = { authorization: `Bearer ${SECRET}` }
const PHRASE = 'purple otter river lamp'
let app: FastifyInstance | undefined
let stopHost: (() => void) | undefined
afterEach(async () => { stopHost?.(); stopHost = undefined; await app?.close(); app = undefined })

type Answer = Record<string, unknown> | ((job: JobRow) => Record<string, unknown> | null)
/** In-process stand-in for Pete's host adapter: answers call.start with ready, turns from the script. */
function fakeHost(d: ReturnType<typeof setup>, turns: Answer[] = [], opts: { delayMs?: number; start?: Record<string, unknown> } = {}) {
  const seen: JobRow[] = []
  let stopped = false
  const loop = async () => {
    while (!stopped) {
      markPoll(d.db, 'jasmine')
      const job = claimNext(d.db)
      if (!job) { await new Promise(r => setTimeout(r, 5)); continue }
      seen.push(job)
      if (job.type === 'call.end') continue
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
      if (job.type === 'call.start') { submitResult(d.db, job.id, opts.start ?? { ready: true }); continue }
      const a = turns.shift() ?? { say: 'Okay.' }
      const res = typeof a === 'function' ? a(job) : a
      if (res) submitResult(d.db, job.id, res)
    }
  }
  void loop()
  stopHost = () => { stopped = true }
  return seen
}

async function start(env: Record<string, string> = {}, input: Record<string, unknown> = {}, host?: Parameters<typeof fakeHost>) {
  const d = setup({ ...LIVE_ENV, CUSTOM_LLM_SECRET: SECRET, AMD_ENABLED: 'false', BRAIN: 'jasmine', CODE_PHRASE: PHRASE,
    FILLER_AFTER_MS: '10000', FILLER2_AFTER_MS: '0', ...env })
  app = await buildApp({ config: d.config, db: d.db, clients: d })
  const seen = fakeHost(d, ...((host?.slice(1) ?? []) as [Answer[]?, { delayMs?: number }?]))
  const placed = await placeCall(d, 'jasmine', { to: '+14358403707', purpose: 'test', brief: 'say hi', dry_run: false, ...input })
  await warming.get(placed.id)
  return { d, call: getCall(d.db, placed.id)!, seen }
}

function spoken(body: string): string {
  return body.split('\n\n').filter(l => l.startsWith('data: {'))
    .map(l => JSON.parse(l.slice(6)).choices[0].delta.content ?? '').join('')
}
/** ElevenLabs' request: the whole conversation so far, user lines as given. */
const turn = (callId: string, ...user: string[]) => ({
  model: 'x', stream: true,
  messages: [{ role: 'system', content: `call_id: ${callId}` }, ...user.flatMap(u => [{ role: 'assistant', content: 'Hi' }, { role: 'user', content: u }])],
})
const ask = (callId: string, ...user: string[]) => app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(callId, ...user) })

describe('brain job routes', () => {
  it('need a brain-scope key; 204 when idle; claim, answer, 409 on a second answer', async () => {
    const d = setup({ ...LIVE_ENV })
    app = await buildApp({ config: d.config, db: d.db, clients: d })
    const brain = createKey(d.db, 'jasmine', 'brain').key, agent = createKey(d.db, 'jasmine', 'agent').key
    expect((await app.inject({ url: '/phone/brain/next?wait=0' })).statusCode).toBe(401)
    expect((await app.inject({ url: '/phone/brain/next?wait=0', headers: { authorization: `Bearer ${agent}` } })).statusCode).toBe(401)
    const H = { authorization: `Bearer ${brain}` }
    expect((await app.inject({ url: '/phone/brain/next?wait=0', headers: H })).statusCode).toBe(204)
    const call = await placeCall(d, 'jasmine', { to: '+14358403707', purpose: 'p', brief: 'b' })
    const job = enqueueJob(d.db, call.id, 'turn', { user_text: 'hello' }, 5000, { seq: 1 })
    const got = await app.inject({ url: '/phone/brain/next?wait=1', headers: H })
    expect(got.json()).toMatchObject({ job_id: job.id, type: 'turn', call_id: call.id, seq: 1, user_text: 'hello' })
    const url = `/phone/brain/jobs/${job.id}/result`
    expect((await app.inject({ method: 'POST', url, headers: H, payload: { say: 'x'.repeat(5000) } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url, headers: H, payload: { say: 'Hi there.' } })).json()).toEqual({ ok: true })
    expect((await app.inject({ method: 'POST', url, headers: H, payload: { say: 'again' } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/phone/brain/jobs/job_nope/result', headers: H, payload: {} })).statusCode).toBe(404)
    expect(getJob(d.db, job.id)).toMatchObject({ status: 'done' })
  })
  it('a long-poll wakes as soon as a job is queued', async () => {
    const d = setup({ ...LIVE_ENV })
    app = await buildApp({ config: d.config, db: d.db, clients: d })
    const H = { authorization: `Bearer ${createKey(d.db, 'jasmine', 'brain').key}` }
    const call = await placeCall(d, 'jasmine', { to: '+14358403707', purpose: 'p', brief: 'b' })
    const t = Date.now()
    const poll = app.inject({ url: '/phone/brain/next?wait=10', headers: H })
    setTimeout(() => enqueueJob(d.db, call.id, 'turn', {}, 5000), 50)
    expect((await poll).statusCode).toBe(200)
    expect(Date.now() - t).toBeLessThan(2000)
  })
})

describe('warm-up before dialing', () => {
  it('dials only after the phone session says ready; call.start has no personal material', async () => {
    const { d, call, seen } = await start({}, { brief_personal: 'secret context' })
    expect(d.dials).toHaveLength(1)
    expect(call.status).toBe('queued')
    const startJob = seen.find(j => j.type === 'call.start')!
    expect(startJob.payload).not.toContain('secret context')
    expect(JSON.parse(startJob.payload)).toMatchObject({ purpose: 'test', brief: 'say hi', has_brief_personal: true })
  })
  it('not ready: never dials, ends as brain_not_ready', async () => {
    const d = setup({ ...LIVE_ENV, BRAIN: 'jasmine' })
    fakeHost(d, [], { start: { ready: false } })
    const placed = await placeCall(d, 'jasmine', { to: '+14358403707', purpose: 'p', brief: 'b', dry_run: false })
    expect(placed.status).toBe('warming')
    await warming.get(placed.id)
    expect(d.dials).toHaveLength(0)
    expect(getCall(d.db, placed.id)).toMatchObject({ status: 'failed', end_reason: 'brain_not_ready' })
  })
  it('host offline: refused, nothing queued', async () => {
    const d = setup({ ...LIVE_ENV, BRAIN: 'jasmine' })
    await expect(placeCall(d, 'jasmine', { to: '+14358403707', purpose: 'p', brief: 'b', dry_run: false }))
      .rejects.toMatchObject({ code: 'brain_offline' })
    expect(d.dials).toHaveLength(0)
  })
  it('brief_personal is refused for other brains and for numbers that can never unlock it', async () => {
    const d = setup({ ...LIVE_ENV })
    await expect(placeCall(d, 'jasmine', { to: '+14358403707', purpose: 'p', brief: 'b', brief_personal: 'x' }))
      .rejects.toBeInstanceOf(CallRefused)
    const e = setup({ ...LIVE_ENV, PERSONAL_OK_NUMBERS: '+14350000000' })
    await expect(placeCall(e, 'jasmine', { to: '+14358403707', purpose: 'p', brief: 'b', brief_personal: 'x', brain: 'jasmine' }))
      .rejects.toMatchObject({ code: 'brief_personal_not_allowed' })
  })
})

describe('jasmine turns', () => {
  it('relays the answer, sends only the new user text, logs timing', async () => {
    const { d, call, seen } = await start({}, {}, [undefined as never, [{ say: 'Hello Pete.' }, { say: 'Sure thing.' }]])
    expect(spoken((await ask(call.id, 'hello')).body)).toBe('Hello Pete.')
    expect(spoken((await ask(call.id, 'hello', 'how are you')).body)).toBe('Sure thing.')
    const turns = seen.filter(j => j.type === 'turn').map(j => JSON.parse(j.payload))
    expect(turns.map(t => t.user_text)).toEqual(['hello', 'how are you'])
    const detail = callDetail({ ...d }, getCall(d.db, call.id)!) as { turns: { kind: string; outcome: string; picked_ms: number }[]; latency: { to_reply_ms: { n: number } } }
    expect(detail.turns.map(t => [t.kind, t.outcome])).toEqual([['brain', 'ok'], ['brain', 'ok']])
    expect(detail.turns[0].picked_ms).not.toBeNull()
    expect(detail.latency.to_reply_ms.n).toBe(2)
  })
  it('fillers play while the host thinks', async () => {
    const { call } = await start({ FILLER_AFTER_MS: '40', FILLER2_AFTER_MS: '120' }, {}, [undefined as never, [{ say: 'Done.' }], { delayMs: 250 }])
    // delayMs also slows call.start; the turn itself is the second answer
    const r = await ask(call.id, 'check something')
    expect(spoken(r.body)).toBe(FILLER_LINES[1] + FILLER2_LINE + 'Done.')
  })
  it('one retry on a host error, then the exit line and a hangup', async () => {
    const { d, call } = await start({}, {}, [undefined as never, [{ error: 'busy' }, { say: 'Back now.' }, { error: 'busy' }, { error: 'down' }]])
    expect(spoken((await ask(call.id, 'hi')).body)).toBe('Back now.')
    expect(spoken((await ask(call.id, 'hi', 'again')).body)).toBe(EXIT_LINE)
    expect(getCall(d.db, call.id)!.end_reason).toBe('brain_timeout')
    // later turns while the hangup lands: the exit line again, no new job
    expect(spoken((await ask(call.id, 'hi', 'again', 'hello?')).body)).toBe(EXIT_LINE)
  })
  it('no answer within TURN_TIMEOUT_S: exit line, hangup', async () => {
    const { d, call } = await start({ TURN_TIMEOUT_S: '3' }, {}, [undefined as never, [() => null]])
    expect(spoken((await ask(call.id, 'hi')).body)).toBe(EXIT_LINE)
    expect(getCall(d.db, call.id)!.end_reason).toBe('brain_timeout')
    expect(all<{ outcome: string }>(d.db, 'SELECT outcome FROM call_turns WHERE call_id = ?', call.id).map(r => r.outcome)).toEqual(['timeout'])
  }, 10_000)
  it('offline host mid-call: exit line', async () => {
    const { d, call } = await start({ BRAIN_OFFLINE_S: '5' })
    stopHost?.()
    d.db.prepare("UPDATE brain_host SET last_poll_at = '2020-01-01T00:00:00Z'").run()
    expect(spoken((await ask(call.id, 'hi')).body)).toBe(EXIT_LINE)
    expect(getCall(d.db, call.id)!.end_reason).toBe('brain_offline')
  })
  it('[[end_call]] hangs up after the line; notes are kept for Jasmine', async () => {
    const { d, call } = await start({}, {}, [undefined as never, [{ say: 'Bye now. [[end_call]] [[note: Pete wants the blue one]]' }]])
    expect(spoken((await ask(call.id, 'bye')).body)).toBe('Bye now.')
    expect(getCall(d.db, call.id)).toMatchObject({ end_reason: 'brain_end', notes: JSON.stringify(['Pete wants the blue one']) })
  })
  it('barge-in cancels the job', async () => {
    const { d, call } = await start({}, {}, [undefined as never, [() => null]])
    const log = new TurnLog(d, call, 'jasmine', 'brain')
    const p = prepareJasmineTurn(d, call, turn(call.id, 'hi').messages as never, log)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const out: string[] = []
    for await (const t of runJasmineTurn(d, p, log, ac.signal)) out.push(t)
    expect(out).toEqual([])
    expect(log.outcome).toBe('barge_in')
    expect(getJob(d.db, log.jobId!)!.status).toBe('cancelled')
  })
})

describe('code phrase', () => {
  it('matches loosely, removes cleanly', () => {
    expect(findPhrase('um it is Purple, otter... river lamp!', PHRASE)).not.toBeNull()
    expect(findPhrase('purple otter lamp river', PHRASE)).toBeNull()
    expect(removePhrase('sure, purple otter river lamp okay', PHRASE)).toEqual({ found: true, text: 'sure, okay' })
  })
  it('verified: phrase cut out, personal tier, brief_personal goes out once', async () => {
    const { d, call, seen } = await start({}, { brief_personal: 'the private bit' },
      [undefined as never, [{ say: 'What is the code phrase? [[ask_code]]' }, { say: 'Thanks.' }, { say: 'Next.' }]])
    await ask(call.id, 'hi')
    expect(getCall(d.db, call.id)!.code_asked).toBe(1)
    await ask(call.id, 'hi', 'it is purple otter river lamp')
    await ask(call.id, 'hi', 'it is purple otter river lamp', 'what now')
    const turns = seen.filter(j => j.type === 'turn').map(j => JSON.parse(j.payload))
    expect(turns[1]).toMatchObject({ code_phrase: 'verified', tier: 'personal', user_text: 'it is', brief_personal: 'the private bit' })
    expect(JSON.stringify(turns)).not.toContain('otter')
    expect(turns[2]).toMatchObject({ code_phrase: null, user_text: 'what now' })
    expect(turns[2].brief_personal).toBeUndefined()
    const t = redact(d, call.id, [{ role: 'user', text: 'it is purple otter river lamp', time_in_call_secs: 1 }] as never)
    expect(t[0].text).not.toContain('otter')
  })
  it('a wrong attempt is withheld and counted; lockout after the limit', async () => {
    const asks = () => ({ say: 'Code phrase? [[ask_code]]' })
    const { d, call, seen } = await start({ CODE_PHRASE_MAX_ATTEMPTS: '1' }, {}, [undefined as never, [asks(), asks(), { say: 'ok' }]])
    await ask(call.id, 'hi')
    await ask(call.id, 'hi', 'blue fox sea')
    const turns = seen.filter(j => j.type === 'turn').map(j => JSON.parse(j.payload))
    expect(turns[1]).toMatchObject({ code_phrase: 'incorrect', user_text: CODE_ATTEMPT_PLACEHOLDER, code_locked: true })
    expect(redact(d, call.id, [{ role: 'user', text: 'blue fox sea', time_in_call_secs: 1 }] as never)[0].text).toBe('[code phrase attempt removed]')
    await ask(call.id, 'hi', 'blue fox sea', 'purple otter river lamp')
    expect(getCall(d.db, call.id)!.tier).toBe('public') // locked: even the right phrase no longer unlocks
  })
  it('never unlocks for a callee outside PERSONAL_OK_NUMBERS', async () => {
    const { d, call } = await start({ PERSONAL_OK_NUMBERS: '+14350000000' })
    await ask(call.id, 'purple otter river lamp')
    expect(getCall(d.db, call.id)!.tier).toBe('public')
  })
})

describe('output filter tiers', () => {
  it('intimate terms are blocked in every tier', () => {
    for (const personal of [false, true]) {
      const f = new OutputFilter([], { personal, intimate: ['velvetword'] })
      expect(f.push('Sure. ') + f.push('That is velvetword stuff. ') + f.flush()).not.toContain('velvetword')
    }
  })
})
