import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'
import { twilioSignature } from '../src/auth.ts'
import { getCall, placeCall, watchdog, type CallRow } from '../src/calls.ts'
import { claimNext, markPoll, submitResult, type JobRow } from '../src/brainJobs.ts'
import { all, run } from '../src/db.ts'
import { NO_INCOMING_LINE, PETE_OPENER, PETE_UNAVAILABLE_LINE } from '../src/voice/lines.ts'
import { setup, LIVE_ENV } from './helpers.ts'

const SECRET = 'x'.repeat(32)
const PHRASE = 'purple otter river lamp'
const PETE = '+14358403707', OURS = '+14352644845', STRANGER = '+14352419384'
let app: FastifyInstance | undefined
let stopHost: (() => void) | undefined
afterEach(async () => { stopHost?.(); stopHost = undefined; await app?.close(); app = undefined })

/** Pete's host adapter: answers call.start with ready (or not at all), turns with "Okay." */
function fakeHost(d: ReturnType<typeof setup>, opts: { answerStart?: boolean } = {}) {
  const seen: JobRow[] = []
  let stopped = false
  void (async () => {
    while (!stopped) {
      markPoll(d.db, 'jasmine')
      const job = claimNext(d.db)
      if (!job) { await new Promise(r => setTimeout(r, 5)); continue }
      seen.push(job)
      if (job.type === 'call.start') { if (opts.answerStart !== false) submitResult(d.db, job.id, { ready: true }); continue }
      if (job.type === 'turn') submitResult(d.db, job.id, { say: 'Okay.' })
    }
  })()
  stopHost = () => { stopped = true }
  return seen
}

