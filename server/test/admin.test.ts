import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp, type RouteInfo } from '../src/app.ts'
import { createKey, twilioSignature } from '../src/auth.ts'
import { placeCall, getCall, applyTwilioStatus } from '../src/calls.ts'
import { all, one } from '../src/db.ts'
import { SETTINGS, MAX_ALLOWED, bootstrapAllowlist, effective } from '../src/settings.ts'
import { setup, LIVE_ENV } from './helpers.ts'

const PETE = '+14358403707', OTHER = '+14352419384'
const SECRET = 'x'.repeat(32)
let app: (FastifyInstance & { routeList: RouteInfo[] }) | undefined
afterEach(async () => { await app?.close(); app = undefined })

async function start(env: Record<string, string> = {}) {
  const d = setup({ CUSTOM_LLM_SECRET: SECRET, ...env })
  app = await buildApp({ config: d.config, db: d.db, clients: d })
  const keys = {
    admin: createKey(d.db, 'pete', 'admin').key, agent: createKey(d.db, 'jasmine', 'agent').key,
    read: createKey(d.db, 'jasmine', 'read').key, brain: createKey(d.db, 'jasmine', 'brain').key,
  }
  return { d, keys }
}
const as = (key: string) => ({ authorization: `Bearer ${key}` })
const req = (method: 'GET' | 'POST' | 'PATCH', url: string, key: string, payload?: object) =>
  app!.inject({ method, url: `/phone${url}`, headers: as(key), ...(payload ? { payload } : {}) })
const contact = (d: ReturnType<typeof setup>, phone: string) =>
  one<Record<string, unknown>>(d.db, 'SELECT * FROM contacts WHERE e164 = ?', phone)
const auditRows = (d: ReturnType<typeof setup>, like: string) =>
  all<{ actor: string; action: string; target: string; meta: string }>(d.db, 'SELECT * FROM audit_log WHERE action LIKE ? ORDER BY id', like)
    .map(r => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }))

