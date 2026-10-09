import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.ts'
import { createKey, twilioSignature } from '../src/auth.ts'
import { placeCall, getCall, applyTwilioStatus } from '../src/calls.ts'
import { postCallSweep, purgeRecordings } from '../src/postcall.ts'
import { run, all } from '../src/db.ts'
import { DISCLOSURE, openerFor, withRecordingNotice } from '../src/voice/lines.ts'
import { detectHardStop } from '../src/voice/hardStops.ts'
import { classifyGreeting } from '../src/voice/greeting.ts'
import { CANNED_LINES } from '../src/voice/brain.ts'
import { setup, LIVE_ENV } from './helpers.ts'

const SECRET = 'x'.repeat(32)
let app: FastifyInstance | undefined
afterEach(async () => { await app?.close(); app = undefined })

async function start(env: Record<string, string> = {}) {
  const d = setup({ ...LIVE_ENV, CUSTOM_LLM_SECRET: SECRET, DATA_DIR: mkdtempSync(join(tmpdir(), 'phone-')), ...env })
  app = await buildApp({ config: d.config, db: d.db, clients: d })
  const call = await placeCall(d, 'jasmine', { to: '+14358403707', purpose: 'test', brief: 'say hi', dry_run: false })
  return { d, call }
}
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }
async function amd(id: string, answeredBy: string) {
  const body = { CallSid: 'CAtest1', AnsweredBy: answeredBy, MachineDetectionDuration: '2100' }
  const sig = twilioSignature('authtoken', `https://jasmine.ashworthhub.com/phone/twilio/amd?call=${id}`, body)
  return app!.inject({ method: 'POST', url: `/phone/twilio/amd?call=${id}`, headers: { ...FORM, 'x-twilio-signature': sig },
    payload: new URLSearchParams(body).toString() })
}
const answer = (d: ReturnType<typeof setup>, id: string) => applyTwilioStatus(d.db, id, { CallSid: 'CAtest1', CallStatus: 'in-progress' })
const llm = (id: string, said = 'hello') => app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: { authorization: `Bearer ${SECRET}` },
  payload: { model: 'x', stream: false, messages: [{ role: 'system', content: `call_id: ${id}` }, { role: 'assistant', content: "Hi, this is Jasmine, Pete's AI assistant. This call is being recorded." }, { role: 'user', content: said }] } })
const said = (r: { json(): { choices: { message: { content: string } }[] } }) => r.json().choices[0].message.content