async function start(env: Record<string, string> = {}, host: false | { answerStart?: boolean } = {}) {
  const d = setup({ ...LIVE_ENV, ELEVENLABS_PETE_AGENT_ID: 'agent_pete', CUSTOM_LLM_SECRET: SECRET, AMD_ENABLED: 'false',
    BRAIN: 'jasmine', CODE_PHRASE: PHRASE, INBOUND_ENABLED: 'true', INBOUND_WARM_WAIT_S: '1', SETTLE_MS: '0',
    FILLER_AFTER_MS: '10000', FILLER2_AFTER_MS: '0', ...env })
  app = await buildApp({ config: d.config, db: d.db, clients: d })
  const seen = host === false ? [] : fakeHost(d, host)
  if (host === false) markPoll(d.db, 'jasmine') // online, but nobody answers
  return { d, seen }
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' }
let sidN = 0
async function ring(From: string, extra: Record<string, string> = {}) {
  const body = { CallSid: `CAin${++sidN}`, From, To: OURS, Direction: 'inbound', ...extra }
  const sig = twilioSignature('authtoken', 'https://jasmine.ashworthhub.com/phone/twilio/voice', body)
  const r = await app!.inject({ method: 'POST', url: '/phone/twilio/voice', headers: { ...FORM, 'x-twilio-signature': sig },
    payload: new URLSearchParams(body).toString() })
  return { ...r, sid: body.CallSid }
}
const calls = (d: ReturnType<typeof setup>) => all<CallRow>(d.db, 'SELECT * FROM calls')
const audits = (d: ReturnType<typeof setup>, action: string) =>
  all<{ target: string; data: string }>(d.db, 'SELECT target, meta AS data FROM audit_log WHERE action = ?', action)
function spoken(body: string): string {
  return body.split('\n\n').filter(l => l.startsWith('data: {'))
    .map(l => JSON.parse(l.slice(6)).choices[0].delta.content ?? '').join('')
}
/** Nothing that hints at a phrase, Pete, Jasmine or a person behind the line. */
const NEUTRAL = /phrase|code|password|pete|jasmine|secret|verify/i

describe('inbound: unknown callers', () => {
  it('hear the neutral no-incoming line, nothing else; no row, no ElevenLabs, no brain', async () => {
    const { d, seen } = await start()
    const r = await ring(STRANGER)
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toMatch(/text\/xml/)
    expect(r.body).toContain(`<Say>${NO_INCOMING_LINE.replace("'", '&#39;')}</Say><Hangup/>`)
    expect(NO_INCOMING_LINE).not.toMatch(NEUTRAL)
    expect(r.body.replace(/<\?xml[^>]*>/, '')).not.toMatch(NEUTRAL)
    expect(calls(d)).toEqual([])
    expect(d.registered).toEqual([])
    expect(seen).toEqual([])
    expect(audits(d, 'inbound.rejected')).toHaveLength(1)
  })

  it('same line for a contact with inbound_allowed who is not one of Pete\'s numbers, and for a hidden number', async () => {
    const { d } = await start()
    run(d.db, "INSERT INTO contacts (e164, name, inbound_allowed) VALUES (?, 'Britt', 1)", STRANGER)
    const a = await ring(STRANGER), b = await ring('anonymous')
    expect(a.body).toBe(b.body)
    expect(a.body).toContain('<Say>')
    expect(calls(d)).toEqual([])
  })

  it('INBOUND_OTHERS=reject: rejected unanswered', async () => {
    await start({ INBOUND_OTHERS: 'reject' })
    expect((await ring(STRANGER)).body).toContain('<Reject reason="rejected"/>')
  })

  it('unsigned requests are refused', async () => {
    await start()
    const r = await app!.inject({ method: 'POST', url: '/phone/twilio/voice', headers: FORM, payload: `From=${encodeURIComponent(PETE)}` })
    expect(r.statusCode).toBe(403)
  })
})

describe('inbound: Pete', () => {
  it('inbound off (or no Pete agent): Pete hears the same no-incoming line', async () => {
    for (const env of [{ INBOUND_ENABLED: 'false' }, { ELEVENLABS_PETE_AGENT_ID: '' }] as Record<string, string>[]) {
      const { d } = await start(env)
      const r = await ring(PETE)
      expect(r.body).toContain('<Say>This line doesn&#39;t take incoming calls. Goodbye.</Say>')
      expect(calls(d)).toEqual([])
      expect(JSON.parse(audits(d, 'inbound.turned_away')[0].data).code).toBe('inbound_disabled')
      stopHost?.(); await app?.close()
    }
  })

  it('Pete\'s number without inbound_allowed is treated like anyone else', async () => {
    const { d } = await start()
    run(d.db, 'UPDATE contacts SET inbound_allowed = 0 WHERE e164 = ?', PETE)
    expect((await ring(PETE)).body).toContain('incoming calls')
    expect(audits(d, 'inbound.rejected')).toHaveLength(1)
  })

  it('phone session offline or another call live: "can\'t pick up right now"', async () => {
    const off = await start({}, false)
    run(off.d.db, "UPDATE brain_host SET last_poll_at = '2020-01-01T00:00:00Z'")
    expect((await ring(PETE)).body).toContain('pick up right now')
    expect(calls(off.d)).toEqual([])
    await app!.close()

    const { d } = await start()
    const first = await ring(PETE)
    expect(first.body).toContain('<Connect>')
    const second = await ring(PETE)
    expect(second.body).toContain(`<Say>${PETE_UNAVAILABLE_LINE.replace("'", '&#39;')}</Say>`)
    expect(calls(d)).toHaveLength(1)
    expect(JSON.parse(audits(d, 'inbound.turned_away')[0].data).code).toBe('call_in_progress')
  })

  it('answered: private inbound row, Pete agent, call.start to the host, ElevenLabs TwiML', async () => {
    const { d, seen } = await start()
    const r = await ring(PETE, { StirVerstat: 'TN-Validation-Passed-A' })
    expect(r.body).toContain('<Connect><Stream')
    const [c] = calls(d)
    expect(c).toMatchObject({ direction: 'inbound', to_e164: PETE, from_e164: OURS, private: 1, brain: 'jasmine',
      el_agent_id: 'agent_pete', twilio_sid: r.sid, status: 'in-progress', el_conversation_id: 'conv_test1', dry_run: 0, agent_id: 'inbound' })
    expect(d.registered[0]).toMatchObject({ direction: 'inbound', from: PETE, to: OURS, agentId: 'agent_pete',
      dynamicVariables: { call_id: c.id } })
    expect(d.dials).toEqual([]) // nothing dialed out
    const startJob = seen.find(j => j.type === 'call.start')!
    expect(JSON.parse(startJob.payload)).toMatchObject({ direction: 'inbound', private: true })
    const ev = all<{ type: string; data: string }>(d.db, 'SELECT type, data FROM call_events WHERE call_id = ?', c.id)
    expect(ev.map(e => e.type)).toEqual(expect.arrayContaining(['inbound', 'brain_ready']))
    expect(JSON.parse(ev.find(e => e.type === 'inbound')!.data).stir_verstat).toBe('TN-Validation-Passed-A')
  })

  it('then it behaves like his outbound calls: Pete opener, phrase unlocks the personal tier', async () => {
    const { d, seen } = await start()
    await ring(PETE)
    const [c] = calls(d)
    const ask = (...msgs: object[]) => app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: { authorization: `Bearer ${SECRET}` },
      payload: { model: 'x', stream: true, messages: [{ role: 'system', content: `call_id: ${c.id}` }, ...msgs] } })
    expect(spoken((await ask({ role: 'user', content: 'Hello?' })).body)).toBe(PETE_OPENER)
    await ask({ role: 'user', content: 'Hello?' }, { role: 'assistant', content: PETE_OPENER }, { role: 'user', content: 'purple otter river lamp' })
    const turn = seen.filter(j => j.type === 'turn').map(j => JSON.parse(j.payload))
    expect(turn.at(-1)).toMatchObject({ code_phrase: 'verified', tier: 'personal' })
  })

  it('session not ready in time: still answers (after INBOUND_WARM_WAIT_S), logged', async () => {
    const { d } = await start({}, { answerStart: false })
    const t = Date.now()
    const r = await ring(PETE)
    expect(Date.now() - t).toBeGreaterThanOrEqual(900)
    expect(r.body).toContain('<Connect>')
    const [c] = calls(d)
    expect(all(d.db, "SELECT 1 FROM call_events WHERE call_id = ? AND type = 'brain_not_ready_yet'", c.id)).toHaveLength(1)
  })

  it('ElevenLabs error: row failed, Pete hears "can\'t pick up", line freed', async () => {
    const { d } = await start()
    d.elevenlabs.registerCall = async () => { throw new Error('EL 500') }
    const r = await ring(PETE)
    expect(r.body).toContain('pick up right now')
    expect(calls(d)[0]).toMatchObject({ status: 'failed', end_reason: 'inbound_error' })
    await expect(placeCall(d, 'jasmine', { to: PETE, purpose: 'p', brief: 'b' })).resolves.toMatchObject({ status: 'dry_run' })
  })

  it('call end: number status callback matched by CallSid, or the watchdog asks Twilio', async () => {
    const { d } = await start()
    const a = await ring(PETE)
    const body = { CallSid: a.sid, CallStatus: 'completed', CallDuration: '42' }
    const sig = twilioSignature('authtoken', 'https://jasmine.ashworthhub.com/phone/twilio/status', body)
    const s = await app!.inject({ method: 'POST', url: '/phone/twilio/status', headers: { ...FORM, 'x-twilio-signature': sig },
      payload: new URLSearchParams(body).toString() })
    expect(s.statusCode).toBe(204)
    expect(calls(d)[0]).toMatchObject({ status: 'completed', duration_s: 42 })

    const b = await ring(PETE)
    const id = getCall(d.db, all<{ id: string }>(d.db, 'SELECT id FROM calls WHERE twilio_sid = ?', b.sid)[0].id)!.id
    expect(await watchdog(d)).toEqual([])
    d.twilioState[b.sid] = { status: 'completed', duration: 7 }
    expect(await watchdog(d)).toEqual([id])
    expect(getCall(d.db, id)).toMatchObject({ status: 'completed', duration_s: 7 })
  })
})
