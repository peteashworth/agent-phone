import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.ts'
import { placeCall, getCall } from '../src/calls.ts'
import { getContact } from '../src/contacts.ts'
import { all } from '../src/db.ts'
import { CLOSE_LINES, closeLine, detectHardStop } from '../src/voice/hardStops.ts'
import { BLOCKED_LINE } from '../src/voice/outputFilter.ts'
import { CANNED_LINES } from '../src/voice/brain.ts'
import { EXIT_LINE } from '../src/voice/lines.ts'
import { setup, LIVE_ENV } from './helpers.ts'

const SECRET = 'x'.repeat(32)
const AUTH = { authorization: `Bearer ${SECRET}` }
let app: FastifyInstance | undefined
afterEach(async () => { await app?.close(); app = undefined })

async function start(env: Record<string, string> = {}) {
  const d = setup({ ...LIVE_ENV, CUSTOM_LLM_SECRET: SECRET, PRIVATE_TERMS: 'Bluebird', AMD_ENABLED: 'false', ...env })
  app = await buildApp({ config: d.config, db: d.db, clients: d })
  const call = await placeCall(d, 'jasmine', { to: '+14358403707', purpose: 'test', brief: 'say hi', dry_run: false })
  return { d, call }
}

/** Joins the streamed deltas back into the spoken text. */
function spoken(body: string): string {
  expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
  return body.split('\n\n').filter(l => l.startsWith('data: {'))
    .map(l => JSON.parse(l.slice(6)).choices[0].delta.content ?? '').join('')
}
const turn = (system: string, ...user: string[]) => ({
  model: 'x', stream: true,
  messages: [{ role: 'system', content: system }, ...user.flatMap((u, i) => [{ role: 'assistant', content: i ? 'Hi' : "Hi, this is Jasmine, Pete's AI assistant. This call is being recorded." }, { role: 'user', content: u }])],
})