describe('answering-machine detection', () => {
  it('asks Twilio for async AMD on every live call', async () => {
    const { d, call } = await start()
    expect(d.dials[0].amd).toEqual({ callback: `https://jasmine.ashworthhub.com/phone/twilio/amd?call=${call.id}`, timeoutS: 6 })
    expect(getCall(d.db, call.id)!.amd).toBe(1)
  })
  it('AMD_ENABLED=false leaves it off', async () => {
    const { d, call } = await start({ AMD_ENABLED: 'false' })
    expect(d.dials[0].amd).toBeUndefined()
    expect(getCall(d.db, call.id)!.amd).toBe(0)
  })
  it('webhook needs a valid signature', async () => {
    const { call } = await start()
    const r = await app!.inject({ method: 'POST', url: `/phone/twilio/amd?call=${call.id}`, headers: { ...FORM, 'x-twilio-signature': 'x' }, payload: 'AnsweredBy=human' })
    expect(r.statusCode).toBe(403)
  })
  it('human: the brain talks as normal', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    expect((await amd(call.id, 'human')).statusCode).toBe(204)
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'human', end_reason: null })
    expect(said(await llm(call.id))).toBe(CANNED_LINES[0])
    expect(d.ended).toEqual([])
  })
  it('machine: hangs up right away, logged as voicemail, the brain says nothing', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    await amd(call.id, 'machine_start')
    expect(d.ended).toEqual(['CAtest1'])
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'machine_start', end_reason: 'voicemail' })
    expect(said(await llm(call.id, "Hi, you've reached Pete, leave a message"))).toBe('')
  })
  it('fax counts as a machine', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    await amd(call.id, 'fax')
    expect(getCall(d.db, call.id)!.end_reason).toBe('voicemail')
    expect(d.ended).toEqual(['CAtest1'])
  })
  it('unknown carries on as a person (call_MDwakWeN1u8z: Pete listened silently to the disclosure)', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    await amd(call.id, 'unknown')
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'unknown', end_reason: null, hangup_requested_at: null })
    expect(said(await llm(call.id))).toBe(CANNED_LINES[0])
    expect(d.ended).toEqual([])
  })
  it('VOICEMAIL_ACTION=message: the one fixed line, then hang up', async () => {
    const { d, call } = await start({ VOICEMAIL_ACTION: 'message' })
    answer(d, call.id)
    await amd(call.id, 'machine_start')
    expect(d.ended).toEqual([]) // not yet
    expect(said(await llm(call.id, 'leave a message after the tone'))).toBe('Sorry I missed you. Goodbye.')
    await new Promise(r => setTimeout(r, 10))
    expect(d.ended).toEqual(['CAtest1'])
  })
  it('the first reply waits for the verdict', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    const pending = llm(call.id)
    setTimeout(() => void amd(call.id, 'human'), 300)
    expect(said(await pending)).toBe(CANNED_LINES[0])
  })
  it('no verdict in time carries on as a person', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    run(d.db, 'UPDATE calls SET started_at = ? WHERE id = ?', new Date(Date.now() - 10_000).toISOString(), call.id)
    expect(said(await llm(call.id))).toBe(CANNED_LINES[0])
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'timeout', end_reason: null })
    expect(d.ended).toEqual([])
  })
  it('hard stops still win before the AMD wait', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    expect(said(await llm(call.id, 'stop calling me'))).toMatch(/won't call again/)
    expect(getCall(d.db, call.id)!.end_reason).toBe('hard_stop:opt_out')
  })
  it('a late Twilio verdict after our timeout is history only', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    run(d.db, "UPDATE calls SET answered_by = 'timeout' WHERE id = ?", call.id)
    await amd(call.id, 'human')
    expect(getCall(d.db, call.id)!.answered_by).toBe('timeout')
  })
  it('a late machine verdict after unknown or our timeout never ends the call', async () => {
    for (const first of ['unknown', 'timeout']) {
      const { d, call } = await start()
      answer(d, call.id)
      run(d.db, 'UPDATE calls SET answered_by = ? WHERE id = ?', first, call.id)
      await amd(call.id, 'machine_end_beep')
      expect(getCall(d.db, call.id)).toMatchObject({ answered_by: first, end_reason: null, hangup_requested_at: null })
      expect(d.ended).toEqual([])
      await app!.close()
    }
  })
  it('a machine verdict after the brain has spoken never ends the call', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    run(d.db, 'UPDATE calls SET amd = 0 WHERE id = ?', call.id) // let the brain talk before any verdict
    expect(said(await llm(call.id))).toBe(CANNED_LINES[0])
    run(d.db, 'UPDATE calls SET amd = 1 WHERE id = ?', call.id)
    await amd(call.id, 'machine_start')
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'machine_start', end_reason: null, hangup_requested_at: null })
    expect(d.ended).toEqual([])
  })
})

