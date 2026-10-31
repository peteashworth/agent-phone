import { describe, it, expect, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { buildApp } from '../src/app.ts'
import { createKey } from '../src/auth.ts'
import { placeCall, confirmCall } from '../src/calls.ts'
import { adminSetContact, updateContact, matchContacts, cleanLabel } from '../src/contacts.ts'
import { all } from '../src/db.ts'
import { setup, LIVE_ENV } from './helpers.ts'

const PETE = '+14358403707', STEPH = '+14352419384', STEVE = '+14355550111', NOBODY = '+14355550122'
const req = { purpose: 'chair delivery', brief: 'say hi' }

/** Pete (seeded, trusted) + Stephanie (allowed, labelled sister, not trusted) + Stephanie Jones (not allowed). */
function people(env: Record<string, string> = LIVE_ENV) {
  const d = setup(env)
  adminSetContact(d.db, 'test', STEPH, { name: 'Stephanie Ashworth', label: 'sister, Steph', allowed: true })
  adminSetContact(d.db, 'test', STEVE, { name: 'Steve' })
  return d
}
const calls = (d: ReturnType<typeof setup>) => all(d.db, 'SELECT to_e164, status FROM calls')

describe('contact name lookup', () => {
  it('cleans labels and refuses digits', () => {
    expect(cleanLabel(' Sister,  my  sis ,, Sister')).toBe('Sister, my sis')
    expect(() => cleanLabel('435-555-0100')).toThrow(/digits/)
  })

  it('matches full name, one word of it, or a label; case, punctuation and a leading "my" ignored', () => {
    const d = people()
    for (const q of ['Stephanie', 'stephanie ashworth', 'ASHWORTH', 'sister', 'my sister', 'Sister!', 'steph'])
      expect(matchContacts(d.db, q).map(c => c.e164), q).toEqual([STEPH])
    expect(matchContacts(d.db, 'steph a')).toEqual([]) // no prefixes / fuzzy matching
    expect(matchContacts(d.db, 'sis')).toEqual([])
  })

  it('place_call with a label resolves to the number and still needs confirmation (not trusted)', async () => {
    const d = people()
    const c = await placeCall(d, 'jasmine', { ...req, to: 'sister', dry_run: false })
    expect(c).toMatchObject({ to_e164: STEPH, status: 'awaiting_confirmation' })
    expect(c.confirm_token).toMatch(/^cfm_/)
    expect(d.dials).toHaveLength(0)
    const place = all<{ meta: string }>(d.db, "SELECT meta FROM audit_log WHERE action = 'call.place'")[0]
    expect(JSON.parse(place.meta)).toMatchObject({ to: STEPH, to_input: 'sister', needs_confirmation: true })
    const done = await confirmCall(d, 'jasmine', c.confirm_token!)
    expect(done.status).toBe('queued')
    expect(d.dials[0].to).toBe(STEPH)
  })

  it('a trusted contact by name dials right away, same as by number', async () => {
    const d = people()
    const c = await placeCall(d, 'jasmine', { ...req, to: 'Pete', dry_run: false })
    expect(c).toMatchObject({ to_e164: PETE, status: 'queued' })
  })

  it('resolving does not widen who can be called: a contact that is not allowed is still refused', async () => {
    const d = people()
    await expect(placeCall(d, 'jasmine', { ...req, to: 'Steve' })).rejects.toMatchObject({ code: 'destination_not_allowed' })
    expect(calls(d)).toEqual([])
  })

  it('a do-not-call contact by name is still refused', async () => {
    const d = people()
    updateContact(d.db, 'test', STEPH, { do_not_call: true })
    await expect(placeCall(d, 'jasmine', { ...req, to: 'sister' })).rejects.toMatchObject({ code: 'do_not_call' })
    expect(calls(d)).toEqual([])
  })

  it('more than one match is refused and lists them', async () => {
    const d = people()
    adminSetContact(d.db, 'test', NOBODY, { name: 'Stephanie Jones' })
    const err = await placeCall(d, 'jasmine', { ...req, to: 'Stephanie' }).then(() => ({ code: '', message: '' }), (e: { code: string; message: string }) => e)
    expect(err.code).toBe('ambiguous_contact')
    expect(err.message).toContain('Stephanie Ashworth (sister, Steph) +14352419384')
    expect(err.message).toContain('Stephanie Jones +14355550122')
    // The full name still works.
    await expect(placeCall(d, 'jasmine', { ...req, to: 'Stephanie Ashworth' })).resolves.toMatchObject({ to_e164: STEPH })
    expect(all(d.db, "SELECT action FROM audit_log WHERE action = 'call.refused'")).toHaveLength(1)
  })

  it('an opted-out row does not make a name ambiguous', async () => {
    const d = people()
    adminSetContact(d.db, 'test', NOBODY, { name: 'Steph', do_not_call: true })
    await expect(placeCall(d, 'jasmine', { ...req, to: 'steph' })).resolves.toMatchObject({ to_e164: STEPH })
  })

  it('no match is refused with a clear error; digits-only junk is still invalid_number', async () => {
    const d = people()
    await expect(placeCall(d, 'jasmine', { ...req, to: 'cousin' })).rejects.toMatchObject({ code: 'unknown_contact', message: expect.stringMatching(/No contact matches "cousin"/) })
    await expect(placeCall(d, 'jasmine', { ...req, to: '555' })).rejects.toMatchObject({ code: 'invalid_number' })
    expect(calls(d)).toEqual([])
  })

  it('admin route and CLI path set the label, audited', async () => {
    const d = people()
    const rows = all<{ meta: string }>(d.db, "SELECT meta FROM audit_log WHERE action = 'admin.contact.set'").map(r => JSON.parse(r.meta))
    expect(rows).toContainEqual({ field: 'label', old: '', new: 'sister, Steph' })
  })
})

describe('list_contacts (MCP)', () => {
  let app: FastifyInstance | undefined
  afterEach(async () => { await app?.close(); app = undefined })

  it('agent keys only; read-only view with label and flags; query uses the same matching', async () => {
    const d = people({})
    app = await buildApp({ config: d.config, db: d.db, clients: d })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const url = `http://127.0.0.1:${port}/phone/mcp`
    for (const scope of ['read', 'brain', 'admin'] as const) {
      const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${createKey(d.db, 'jasmine', scope).key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
      expect(r.status, scope).toBe(401)
    }
    const client = new Client({ name: 't', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${createKey(d.db, 'jasmine', 'agent').key}` } } }))
    const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text)
    const list = text(await client.callTool({ name: 'list_contacts', arguments: {} }))
    expect(list).toContainEqual({ name: 'Stephanie Ashworth', label: 'sister, Steph', number: STEPH, allowed: true, trusted: false, do_not_call: false })
    expect(list).toContainEqual({ name: 'Pete', label: null, number: PETE, allowed: true, trusted: true, do_not_call: false })
    expect(list.map((c: { number: string }) => c.number).sort()).toEqual([PETE, STEPH, STEVE].sort())
    expect(text(await client.callTool({ name: 'list_contacts', arguments: { query: 'my sister' } })).map((c: { name: string }) => c.name)).toEqual(['Stephanie Ashworth'])
    const refused = await client.callTool({ name: 'place_call', arguments: { to: 'cousin', ...req } })
    expect(refused.isError).toBe(true)
    expect((refused as { content: { text: string }[] }).content[0].text).toMatch(/^Refused \(unknown_contact\)/)
    await client.close()
  })
})
