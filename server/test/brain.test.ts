import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'
import { createKey } from '../src/auth.ts'
import { placeCall, getCall, warming, CallRefused } from '../src/calls.ts'
import { claimNext, submitResult, markPoll, getJob, enqueueJob, type JobRow } from '../src/brainJobs.ts'
import { TurnLog, prepareJasmineTurn, runJasmineTurn, onlyFiller } from '../src/voice/brainTurn.ts'
import { EXIT_LINE, FILLER_LINES, FILLER2_LINE, CODE_ATTEMPT_PLACEHOLDER, pickFiller } from '../src/voice/lines.ts'
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
    FILLER_AFTER_MS: '10000', FILLER2_AFTER_MS: '0', SETTLE_MS: '0', ...env })
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
    const body = spoken(r.body)
    expect(FILLER_LINES.some(l => body === l + FILLER2_LINE + 'Done.')).toBe(true)
  })
  it('the filler rotates and never repeats the last one on the call', async () => {
    const { call } = await start({ FILLER_AFTER_MS: '30', FILLER2_AFTER_MS: '0' }, {},
      [undefined as never, [{ say: 'A.' }, { say: 'B.' }, { say: 'C.' }, { say: 'D.' }], { delayMs: 120 }])
    const heard: string[] = []
    const said = ['one', 'two', 'three', 'four']
    for (let i = 1; i <= 4; i++) heard.push(spoken((await ask(call.id, ...said.slice(0, i))).body))
    const used = heard.map(h => FILLER_LINES.findIndex(l => h.startsWith(l)))
    expect(used.every(i => i >= 0)).toBe(true)
    for (let i = 1; i < used.length; i++) expect(used[i]).not.toBe(used[i - 1])
  })
  it('pickFiller skips the last index', () => {
    for (let last = -1; last < FILLER_LINES.length; last++)
      for (const r of [0, 0.3, 0.6, 0.999]) {
        const i = pickFiller(last, () => r)
        expect(i).not.toBe(last); expect(FILLER_LINES[i]).toBeDefined()
      }
  })
  it('one retry on a host error, then the exit line and a hangup', async () => {
    const { d, call } = await start({}, {}, [undefined as never, [{ error: 'busy' }, { say: 'Back now.' }, { error: 'busy' }, { error: 'down' }]])
    expect(spoken((await ask(call.id, 'hi')).body)).toBe('Back now.')
    expect(spoken((await ask(call.id, 'hi', 'again')).body)).toBe(EXIT_LINE)
    expect(getCall(d.db, call.id)!.end_reason).toBe('brain_timeout')
    // later turns while the hangup lands: silent (the exit line is said once), no new job
    expect(spoken((await ask(call.id, 'hi', 'again', 'hello?')).body)).toBe('') // said once already
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

describe('continuation (one sentence split on a pause)', () => {
  /** Turn 1 as the route runs it, then dropped by ElevenLabs (the close handler's barge_in) after `abortMs`. */
  async function dropped(d: ReturnType<typeof setup>, call: ReturnType<typeof getCall> & object, user: string[], opts: { abortMs?: number; spoke?: string } = {}) {
    const log = new TurnLog(d, call, 'jasmine', 'brain')
    const p = prepareJasmineTurn(d, call, turn(call.id, ...user).messages as never, log)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), opts.abortMs ?? 60)
    for await (const t of runJasmineTurn(d, p, log, ac.signal)) log.spoke(t)
    if (opts.spoke) log.spoke(opts.spoke)
    log.outcome = 'barge_in'; log.save()
    return p
  }
  const payloads = (seen: JobRow[]) => seen.filter(j => j.type === 'turn').map(j => JSON.parse(j.payload))
  const outcomes = (d: ReturnType<typeof setup>, id: string) =>
    all<{ outcome: string }>(d.db, 'SELECT outcome FROM call_turns WHERE call_id = ? ORDER BY id', id).map(r => r.outcome)

  it('dropped with nothing said, rewritten in place: merged text, continued (not barge_in), host told which seq it replaces', async () => {
    const { d, call, seen } = await start({}, {}, [undefined as never, [() => null, { say: 'Nice.' }]])
    const p1 = await dropped(d, call, ['Uh, just trying'])
    expect(getJob(d.db, seen.find(j => j.type === 'turn')!.id)!.picked_at).not.toBeNull()
    expect(spoken((await ask(call.id, "Uh, just trying to work on Celine's body kit. You?")).body)).toBe('Nice.')
    const [, second] = payloads(seen)
    expect(second).toMatchObject({ user_text: "Uh, just trying to work on Celine's body kit. You?", continues: p1.seq, interrupted: null })
    expect(outcomes(d, call.id)).toEqual(['continued', 'ok'])
    expect(all(d.db, "SELECT 1 FROM call_events WHERE call_id = ? AND type = 'continuation'", call.id)).toHaveLength(1)
  })
  it('the rest as its own message: both fragments go out together; a filler-only turn still counts as nothing said', async () => {
    const { d, call, seen } = await start({ FILLER_AFTER_MS: '20' }, {}, [undefined as never, [() => null, { say: 'Got it.' }]])
    await dropped(d, call, ['Uh, just trying'], { abortMs: 80 })
    expect(FILLER_LINES.some(l => all<{ said: string }>(d.db, 'SELECT said FROM call_turns WHERE call_id = ?', call.id)[0].said === l)).toBe(true)
    expect(spoken((await ask(call.id, 'Uh, just trying', 'to work on the kit.')).body)).toBe('Got it.')
    expect(payloads(seen)[1].user_text).toBe('Uh, just trying to work on the kit.')
    expect(outcomes(d, call.id)).toEqual(['continued', 'ok'])
  })
  it('a fragment repeated inside the whole sentence is sent once', async () => {
    const { d, call, seen } = await start({}, {}, [undefined as never, [() => null, { say: 'Ok.' }]])
    await dropped(d, call, ['Things are going'])
    await ask(call.id, 'Things are going', 'Things are going well, thanks.')
    expect(payloads(seen)[1].user_text).toBe('Things are going well, thanks.')
  })
  it('the open request is taken over when the next one arrives first; the old one goes quiet', async () => {
    const { d, call, seen } = await start({}, {}, [undefined as never, [() => null, { say: 'Sure.' }]])
    const first = ask(call.id, 'Can you')
    while (!seen.some(j => j.type === 'turn')) await new Promise(r => setTimeout(r, 5))
    const second = await ask(call.id, 'Can you check the date?')
    expect(spoken(second.body)).toBe('Sure.')
    expect(spoken((await first).body)).toBe('')
    expect(payloads(seen)[1]).toMatchObject({ user_text: 'Can you check the date?', continues: 1 })
    expect(outcomes(d, call.id)).toEqual(['continued', 'ok'])
  })
  it('a real answer already started: barge-in as before (interrupted, no merge)', async () => {
    const { d, call, seen } = await start({}, {}, [undefined as never, [() => null, { say: 'Okay.' }]])
    await dropped(d, call, ['what day is it'], { spoke: 'It is Thursday, Oct' })
    await ask(call.id, 'what day is it', 'never mind')
    const [, second] = payloads(seen)
    expect(second.user_text).toBe('never mind')
    expect(second.continues).toBeUndefined()
    expect(second.interrupted).not.toBeNull()
    expect(outcomes(d, call.id)).toEqual(['barge_in', 'ok'])
  })
  it('later than CONTINUATION_MS: barge-in as before', async () => {
    const { d, call, seen } = await start({ CONTINUATION_MS: '1' }, {}, [undefined as never, [() => null, { say: 'Okay.' }]])
    await dropped(d, call, ['Uh, just trying'])
    await new Promise(r => setTimeout(r, 20))
    await ask(call.id, 'Uh, just trying', 'to work on the kit.')
    expect(payloads(seen)[1].user_text).toBe('to work on the kit.')
    expect(outcomes(d, call.id)).toEqual(['barge_in', 'ok'])
  })
  it('never an empty user_text: a last message rewritten in place is sent again', async () => {
    const { d, call, seen } = await start({ CONTINUATION_MS: '0' }, {}, [undefined as never, [() => null, { say: 'Okay.' }]])
    await dropped(d, call, ['Uh, just trying'])
    await ask(call.id, 'Uh, just trying to work on the kit.')
    expect(payloads(seen)[1].user_text).toBe('Uh, just trying to work on the kit.')
    expect(all(d.db, "SELECT 1 FROM call_events WHERE call_id = ? AND type = 'user_text_rewritten'", call.id)).toHaveLength(1)
  })
  it('onlyFiller', () => {
    expect(onlyFiller(null)).toBe(true)
    expect(onlyFiller(FILLER_LINES[2] + FILLER2_LINE)).toBe(true)
    expect(onlyFiller(FILLER_LINES[0] + 'It is Thursday.')).toBe(false)
  })
})