describe('post-call sweep', () => {
  const conv = {
    status: 'done', has_audio: true,
    transcript: [
      { role: 'agent', message: "Hi, this is Jasmine, Pete's AI assistant. This call is being recorded.", time_in_call_secs: 0 },
      { role: 'user', message: 'Hey.', time_in_call_secs: 4 }, { role: 'agent', message: null, time_in_call_secs: 5 },
    ],
    analysis: { transcript_summary: 'Jasmine said hello.', call_summary_title: 'Test call' },
    metadata: { cost: 185 },
  }
  async function ended(env: Record<string, string> = {}) {
    const s = await start(env)
    answer(s.d, s.call.id)
    applyTwilioStatus(s.d.db, s.call.id, { CallSid: 'CAtest1', CallStatus: 'completed', CallDuration: '58' })
    return s
  }

  it('stores transcript, summary, credits, audio and real cost', async () => {
    const { d, call } = await ended()
    d.conversations.conv_test1 = conv
    d.audio.conv_test1 = new Uint8Array([1, 2, 3])
    d.twilioState.CAtest1 = { status: 'completed', duration: 58, price: 0.014 }
    expect(await postCallSweep(d)).toEqual([call.id])
    const c = getCall(d.db, call.id)!
    expect(JSON.parse(c.transcript!)).toEqual([
      { role: 'agent', text: "Hi, this is Jasmine, Pete's AI assistant. This call is being recorded.", t: 0 },
      { role: 'user', text: 'Hey.', t: 4 },
    ])
    expect(c).toMatchObject({ summary: 'Jasmine said hello.', summary_title: 'Test call', el_cost_credits: 185, twilio_price_usd: 0.014,
      recording_path: `recordings/${call.id}.mp3`, recording_bytes: 3 })
    expect(c.finalized_at).toBeTruthy()
    expect(c.cost_usd).toBeCloseTo(185 * 0.0002 + 0.014 + 0.0075, 4)
    expect([...readFileSync(join(d.config.DATA_DIR, c.recording_path!))]).toEqual([1, 2, 3])
    expect(await postCallSweep(d)).toEqual([]) // nothing left to do
  })
  it('waits while ElevenLabs is still processing, then gives up after 20 tries', async () => {
    const { d, call } = await ended()
    for (let i = 0; i < 19; i++) await postCallSweep(d)
    expect(getCall(d.db, call.id)!.finalized_at).toBeNull()
    d.conversations.conv_test1 = { ...conv, status: 'processing' }
    await postCallSweep(d)
    expect(getCall(d.db, call.id)).toMatchObject({ finalize_attempts: 20, summary: 'Jasmine said hello.' })
    expect(getCall(d.db, call.id)!.finalized_at).toBeTruthy()
  })
  it('unanswered calls finalize at once without asking ElevenLabs', async () => {
    const { d, call } = await start()
    applyTwilioStatus(d.db, call.id, { CallSid: 'CAtest1', CallStatus: 'no-answer' })
    await postCallSweep(d)
    expect(getCall(d.db, call.id)!.finalized_at).toBeTruthy()
  })
  it('SAVE_RECORDINGS=false keeps no audio; a failed download keeps the rest', async () => {
    const off = await ended({ SAVE_RECORDINGS: 'false' })
    off.d.conversations.conv_test1 = conv
    off.d.audio.conv_test1 = new Uint8Array([1])
    await postCallSweep(off.d)
    expect(getCall(off.d.db, off.call.id)).toMatchObject({ recording_path: null, summary: 'Jasmine said hello.' })
    await app!.close()
    const broken = await ended()
    broken.d.conversations.conv_test1 = conv // no audio stub → getAudio throws
    await postCallSweep(broken.d)
    expect(getCall(broken.d.db, broken.call.id)).toMatchObject({ recording_path: null, summary: 'Jasmine said hello.' })
  })
  it('Twilio price arrives on a later sweep', async () => {
    const { d, call } = await ended()
    d.conversations.conv_test1 = { ...conv, has_audio: false }
    d.twilioState.CAtest1 = { status: 'completed', duration: 58, price: null }
    await postCallSweep(d)
    expect(getCall(d.db, call.id)!.cost_usd).toBeCloseTo(0.037 + 0.0075, 4)
    d.twilioState.CAtest1 = { status: 'completed', duration: 58, price: 0.014 }
    expect(await postCallSweep(d)).toEqual([call.id])
    expect(getCall(d.db, call.id)!.cost_usd).toBeCloseTo(0.037 + 0.0075 + 0.014, 4)
  })
  it('recordings are deleted after the retention period; transcript stays', async () => {
    const { d, call } = await ended()
    d.conversations.conv_test1 = conv
    d.audio.conv_test1 = new Uint8Array([9])
    await postCallSweep(d)
    const file = join(d.config.DATA_DIR, getCall(d.db, call.id)!.recording_path!)
    expect(purgeRecordings(d)).toEqual([])
    run(d.db, 'UPDATE calls SET ended_at = ? WHERE id = ?', new Date(Date.now() - 91 * 86_400_000).toISOString(), call.id)
    expect(purgeRecordings(d)).toEqual([call.id])
    expect(existsSync(file)).toBe(false)
    expect(getCall(d.db, call.id)).toMatchObject({ recording_path: null, summary: 'Jasmine said hello.' })
    expect(getCall(d.db, call.id)!.recording_deleted_at).toBeTruthy()
  })
})

