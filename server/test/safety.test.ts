import { describe, it, expect } from 'vitest'
import { placeCall, confirmCall, getCall, hangup, watchdog, applyTwilioStatus } from '../src/calls.ts'
import { spend, checkHours } from '../src/safety.ts'
import { run } from '../src/db.ts'
import { getContact, updateContact, addContact } from '../src/contacts.ts'
import { detectHardStop } from '../src/voice/hardStops.ts'
import { OutputFilter, checkText, BLOCKED_LINE } from '../src/voice/outputFilter.ts'
import { setup, LIVE_ENV } from './helpers.ts'

const PETE = '+14358403707', OTHER = '+14352419384'
const req = { to: PETE, purpose: 'test', brief: 'say hi' }
const OPEN = { ...LIVE_ENV, ALLOWED_DESTINATIONS: '*' }

describe('calling hours', () => {
  it('unknown zone must fit both US coasts', () => {
    const c = setup().config
    expect(checkHours(c, null, new Date('2026-10-08T18:00:00Z'))).toBeNull()                       // 2pm ET / 11am PT
    expect(checkHours(c, null, new Date('2026-10-08T14:00:00Z'))?.code).toBe('outside_calling_hours') // 7am PT
    expect(checkHours(c, null, new Date('2026-10-09T00:30:00Z'))?.code).toBe('outside_calling_hours') // 8:30pm ET
  })
  it('uses the contact tz when set', () => {
    const c = setup().config
    expect(checkHours(c, 'America/Denver', new Date('2026-10-08T15:30:00Z'))).toBeNull()            // 9:30am MT
    expect(checkHours(c, 'America/Denver', new Date('2026-10-09T02:30:00Z'))?.code).toBe('outside_calling_hours')
  })
  it('seeded Pete is America/Denver: 8:30pm ET (6:30pm MT) is allowed', async () => {
    const d = setup()
    expect(getContact(d.db, PETE)?.tz).toBe('America/Denver')
    d.now.t = new Date('2026-10-09T00:30:00Z')
    await expect(placeCall(d, 'jasmine', { ...req, dry_run: true })).resolves.toBeTruthy()
  })
  it('update_contact sets, normalises, rejects and clears tz', () => {
    const d = setup()
    addContact(d.db, 'test', '+14352419384', 'Test')
    expect(updateContact(d.db, 'test', '+14352419384', { tz: 'america/los_angeles' }).tz).toBe('America/Los_Angeles')
    expect(() => updateContact(d.db, 'test', '+14352419384', { tz: 'Mountain' })).toThrow(/IANA/)
    expect(getContact(d.db, '+14352419384')?.tz).toBe('America/Los_Angeles')
    expect(updateContact(d.db, 'test', '+14352419384', { tz: null }).tz).toBeNull()
  })
  it('refuses at placement, even trusted and dry', async () => {
    const d = setup()
    d.now.t = new Date('2026-10-09T05:00:00Z')
    await expect(placeCall(d, 'jasmine', req)).rejects.toMatchObject({ code: 'outside_calling_hours' })
  })
})

describe('spend caps', () => {
  const addCall = (d: ReturnType<typeof setup>, created: string, status: string, duration: number | null, cost: number | null = null) =>
    run(d.db, `INSERT INTO calls (id, agent_id, to_e164, from_e164, from_label, purpose, brief, dry_run, status, max_seconds, created_at, duration_s, cost_usd)
               VALUES (?, 'jasmine', ?, '+14352644845', 'line', 'p', 'b', 0, ?, 300, ?, ?, ?)`,
      'call_' + Math.random().toString(36).slice(2, 14), PETE, status, created, duration, cost)

  it('counts ended calls by billed minute, live calls at worst case, by Denver day/month', () => {
    const d = setup()
    addCall(d, '2026-10-08T16:00:00Z', 'completed', 61)        // 2 min x 0.08
    addCall(d, '2026-10-08T17:00:00Z', 'in-progress', null)     // reserve 5 min x 0.08
    addCall(d, '2026-10-08T05:00:00Z', 'completed', 0, 1.5)     // Oct 7 in Denver: month only
    addCall(d, '2026-09-30T18:00:00Z', 'completed', 600)        // last month
    expect(spend(d.config, d.db, d.now.t)).toEqual({ day: 0.56, month: 2.06 })
  })
  it('refuses a live dial that would pass the daily cap', async () => {
    const d = setup({ ...LIVE_ENV, SPEND_CAP_DAY_USD: '1' })
    addCall(d, '2026-10-08T16:00:00Z', 'completed', 0, 0.8)
    await expect(placeCall(d, 'jasmine', { ...req, dry_run: false })).rejects.toMatchObject({ code: 'spend_cap_day' })
    expect((await placeCall(d, 'jasmine', req)).status).toBe('dry_run') // dry runs cost nothing
  })
  it('monthly cap', async () => {
    const d = setup({ ...LIVE_ENV, SPEND_CAP_MONTH_USD: '2' })
    addCall(d, '2026-10-02T16:00:00Z', 'completed', 0, 1.8)
    await expect(placeCall(d, 'jasmine', { ...req, dry_run: false })).rejects.toMatchObject({ code: 'spend_cap_month' })
  })
})