describe('custom LLM route', () => {
  it('needs the secret', async () => {
    await start()
    expect((await app!.inject({ method: 'POST', url: '/phone/llm/v1', payload: turn('s', 'hi') })).statusCode).toBe(401)
    expect((await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: { authorization: 'Bearer nope' }, payload: turn('s', 'hi') })).statusCode).toBe(401)
  })
  it('is off without CUSTOM_LLM_SECRET', async () => {
    const d = setup()
    app = await buildApp({ config: d.config, db: d.db, clients: d })
    expect((await app.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn('s', 'hi') })).statusCode).toBe(503)
  })
  it('streams the canned brain in OpenAI SSE format', async () => {
    const { call } = await start()
    const r = await app!.inject({ method: 'POST', url: '/phone/llm/v1/chat/completions', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'hello') })
    expect(r.headers['content-type']).toMatch(/event-stream/)
    expect(spoken(r.body)).toBe(CANNED_LINES[0])
  })
  it('hard stop: speaks the close line once, hangs up via Twilio, later turns stay silent', async () => {
    const { d, call } = await start()
    const r = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'hello', "I don't want to talk to a robot") })
    expect(spoken(r.body)).toBe(CLOSE_LINES.ai_objection)
    await new Promise(r => setTimeout(r, 10))
    expect(d.ended).toEqual(['CAtest1'])
    expect(getCall(d.db, call.id)).toMatchObject({ end_reason: 'hard_stop:ai_objection' })
    const again = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'wait, what?') })
    expect(spoken(again.body)).toBe('')
    const kinds = all<{ kind: string; said: string | null }>(d.db, 'SELECT kind, said FROM call_turns WHERE call_id = ? ORDER BY id', call.id)
    expect(kinds).toEqual([{ kind: 'hard_stop', said: CLOSE_LINES.ai_objection }, { kind: 'closing', said: null }])
  })
  it('a garbled "don\'t record" stops only as the reply to the disclosure', async () => {
    const { call } = await start()
    const disclosed = (u: string) => ({ model: 'x', stream: true, messages: [{ role: 'system', content: `call_id: ${call.id}` },
      { role: 'assistant', content: "Hi, this is Jasmine, Pete's AI assistant. This call is being recorded." }, { role: 'user', content: u }] })
    const later = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'hello', "Please don't recall.") })
    expect(spoken(later.body)).not.toBe(CLOSE_LINES.recording_objection)
    const r = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: disclosed("Please don't recall.") })
    expect(spoken(r.body)).toBe(CLOSE_LINES.recording_objection)
  })
  it('opt-out also puts the number on do-not-call (found via the single live call, no marker)', async () => {
    const { d, call } = await start({ PERSONAL_OK_NUMBERS: '+14350000000' })
    const r = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn('no marker here', 'please stop calling me') })
    expect(spoken(r.body)).toBe(CLOSE_LINES.opt_out)
    expect(getContact(d.db, '+14358403707')!.do_not_call).toBe(1)
    expect(getCall(d.db, call.id)!.end_reason).toBe('hard_stop:opt_out')
  })
  it('personal tier: no ai_objection, no "off the record", opt-out ends the call without DNC', async () => {
    const { d, call } = await start()
    d.db.prepare("UPDATE calls SET tier = 'personal' WHERE id = ?").run(call.id)
    for (const u of ["I don't want to talk to a robot", 'this is off the record'])
      expect(spoken((await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, u) })).body)).toBe(CANNED_LINES[0])
    expect(getCall(d.db, call.id)!.end_reason).toBeNull()
    const r = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'stop calling me') })
    expect(spoken(r.body)).toBe(closeLine('opt_out', true))
    expect(getContact(d.db, '+14358403707')?.do_not_call ?? 0).toBe(0)
    expect(getCall(d.db, call.id)!.end_reason).toBe('hard_stop:opt_out')
    const again = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'wait') })
    expect(spoken(again.body)).toBe('') // said once
  })
  it("Pete's number, public tier: opt-out ends the call without DNC (only the CLI could clear it)", async () => {
    const { d, call } = await start()
    const r = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'stop calling me') })
    expect(spoken(r.body)).toBe(closeLine('opt_out', true))
    expect(getContact(d.db, '+14358403707')?.do_not_call ?? 0).toBe(0)
    expect(getCall(d.db, call.id)!.end_reason).toBe('hard_stop:opt_out')
  })
  it('personal tier: a real recording objection still stops', () => {
    expect(detectHardStop("don't record this", { personal: true })).toBe('recording_objection')
    expect(detectHardStop('off the record', { personal: true })).toBeNull()
    expect(detectHardStop('off the record')).toBe('recording_objection')
    expect(detectHardStop('no robots', { personal: true })).toBeNull()
  })
  it('output filter swaps a leaked email ("filter test") and private terms', async () => {
    const { d, call } = await start({ })
    const r = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'filter test') })
    expect(spoken(r.body)).toBe(`Sure. ${BLOCKED_LINE} `)
    expect(d.db.prepare("SELECT type FROM call_events WHERE call_id = ? AND type = 'output_blocked'").all(call.id)).toHaveLength(1)
    const brain = { async *reply() { yield 'The code word is blue'; yield 'bird. Bye!' } }
    await app!.close()
    app = await buildApp({ config: d.config, db: d.db, clients: { ...d, brain } })
    const r2 = await app.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'x') })
    expect(spoken(r2.body)).toBe(`${BLOCKED_LINE} Bye!`)
  })
  it('a brain that fails before saying anything: exit line once, then hang up (no dead air)', async () => {
    const { d, call } = await start()
    const brain = { async *reply(): AsyncGenerator<string> { throw new Error('boom') } }
    await app!.close()
    app = await buildApp({ config: d.config, db: d.db, clients: { ...d, brain } })
    const r = await app.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'hello') })
    expect(spoken(r.body)).toBe(EXIT_LINE)
    expect(getCall(d.db, call.id)!.end_reason).toBe('brain_error')
    const again = await app.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'hello?') })
    expect(spoken(again.body)).toBe('') // said once
  })
  it('a brain that fails mid-reply keeps what it said and the call goes on', async () => {
    const { d, call } = await start()
    const brain = { async *reply(): AsyncGenerator<string> { yield 'Sure thing. '; throw new Error('boom') } }
    await app!.close()
    app = await buildApp({ config: d.config, db: d.db, clients: { ...d, brain } })
    const r = await app.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: turn(`call_id: ${call.id}`, 'hello') })
    expect(spoken(r.body)).toBe('Sure thing. ')
    expect(getCall(d.db, call.id)!.end_reason).toBeNull()
  })
  it('non-streaming requests get a plain completion', async () => {
    const { call } = await start()
    const r = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: AUTH, payload: { ...turn(`call_id: ${call.id}`, 'hello'), stream: false } })
    expect(r.json().choices[0].message.content).toBe(CANNED_LINES[0])
  })
})

describe('callMarker', () => {
  it('finds the call id the agent prompt carries', async () => {
    const { callMarker } = await import('../src/routes/llm.ts')
    expect(callMarker([{ role: 'system', content: 'Call reference (internal): call_id: call_SIMULATION01\n\nYou are…' }])).toBe('call_SIMULATION01')
    expect(callMarker([{ role: 'system', content: 'call_id: {{call_id}}' }])).toBeNull()
  })
})