describe('admin routes', () => {
  it('only an admin key gets in', async () => {
    const { keys } = await start()
    const routes: ['GET' | 'POST' | 'PATCH', string][] = [['GET', '/admin/contacts'], ['POST', '/admin/contacts'],
      ['PATCH', `/admin/contacts/${OTHER}`], ['GET', '/admin/settings'], ['PATCH', '/admin/settings'], ['GET', '/admin/audit'], ['GET', '/admin/whoami']]
    for (const [m, url] of routes) {
      for (const k of [keys.agent, keys.read, keys.brain, 'aph_a_nope', '']) {
        const r = await req(m, url, k, m === 'GET' ? undefined : { phone: OTHER, name: 'X', allowed: true, MAX_CALL_SECONDS: 600 })
        expect(r.statusCode, `${m} ${url}`).toBe(401)
      }
    }
    const who = await req('GET', '/admin/whoami', keys.admin)
    expect(who.json().actor).toMatch(/^pete \(aph_a_/)
  })

  it('add, allow and trust a contact; every change is audited with old and new', async () => {
    const { d, keys } = await start()
    expect((await req('POST', '/admin/contacts', keys.admin, { phone: OTHER })).statusCode).toBe(400) // new number needs a name
    const added = await req('POST', '/admin/contacts', keys.admin, { phone: '(435) 241-9384', name: 'Britt', tz: 'America/Denver' })
    expect(added.json()).toMatchObject({ phone: OTHER, name: 'Britt', allowed: false, trusted: false })
    const r = await req('PATCH', `/admin/contacts/${OTHER}`, keys.admin, { allowed: true, trusted: true })
    expect(r.json()).toMatchObject({ allowed: true, trusted: true })
    const list = (await req('GET', '/admin/contacts', keys.admin)).json()
    expect(list).toMatchObject({ allowed_count: 2, max_allowed: MAX_ALLOWED })
    const rows = auditRows(d, 'admin.contact.%')
    expect(rows.map(x => x.action)).toEqual(['admin.contact.add', 'admin.contact.set', 'admin.contact.set', 'admin.contact.set'])
    expect(rows.find(x => x.meta.field === 'allowed')?.meta).toMatchObject({ old: 0, new: 1 })
    expect(rows.every(x => x.actor.startsWith('pete (aph_a_'))).toBe(true)
    // ...and it shows on the Changes list
    const changes = (await req('GET', '/admin/audit', keys.admin)).json().changes
    expect(changes[0]).toMatchObject({ action: 'admin.contact.set', target: OTHER })
  })
  it('known: off by default, admin can turn it on, audited', async () => {
    const { d, keys } = await start()
    expect((await req('POST', '/admin/contacts', keys.admin, { phone: OTHER, name: 'Carolee Smith' })).json()).toMatchObject({ known: false })
    expect((await req('PATCH', `/admin/contacts/${OTHER}`, keys.admin, { known: true })).json()).toMatchObject({ known: true })
    expect(contact(d, OTHER)).toMatchObject({ known: 1 })
    expect(auditRows(d, 'admin.contact.set').find(x => x.meta.field === 'known')?.meta).toMatchObject({ old: 0, new: 1 })
  })

  it('an allowed contact can now be called; unknown fields and wildcards are refused', async () => {
    const { d, keys } = await start(LIVE_ENV)
    await expect(placeCall(d, 'jasmine', { to: OTHER, purpose: 'test', brief: 'hi' })).rejects.toThrow(/not on the allowed list/)
    await req('POST', '/admin/contacts', keys.admin, { phone: OTHER, name: 'Britt', allowed: true })
    expect((await placeCall(d, 'jasmine', { to: OTHER, purpose: 'test', brief: 'hi' })).status).toBe('awaiting_confirmation') // allowed, not trusted
    expect((await req('POST', '/admin/contacts', keys.admin, { phone: '*', name: 'All', allowed: true })).statusCode).toBe(400)
    expect((await req('PATCH', `/admin/contacts/${OTHER}`, keys.admin, { bogus: 1 })).statusCode).toBe(400)
  })

  it('setting do-not-call works, clearing it is CLI-only', async () => {
    const { d, keys } = await start()
    await req('POST', '/admin/contacts', keys.admin, { phone: OTHER, name: 'Britt', allowed: true })
    expect((await req('PATCH', `/admin/contacts/${OTHER}`, keys.admin, { do_not_call: true })).json().do_not_call).toBe(true)
    const clear = await req('PATCH', `/admin/contacts/${OTHER}`, keys.admin, { do_not_call: false })
    expect(clear.statusCode).toBe(400)
    expect(contact(d, OTHER)!.do_not_call).toBe(1)
  })

  it(`no more than ${MAX_ALLOWED} allowed contacts`, async () => {
    const { d, keys } = await start()
    for (let i = 1; i < MAX_ALLOWED; i++) {
      const r = await req('POST', '/admin/contacts', keys.admin, { phone: `+1435555${String(i).padStart(4, '0')}`, name: `C${i}`, allowed: true })
      expect(r.statusCode).toBe(200)
    }
    const over = await req('POST', '/admin/contacts', keys.admin, { phone: '+14355559999', name: 'One too many', allowed: true })
    expect(over.statusCode).toBe(400)
    expect(over.json().error).toMatch(/25/)
    expect(contact(d, '+14355559999')).toBeUndefined() // all or nothing: not even created
  })

  it('settings: save, bounds, empty window, reset to env', async () => {
    const { d, keys } = await start()
    const get = async () => Object.fromEntries((await req('GET', '/admin/settings', keys.admin)).json().settings
      .map((s: { key: string }) => [s.key, s]))
    expect((await get()).MAX_CALL_SECONDS).toMatchObject({ value: 300, source: 'env', min: 30, max: 600 })

    const ok = await req('PATCH', '/admin/settings', keys.admin, { MAX_CALL_SECONDS: 120, VOICEMAIL_LINE: '  Sorry I missed you, bye.  ' })
    expect(ok.statusCode).toBe(200)
    expect((await get()).MAX_CALL_SECONDS).toMatchObject({ value: 120, source: 'dashboard', env_value: 300 })
    expect((await get()).VOICEMAIL_LINE.value).toBe('Sorry I missed you, bye.')

    for (const bad of [{ MAX_CALL_SECONDS: 601 }, { SPEND_CAP_DAY_USD: 21 }, { SPEND_CAP_MONTH_USD: -1 }, { CALL_HOURS_START: 6 },
      { CALL_HOURS_END: 23 }, { CONFIRM_TTL_MIN: 0 }, { VOICEMAIL_LINE: 'a\nb' }, { VOICEMAIL_LINE: '' }, { MAX_CALL_SECONDS: '120' },
      { DIALING_ENABLED: true }, { CODE_PHRASE: 'x' }, { CALL_HOURS_START: 12, CALL_HOURS_END: 12 }, { CALL_HOURS_START: 21 }]) {
      const r = await req('PATCH', '/admin/settings', keys.admin, bad)
      expect(r.statusCode, JSON.stringify(bad)).toBe(400)
    }
    // A failed save changes nothing, even its valid parts.
    expect((await req('PATCH', '/admin/settings', keys.admin, { CONFIRM_TTL_MIN: 30, MAX_CALL_SECONDS: 9999 })).statusCode).toBe(400)
    expect((await get()).CONFIRM_TTL_MIN.source).toBe('env')

    await req('PATCH', '/admin/settings', keys.admin, { MAX_CALL_SECONDS: null })
    expect((await get()).MAX_CALL_SECONDS).toMatchObject({ value: 300, source: 'env' })
    expect(auditRows(d, 'admin.setting.%').map(r => [r.action, r.target, r.meta.old, r.meta.new])).toEqual([
      ['admin.setting.set', 'MAX_CALL_SECONDS', 300, 120],
      ['admin.setting.set', 'VOICEMAIL_LINE', 'Sorry I missed you. Goodbye.', 'Sorry I missed you, bye.'],
      ['admin.setting.reset', 'MAX_CALL_SECONDS', 120, 300],
    ])
  })

  it('settings: the check-in pause is a boolean', async () => {
    const { keys } = await start()
    const get = async () => (await req('GET', '/admin/settings', keys.admin)).json().settings
      .find((s: { key: string }) => s.key === 'CHECKINS_PAUSED')
    expect(await get()).toMatchObject({ value: false, type: 'boolean', source: 'env' })
    expect((await req('PATCH', '/admin/settings', keys.admin, { CHECKINS_PAUSED: 'true' })).statusCode).toBe(400)
    expect((await req('PATCH', '/admin/settings', keys.admin, { CHECKINS_PAUSED: true })).statusCode).toBe(200)
    expect(await get()).toMatchObject({ value: true, source: 'dashboard' })
  })

  it('saved settings take effect on the next call, no restart', async () => {
    const { d, keys } = await start({ ...LIVE_ENV, VOICEMAIL_ACTION: 'message' })
    await req('PATCH', '/admin/settings', keys.admin, { MAX_CALL_SECONDS: 90, VOICEMAIL_LINE: 'Call you later. Bye.' })
    const call = await placeCall(d, 'jasmine', { to: PETE, purpose: 'test', brief: 'hi', dry_run: false })
    expect(getCall(d.db, call.id)!.max_seconds).toBe(90)
    expect(d.dials[0].timeLimit).toBe(90)

    applyTwilioStatus(d.db, call.id, { CallSid: 'CAtest1', CallStatus: 'in-progress' })
    const body = { CallSid: 'CAtest1', AnsweredBy: 'machine_start' }
    const sig = twilioSignature('authtoken', `https://jasmine.ashworthhub.com/phone/twilio/amd?call=${call.id}`, body)
    await app!.inject({ method: 'POST', url: `/phone/twilio/amd?call=${call.id}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, payload: new URLSearchParams(body).toString() })
    const r = await app!.inject({ method: 'POST', url: '/phone/llm/v1', headers: as(SECRET), payload: { model: 'x', stream: false,
      messages: [{ role: 'system', content: `call_id: ${call.id}` }, { role: 'assistant', content: "Hi, this is Jasmine, Pete's AI assistant. This call is being recorded." }, { role: 'user', content: 'leave a message' }] } })
    expect(r.json().choices[0].message.content).toBe('Call you later. Bye.')
  })

  it('a bad saved row or a mixed empty window falls back to the env', async () => {
    const { d } = await start({ CALL_HOURS_START: '9', CALL_HOURS_END: '20' })
    d.db.prepare("INSERT INTO settings (key, value, updated_by) VALUES ('MAX_CALL_SECONDS', '99999', 'x'), ('CALL_HOURS_START', '21', 'x')").run()
    const e = effective(d.config, d.db)
    expect(e.MAX_CALL_SECONDS).toBe(300)
    expect([e.CALL_HOURS_START, e.CALL_HOURS_END]).toEqual([9, 20]) // 21..20 would be empty
  })
})

describe('allowlist bootstrap', () => {
  it('unset env = Pete only, once', async () => {
    const d = setup()
    d.db.prepare('UPDATE contacts SET allowed = 0').run()
    expect(bootstrapAllowlist(d.config, d.db)).toEqual({ allowed: [PETE], skipped: [] })
    expect(contact(d, PETE)!.allowed).toBe(1)
    d.db.prepare('UPDATE contacts SET allowed = 0').run()
    expect(bootstrapAllowlist(d.config, d.db)).toBeNull() // never again, even if Pete was un-allowed since
    expect(contact(d, PETE)!.allowed).toBe(0)
  })
  it('the old env list is imported; "*" and junk are skipped, not widened', async () => {
    const d = setup({ ALLOWED_DESTINATIONS: `${PETE}, *, 435-241-9384, hello` })
    expect(bootstrapAllowlist(d.config, d.db)).toEqual({ allowed: [PETE, OTHER], skipped: ['*', 'hello'] })
    expect(contact(d, OTHER)).toMatchObject({ allowed: 1, trusted: 0, name: 'Imported from ALLOWED_DESTINATIONS' })
    expect(one<{ n: number }>(d.db, 'SELECT count(*) AS n FROM contacts WHERE allowed = 1')!.n).toBe(2)
    expect(auditRows(d, 'allowlist.bootstrap')[0].meta).toEqual({ allowed: [PETE, OTHER], skipped: ['*', 'hello'] })
  })
  it('a wildcard no longer opens anything', async () => {
    const d = setup({ ...LIVE_ENV, ALLOWED_DESTINATIONS: '*' })
    bootstrapAllowlist(d.config, d.db)
    await expect(placeCall(d, 'jasmine', { to: OTHER, purpose: 'test', brief: 'hi' })).rejects.toThrow(/destination_not_allowed|not on the allowed list/)
  })
})

// THE GUARD: nothing an agent (or a caller talking to one) can reach may widen permissions. Hits every non-admin route
// with every non-admin key and a body full of permission fields, calls every MCP tool with them too, then checks that
// the allowlist, trust and limits are exactly as seeded. Adding a route or tool that can write them fails this test.
describe('permission guard', () => {
  const PERMS = { allowed: true, trusted: true, known: true, inbound_allowed: true, do_not_call: false, ...Object.fromEntries(
    Object.keys(SETTINGS).map(k => [k, k === 'VOICEMAIL_LINE' ? 'pwned' : 600])) }

  it('no MCP tool, agent, read or brain key can write allowed, trusted, known or settings', async () => {
    const { d, keys } = await start(LIVE_ENV)
    d.db.prepare("INSERT INTO contacts (e164, name) VALUES (?, 'Other')").run(OTHER)
    const before = all(d.db, 'SELECT e164, allowed, trusted, known, inbound_allowed, do_not_call FROM contacts ORDER BY e164')
    const call = await placeCall(d, 'jasmine', { to: PETE, purpose: 'test', brief: 'hi' })

    // 1. Every HTTP route that isn't /admin, every method, every non-admin key.
    const routes = app!.routeList.filter(r => !r.url.startsWith('/phone/admin') && r.method !== 'HEAD' && r.method !== 'OPTIONS')
    expect(routes.length).toBeGreaterThan(10)
    for (const { method, url } of routes) {
      const path = url.replace(':id', call.id).replace(':phone', OTHER)
      for (const k of [keys.agent, keys.read, keys.brain, SECRET]) {
        await app!.inject({ method: method as 'POST', url: `${path}?${new URLSearchParams({ phone: OTHER, allowed: '1', trusted: '1', wait: '0' })}`,
          headers: as(k), payload: { phone: OTHER, to: OTHER, ...PERMS, settings: PERMS, contact: { phone: OTHER, ...PERMS } } })
      }
    }

    // 2. Every MCP tool, with the permission fields added to otherwise valid arguments.
    await app!.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app!.server.address() as { port: number }
    const client = new Client({ name: 'guard', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/phone/mcp`), {
      requestInit: { headers: as(keys.agent) } }))
    const tools = (await client.listTools()).tools
    const forbidden = ['allowed', 'trusted', 'known', 'inbound_allowed', ...Object.keys(SETTINGS)]
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {})
      expect(props.filter(p => forbidden.includes(p)), t.name).toEqual([])
    }
    const base: Record<string, object> = {
      place_call: { to: OTHER, purpose: 'test', brief: 'hi' }, confirm_call: { confirm_token: 'cfm_x' },
      get_call: { id: call.id }, list_calls: {}, list_numbers: {}, add_contact: { phone: '+14355550100', name: 'New' },
      update_contact: { phone: OTHER },
    }
    expect(tools.map(t => t.name).sort()).toEqual(Object.keys(base).sort()) // a new tool must be added here
    for (const t of tools) {
      await client.callTool({ name: t.name, arguments: { ...base[t.name], ...PERMS } })
      await client.callTool({ name: t.name, arguments: { ...base[t.name], phone: OTHER, allowed: true, trusted: true } })
    }
    await client.close()

    // Nothing moved.
    expect(all(d.db, 'SELECT * FROM settings')).toEqual([])
    expect(all(d.db, 'SELECT e164, allowed, trusted, known, inbound_allowed, do_not_call FROM contacts WHERE e164 != ? ORDER BY e164', '+14355550100'))
      .toEqual(before)
    expect(one(d.db, "SELECT allowed, trusted, known, inbound_allowed FROM contacts WHERE e164 = '+14355550100'") ?? { allowed: 0, trusted: 0, known: 0, inbound_allowed: 0 })
      .toEqual({ allowed: 0, trusted: 0, known: 0, inbound_allowed: 0 })
    expect(auditRows(d, 'admin.%')).toEqual([])
    expect(effective(d.config, d.db)).toEqual(d.config)
  })
})