describe('read API', () => {
  it('needs a read (or agent) key; serves list, detail and audio', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    applyTwilioStatus(d.db, call.id, { CallSid: 'CAtest1', CallStatus: 'completed', CallDuration: '58' })
    d.conversations.conv_test1 = { status: 'done', has_audio: true, transcript: [{ role: 'user', message: 'Hey.', time_in_call_secs: 4 }],
      analysis: { transcript_summary: 'S', call_summary_title: 'T' }, metadata: { cost: 100 } }
    d.audio.conv_test1 = new Uint8Array([7, 7])
    await postCallSweep(d)

    expect((await app!.inject({ url: '/phone/api/calls' })).statusCode).toBe(401)
    const { key } = createKey(d.db, 'jasmine', 'read')
    const auth = { authorization: `Bearer ${key}` }
    const list = (await app!.inject({ url: '/phone/api/calls?limit=5', headers: auth })).json()
    expect(list.calls).toHaveLength(1)
    expect(list.calls[0]).toMatchObject({ id: call.id, summary_title: 'T', has_recording: true, duration_s: 58 })
    expect(list.calls[0].brief).toBeUndefined()

    const one = (await app!.inject({ url: `/phone/api/calls/${call.id}`, headers: auth })).json()
    expect(one.transcript).toEqual([{ role: 'user', text: 'Hey.', t: 4 }])
    expect(one.cost).toMatchObject({ elevenlabs_credits: 100, amd: true })
    expect(one.events.length).toBeGreaterThan(0)
    expect((await app!.inject({ url: '/phone/api/calls/call_nope', headers: auth })).statusCode).toBe(404)

    const audio = await app!.inject({ url: `/phone/api/calls/${call.id}/recording`, headers: auth })
    expect(audio.headers['content-type']).toBe('audio/mpeg')
    expect([...audio.rawPayload]).toEqual([7, 7])
    expect(audio.headers['accept-ranges']).toBe('bytes')
    expect(audio.headers['content-length']).toBe('2')
    const part = await app!.inject({ url: `/phone/api/calls/${call.id}/recording`, headers: { ...auth, range: 'bytes=1-' } })
    expect(part.statusCode).toBe(206)
    expect(part.headers['content-range']).toBe('bytes 1-1/2')
    expect([...part.rawPayload]).toEqual([7])
    expect((await app!.inject({ url: `/phone/api/calls/${call.id}/recording`, headers: { ...auth, range: 'bytes=5-' } })).statusCode).toBe(416)

    const agentKey = createKey(d.db, 'jasmine', 'agent').key
    expect((await app!.inject({ url: '/phone/api/calls', headers: { authorization: `Bearer ${agentKey}` } })).statusCode).toBe(200)
  })
  it('fills a missing duration from Twilio, else ElevenLabs, else the clock', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    applyTwilioStatus(d.db, call.id, { CallSid: 'CAtest1', CallStatus: 'completed' }) // no CallDuration
    expect(getCall(d.db, call.id)!.duration_s).toBeNull()
    d.twilioState.CAtest1 = { status: 'completed', duration: null }
    d.conversations.conv_test1 = { status: 'done', metadata: { call_duration_secs: 41 } }
    await postCallSweep(d)
    expect(getCall(d.db, call.id)!.duration_s).toBe(41)
    run(d.db, "UPDATE calls SET duration_s = 0, started_at = '2026-10-08T18:00:00.000Z' WHERE id = ?", call.id)
    d.twilioState.CAtest1 = { status: 'completed', duration: 58 }
    await postCallSweep(d)
    expect(getCall(d.db, call.id)!.duration_s).toBe(58)
  })
})