describe('settle (ElevenLabs re-sends every ~150ms mid-speech)', () => {
  const turnJobs = (seen: JobRow[]) => seen.filter(j => j.type === 'turn').map(j => JSON.parse(j.payload))
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  it('a burst sends one turn to the host: the newest; the superseded requests answer empty and leave no turn row', async () => {
    const { d, call, seen } = await start({ SETTLE_MS: '120' }, {}, [undefined as never, [{ say: 'Nice.' }]])
    const a = ask(call.id, 'Uh, just')
    await sleep(40); const b = ask(call.id, 'Uh, just trying')
    await sleep(40); const c = ask(call.id, 'Uh, just trying to work on the kit.')
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect([spoken(ra.body), spoken(rb.body), spoken(rc.body)]).toEqual(['', '', 'Nice.'])
    expect(turnJobs(seen)).toHaveLength(1)
    expect(turnJobs(seen)[0]).toMatchObject({ user_text: 'Uh, just trying to work on the kit.' })
    expect(all<{ outcome: string }>(d.db, 'SELECT outcome FROM call_turns WHERE call_id = ?', call.id).map(r => r.outcome)).toEqual(['ok'])
  })
  it('a lone request waits SETTLE_MS, then goes to the host as usual', async () => {
    const { call, seen } = await start({ SETTLE_MS: '100' }, {}, [undefined as never, [{ say: 'Hi there.' }]])
    const t0 = Date.now()
    const r = ask(call.id, 'Hello?')
    await sleep(50)
    expect(turnJobs(seen)).toHaveLength(0)
    expect(spoken((await r).body)).toBe('Hi there.')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100)
    expect(turnJobs(seen)).toHaveLength(1)
  })
  it('requests further apart than SETTLE_MS each go through (the merge window handles those)', async () => {
    const { call, seen } = await start({ SETTLE_MS: '30' }, {}, [undefined as never, [{ say: 'One.' }, { say: 'Two.' }]])
    expect(spoken((await ask(call.id, 'First thing.')).body)).toBe('One.')
    expect(spoken((await ask(call.id, 'First thing.', 'Second thing.')).body)).toBe('Two.')
    expect(turnJobs(seen)).toHaveLength(2)
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