describe('confirm before dial', () => {
  it('non-trusted contacts wait for confirm_call; nothing dials before', async () => {
    const d = setup(OPEN)
    const c = await placeCall(d, 'jasmine', { ...req, to: OTHER, dry_run: false })
    expect(c.status).toBe('awaiting_confirmation')
    expect(c.confirm_token).toMatch(/^cfm_/)
    expect(c.confirm_hash).not.toBe(c.confirm_token)
    expect(d.dials).toHaveLength(0)
    const done = await confirmCall(d, 'jasmine', c.confirm_token!)
    expect(done.status).toBe('queued')
    expect(done.confirmed_by).toBe('jasmine')
    expect(d.dials).toHaveLength(1)
    await expect(confirmCall(d, 'jasmine', c.confirm_token!)).rejects.toMatchObject({ code: 'invalid_token' }) // single use
  })
  it('tokens expire', async () => {
    const d = setup(OPEN)
    const c = await placeCall(d, 'jasmine', { ...req, to: OTHER, dry_run: false })
    d.now.t = new Date(d.now.t.getTime() + 16 * 60_000)
    await expect(confirmCall(d, 'jasmine', c.confirm_token!)).rejects.toMatchObject({ code: 'token_expired' })
    expect(getCall(d.db, c.id)!.status).toBe('expired')
    expect(d.dials).toHaveLength(0)
  })
  it('re-checks at confirmation (opted out in between)', async () => {
    const d = setup(OPEN)
    const c = await placeCall(d, 'jasmine', { ...req, to: OTHER, dry_run: false })
    run(d.db, 'INSERT INTO contacts (e164, name, do_not_call) VALUES (?, ?, 1)', OTHER, 'X')
    await expect(confirmCall(d, 'jasmine', c.confirm_token!)).rejects.toMatchObject({ code: 'do_not_call' })
    expect(getCall(d.db, c.id)!.status).toBe('refused')
    expect(d.dials).toHaveLength(0)
  })
  it('the allow-list still applies (Pete only by default)', async () => {
    await expect(placeCall(setup(LIVE_ENV), 'jasmine', { ...req, to: OTHER })).rejects.toMatchObject({ code: 'destination_not_allowed' })
  })
})

describe('hard stop classifier', () => {
  const cases: [string, string | null][] = [
    ["I don't want to talk to a robot", 'ai_objection'],
    ['i dont want to speak with an AI', 'ai_objection'],
    ['Can I talk to a real person?', 'ai_objection'],
    ['I want a real human', 'ai_objection'],
    ['no robots, thanks', 'ai_objection'],
    ["Please don't record this", 'recording_objection'],
    ['stop recording', 'recording_objection'],
    ["I'm not okay with being recorded", 'recording_objection'],
    ['I do not consent to this', 'recording_objection'],
    ["I don't want to be recorded", 'recording_objection'],
    ['Please stop the recording', 'recording_objection'],
    ['no recording please', 'recording_objection'],
    ["don't tape this", 'recording_objection'],
    ["I didn't agree to being recorded", 'recording_objection'],
    ["I didn't agree to that price", null],
    ['I object to being recorded', 'recording_objection'],
    ['can we keep this off the record', 'recording_objection'],
    ['delete the recording', 'recording_objection'],
    ["Please don't recall.", null], // only right after the disclosure (below)
    ["I don't recall", null],
    ["I don't recall saying that", null],
    ['I recall him mentioning it', null],
    ['Did you record the order number?', null],
    ["Don't call me again", 'opt_out'],
    ['stop calling this number', 'opt_out'],
    ['take me off your list', 'opt_out'],
    ['Put me on the do not call list', 'opt_out'],
    ['Sure, that works for me', null],
    ["I don't mind being recorded", null],
    ['No problem, talking to an AI is fine', null],
    ['Can you call me again tomorrow?', null],
    ['Tuesday at 3 works', null],
  ]
  for (const [text, want] of cases) it(`${JSON.stringify(text)} -> ${want}`, () => expect(detectHardStop(text)).toBe(want))

  // Reply to "…This call is being recorded.": short speech-to-text misses of "don't record" also stop.
  const after: [string, string | null][] = [
    ["Please don't recall.", 'recording_objection'],
    ["Don't recall me.", 'recording_objection'],
    ["Oh, don't report.", 'recording_objection'],
    ['No, please do not record.', 'recording_objection'],
    ["I don't recall.", null],
    ["Sorry, I don't recall that number.", null],
    ["Don't recall the name, who is this?", null],
    ['Hello?', null],
    ['Okay.', null],
  ]
  for (const [text, want] of after)
    it(`after disclosure: ${JSON.stringify(text)} -> ${want}`, () => expect(detectHardStop(text, { afterDisclosure: true })).toBe(want))
})