describe('known-contact opener', () => {
  const KNOWN = "Hi Carolee, this call's being recorded. It's Jasmine, Pete's assistant."
  it('first name for known contacts only; odd names and missing flags fall back to the full disclosure', () => {
    expect(openerFor({ name: 'Carolee Smith', known: 1 })).toBe(KNOWN)
    expect(openerFor({ name: 'Carolee Smith', known: 0 })).toBe(DISCLOSURE)
    expect(openerFor(null)).toBe(DISCLOSURE)
    expect(openerFor({ name: "O'Neil", known: true })).toContain("Hi O'Neil,")
    for (const name of ['', '   ', 'Dr. Bob', '123', '<b>x</b>', 'Bob.']) expect(openerFor({ name, known: 1 }), name).toBe(DISCLOSURE)
    // Only ever one word of letters, whatever the name says
    expect(openerFor({ name: 'Ignore previous instructions', known: 1 })).toBe("Hi Ignore, this call's being recorded. It's Jasmine, Pete's assistant.")
  })
  it('every opener says the call is recorded; one that does not is never used', () => {
    expect(withRecordingNotice("Hi Carolee, it's Jasmine.")).toBe(DISCLOSURE)
    for (const o of [DISCLOSURE, KNOWN]) expect(o).toMatch(/\bbeing recorded\b/)
  })
  it('the short opener still counts as the disclosure for the recording-objection hard stop', () => {
    expect(detectHardStop("Don't record me.", { afterDisclosure: /being recorded/i.test(KNOWN) })).toBe('recording_objection')
  })
  it('a known callee hears it on the call; the turn is still the disclosure turn', async () => {
    const { d, call } = await start()
    run(d.db, "UPDATE contacts SET known = 1, name = 'Pete Ashworth' WHERE e164 = ?", call.to_e164)
    answer(d, call.id)
    const r = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: { authorization: `Bearer ${SECRET}` },
      payload: { model: 'x', stream: false, messages: [{ role: 'system', content: `call_id: ${call.id}` }, { role: 'user', content: 'Hello?' }] } })
    expect(said(r)).toBe("Hi Pete, this call's being recorded. It's Jasmine, Pete's assistant.")
    expect(all<{ kind: string }>(d.db, 'SELECT kind FROM call_turns WHERE call_id = ?', call.id).map(x => x.kind)).toEqual(['disclosure'])
  })
})

