import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.ts'
import { createKey, twilioSignature } from '../src/auth.ts'
import { placeCall, getCall } from '../src/calls.ts'
import { setup, LIVE_ENV } from './helpers.ts'

let app: FastifyInstance | undefined
afterEach(async () => { await app?.close(); app = undefined })

async function start(env: Record<string, string> = {}) {
  const d = setup(env)
  app = await buildApp({ config: d.config, db: d.db, clients: d })
  return d
}
const form = (p: Record<string, string>) => new URLSearchParams(p).toString()
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

describe('http', () => {
  it('health', async () => {
    await start()
    const r = await app!.inject({ url: '/phone/health' })
    expect(r.json()).toMatchObject({ ok: true, dialing: false })
  })

  it('status webhook requires a valid Twilio signature', async () => {
    const d = await start(LIVE_ENV)
    const c = await placeCall(d, 'jasmine', { to: '+14358403707', purpose: 'p', brief: 'b', dry_run: false })
    const url = `/phone/twilio/status?call=${c.id}`
    const body = { CallSid: 'CAtest1', CallStatus: 'completed', CallDuration: '9' }
    const bad = await app!.inject({ method: 'POST', url, headers: { ...FORM, 'x-twilio-signature': 'nope' }, payload: form(body) })
    expect(bad.statusCode).toBe(403)
    const sig = twilioSignature('authtoken', `https://jasmine.ashworthhub.com/phone/twilio/status?call=${c.id}`, body)
    const ok = await app!.inject({ method: 'POST', url, headers: { ...FORM, 'x-twilio-signature': sig }, payload: form(body) })
    expect(ok.statusCode).toBe(204)
    expect(getCall(d.db, c.id)).toMatchObject({ status: 'completed', duration_s: 9 })
  })

  it('webhooks are rejected when no Twilio auth is configured', async () => {
    await start()
    const r = await app!.inject({ method: 'POST', url: '/phone/twilio/voice', headers: FORM, payload: form({ From: '+14358403707' }) })
    expect(r.statusCode).toBe(403)
  })

  it('inbound: Pete hears a notice, others are rejected (token mode)', async () => {
    const token = 'x'.repeat(32)
    await start({ WEBHOOK_TOKEN: token })
    const call = (From: string) => app!.inject({ method: 'POST', url: `/phone/twilio/voice?t=${token}`, headers: FORM, payload: form({ From, To: '+14352644845' }) })
    expect((await call('+14358403707')).body).toContain('<Say>')
    expect((await call('+14352419384')).body).toContain('<Reject')
  })
})

describe('mcp', () => {
  it('rejects missing/invalid bearer', async () => {
    await start()
    const r = await app!.inject({ method: 'POST', url: '/phone/mcp', payload: {} })
    expect(r.statusCode).toBe(401)
  })

  it('end to end with the SDK client', async () => {
    const d = await start()
    const { key } = createKey(d.db, 'jasmine', 'agent')
    await app!.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app!.server.address() as { port: number }
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/phone/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }))
    const tools = (await client.listTools()).tools.map(t => t.name).sort()
    expect(tools).toEqual(['add_contact', 'get_call', 'list_calls', 'list_numbers', 'place_call', 'update_contact'])

    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text
    const placed = JSON.parse(text(await client.callTool({ name: 'place_call', arguments: { to: '435-840-3707', purpose: 'test', brief: 'say hello', dry_run: false } })))
    expect(placed).toMatchObject({ status: 'dry_run', dry_run: true, from: '+14352644845', contact: 'Pete' })

    const got = JSON.parse(text(await client.callTool({ name: 'get_call', arguments: { id: placed.id } })))
    expect(got.events[0].type).toBe('dry_run')

    const refused = await client.callTool({ name: 'place_call', arguments: { to: '+14352419384', purpose: 'test', brief: 'say hello' } })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/destination_not_allowed/)

    const nums = JSON.parse(text(await client.callTool({ name: 'list_numbers', arguments: {} })))
    expect(nums.map((n: { label: string }) => n.label)).toEqual(['line', 'mobile'])

    await client.callTool({ name: 'add_contact', arguments: { phone: '+14352419384', name: 'Test' } })
    const upd = await client.callTool({ name: 'update_contact', arguments: { phone: '+14352419384', trusted: true } })
    expect(upd.isError).toBe(true) // agents can't grant trust
    expect(d.db.prepare("SELECT trusted FROM contacts WHERE e164 = '+14352419384'").get()).toEqual({ trusted: 0 })
    await client.close()
  })
})