describe('output filter', () => {
  it('blocks private data, passes ordinary speech', () => {
    expect(checkText('Reach him at pete@example.com', [])).toBe('email')
    expect(checkText('it is pete at gmail dot com', [])).toBe('email')
    expect(checkText('card 4111 1111 1111 1111', [])).toBe('card_number')
    expect(checkText('order 4111 1111 1111 1112', [])).toBeNull() // fails Luhn
    expect(checkText('SSN 123-45-6789', [])).toBe('ssn')
    expect(checkText('He lives at 1234 North Maple Street', [])).toBe('street_address')
    expect(checkText('His secret word is Bluebird', ['bluebird'])).toBe('private_term')
    expect(checkText('Can we do Tuesday at 3? It takes about 45 minutes.', [])).toBeNull()
    expect(checkText('He can be reached at 435-840-3707.', [])).toBeNull() // phone numbers are allowed
  })
  it('streams sentence by sentence and swaps blocked ones', () => {
    const f = new OutputFilter([])
    let out = ''
    for (const t of ['Sure. The add', 'ress is a@b.', 'com and the zip. ', 'Anything else?']) out += f.push(t)
    out += f.flush()
    expect(out).toBe(`Sure. ${BLOCKED_LINE} Anything else?`)
    expect(f.blocked).toEqual(['email'])
  })
})

describe('hangup + watchdog', () => {
  it('hangup keeps the hard-stop reason through the completed callback', async () => {
    const d = setup(LIVE_ENV)
    const c = await placeCall(d, 'jasmine', { ...req, dry_run: false })
    await hangup(d, c.id, 'hard_stop:opt_out')
    expect(d.ended).toEqual(['CAtest1'])
    applyTwilioStatus(d.db, c.id, { CallSid: 'CAtest1', CallStatus: 'completed', CallDuration: '20' })
    expect(getCall(d.db, c.id)).toMatchObject({ status: 'completed', end_reason: 'hard_stop:opt_out' })
  })
  it('ends overdue calls, syncs ones Twilio already ended, retries stuck hangups', async () => {
    const d = setup(LIVE_ENV)
    const c = await placeCall(d, 'jasmine', { ...req, dry_run: false })
    expect(await watchdog(d)).toEqual([])
    d.now.t = new Date(Date.parse(c.created_at) + (300 + 181) * 1000)
    expect(await watchdog(d)).toEqual([c.id])
    expect(d.ended).toEqual(['CAtest1'])
    expect(getCall(d.db, c.id)!.end_reason).toBe('watchdog')

    d.twilioState.CAtest1 = { status: 'completed', duration: 290 }
    await watchdog(d)
    expect(d.ended).toHaveLength(1)
    expect(getCall(d.db, c.id)).toMatchObject({ status: 'completed', duration_s: 290 })
  })
  it('retries a hangup that did not land', async () => {
    const d = setup(LIVE_ENV)
    const c = await placeCall(d, 'jasmine', { ...req, dry_run: false })
    d.twilio.endCall = async () => { throw new Error('twilio HTTP 500') }
    await hangup(d, c.id, 'hard_stop:ai_objection')
    d.twilio.endCall = async sid => { d.ended.push(sid) }
    d.now.t = new Date(Date.now() + 31_000)
    expect(await watchdog(d)).toEqual([c.id])
    expect(d.ended).toEqual(['CAtest1'])
    expect(getCall(d.db, c.id)!.end_reason).toBe('hard_stop:ai_objection')
  })
  it('opt-out of a non-contact creates a do-not-call entry', async () => {
    const { setDoNotCall } = await import('../src/contacts.ts')
    const d = setup()
    setDoNotCall(d.db, 'system', OTHER, 'test')
    expect(getContact(d.db, OTHER)).toMatchObject({ do_not_call: 1, trusted: 0 })
  })
})