describe('wait-for-hello opening (blank first_message)', () => {
  const sys = (id: string) => ({ role: 'system', content: `call_id: ${id}` })
  const post = (messages: object[]) => app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: { authorization: `Bearer ${SECRET}` },
    payload: { model: 'x', stream: false, messages } })
  /** First turn: the callee's greeting, or nothing when ElevenLabs' initial_wait_time ran out in silence. */
  const opening = (id: string, greeting?: string) => post(greeting == null ? [sys(id)] : [sys(id), { role: 'user', content: greeting }])
  /** Second turn: the callee's reply to the disclosure. */
  const reply = (id: string, text: string, greeting = 'Hello?') =>
    post([sys(id), { role: 'user', content: greeting }, { role: 'assistant', content: DISCLOSURE }, { role: 'user', content: text }])

  it('a person says hello: disclosure first, verdict human_greeting, the brain then answers without waiting', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    expect(said(await opening(call.id, 'Hello?'))).toBe(DISCLOSURE)
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'human_greeting', end_reason: null })
    const t0 = Date.now()
    expect(said(await reply(call.id, 'Oh, okay. Hi.'))).toBe(CANNED_LINES[0])
    expect(Date.now() - t0).toBeLessThan(1000)
    await amd(call.id, 'machine_start') // Twilio disagreeing later changes nothing
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'human_greeting', end_reason: null })
    expect(d.ended).toEqual([])
    expect(all<{ kind: string }>(d.db, 'SELECT kind FROM call_turns WHERE call_id = ? ORDER BY id', call.id).map(r => r.kind))
      .toEqual(['disclosure', 'brain'])
  })
  it('a person stays silent: disclosure after the wait, Twilio unknown carries on, the brain answers', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    expect(said(await opening(call.id))).toBe(DISCLOSURE)
    expect(getCall(d.db, call.id)!.answered_by).toBeNull()
    await amd(call.id, 'unknown')
    expect(said(await reply(call.id, 'Uh, hi?', ''))).toBe(CANNED_LINES[0])
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'unknown', end_reason: null })
    expect(d.ended).toEqual([])
  })
  it('silence arrives as "..." (what ElevenLabs actually sends): disclosure, no verdict from it', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    expect(said(await opening(call.id, '...'))).toBe(DISCLOSURE)
    expect(getCall(d.db, call.id)!.answered_by).toBeNull()
  })
  it('a person stays silent and Twilio never answers: timeout carries on as human', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    expect(said(await opening(call.id))).toBe(DISCLOSURE)
    run(d.db, 'UPDATE calls SET started_at = ? WHERE id = ?', new Date(Date.now() - 10_000).toISOString(), call.id)
    expect(said(await reply(call.id, 'Yes?', ''))).toBe(CANNED_LINES[0])
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'timeout', end_reason: null })
  })
  it('a machine greeting: no disclosure, no brain, logged as voicemail and hung up', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    expect(said(await opening(call.id, "Hi, you've reached Pete. I can't come to the phone right now, leave a message after the beep."))).toBe('')
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'machine_greeting', end_reason: 'voicemail' })
    expect(d.ended).toEqual(['CAtest1'])
  })
  it('a long unbroken greeting with no voicemail words is still a machine', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    expect(said(await opening(call.id, 'Thank you for calling Ashworth Holdings, our office hours are nine to five Monday through Friday'))).toBe('')
    expect(getCall(d.db, call.id)!.answered_by).toBe('machine_greeting')
  })
  it('a machine greeting still yields to an earlier Twilio human verdict', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    await amd(call.id, 'human')
    expect(said(await opening(call.id, 'Hello this is Pete Ashworth speaking, who am I talking to today please'))).toBe(DISCLOSURE)
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'human', end_reason: null })
  })
  it('voicemail wording after the disclosure, before the brain spoke, overrides human_greeting', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    await opening(call.id, 'Hi,')
    expect(getCall(d.db, call.id)!.answered_by).toBe('human_greeting')
    expect(said(await reply(call.id, 'Please leave your message after the tone.', 'Hi,'))).toBe('')
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'machine_greeting', end_reason: 'voicemail' })
  })
  it('once the brain has spoken, voicemail-ish words never end the call', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    await opening(call.id, 'Hello?')
    await reply(call.id, 'Hi.')
    const r = await post([sys(call.id), { role: 'user', content: 'Hello?' }, { role: 'assistant', content: DISCLOSURE },
      { role: 'user', content: 'Hi.' }, { role: 'assistant', content: CANNED_LINES[0] }, { role: 'user', content: "Sorry, he's not available right now." }])
    expect(said(r)).toBe(CANNED_LINES[1])
    expect(getCall(d.db, call.id)).toMatchObject({ answered_by: 'human_greeting', end_reason: null })
  })
  it('hard stops still win on the opening turn', async () => {
    const { d, call } = await start()
    answer(d, call.id)
    expect(said(await opening(call.id, 'Stop calling me.'))).toMatch(/won't call again/)
    expect(getCall(d.db, call.id)!.end_reason).toBe('hard_stop:opt_out')
  })
  it('AMD off: the greeting is not judged', async () => {
    const { d, call } = await start({ AMD_ENABLED: 'false' })
    answer(d, call.id)
    expect(said(await opening(call.id, "You've reached Pete, leave a message."))).toBe(DISCLOSURE)
    expect(getCall(d.db, call.id)!.answered_by).toBeNull()
  })
})

describe('classifyGreeting', () => {
  it.each([
    ['Hello?', true, 'human'], ['Yeah, hi.', true, 'human'], ['Hi, this is Pete.', true, 'human'], ['', true, null], ['...', true, null], [' … ', true, null],
    ['Hey, who is this calling please?', true, null],
    ["The person you're trying to reach is not available.", true, 'machine'], ['Please leave a message.', true, 'machine'],
    ['Sure, I can talk for a few minutes, what is this about exactly then?', false, null],
    ['Sorry, your call cannot be answered. Press one to leave a callback number.', false, 'machine'],
  ] as const)('%s (opening %s) -> %s', (text, opening, want) => expect(classifyGreeting(text, opening)).toBe(want))
})
