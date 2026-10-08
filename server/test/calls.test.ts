import { describe, it, expect } from 'vitest'
import { placeCall, applyTwilioStatus, getCall, CallRefused } from '../src/calls.ts'
import { updateContact } from '../src/contacts.ts'
import { setup, LIVE_ENV } from './helpers.ts'

const req = { to: '+14358403707', purpose: 'test', brief: 'say hi' }

describe('placeCall', () => {
  it('is a dry run by default, even with dialing enabled', async () => {
    const d = setup(LIVE_ENV)
    const c = await placeCall(d, 'jasmine', req)
    expect(c.status).toBe('dry_run')
    expect(c.from_e164).toBe('+14352644845')
    expect(d.dials).toHaveLength(0)
  })
  it('stays dry when the server switch is off, even with dry_run:false', async () => {
    const d = setup()
    const c = await placeCall(d, 'jasmine', { ...req, dry_run: false })
    expect(c.dry_run).toBe(1)
    expect(d.dials).toHaveLength(0)
  })
  it('dials only with switch on AND dry_run:false', async () => {
    const d = setup(LIVE_ENV)
    const c = await placeCall(d, 'jasmine', { ...req, dry_run: false })
    expect(c.status).toBe('queued')
    expect(c.twilio_sid).toBe('CAtest1')
    expect(c.el_conversation_id).toBe('conv_test1')
    expect(d.dials[0]).toMatchObject({ to: '+14358403707', from: '+14352644845', timeLimit: 300 })
    expect(d.dials[0].statusCallback).toBe(`https://jasmine.ashworthhub.com/phone/twilio/status?call=${c.id}`)
  })
  it('refuses destinations outside the allow-list (Pete only)', async () => {
    const d = setup(LIVE_ENV)
    await expect(placeCall(d, 'jasmine', { ...req, to: '+14352419384' })).rejects.toMatchObject({ code: 'destination_not_allowed' })
    expect(d.db.prepare('SELECT count(*) n FROM calls').get()).toEqual({ n: 0 })
  })
  it('refuses do-not-call numbers', async () => {
    const d = setup(LIVE_ENV)
    updateContact(d.db, 'test', '+14358403707', { do_not_call: true })
    await expect(placeCall(d, 'jasmine', req)).rejects.toBeInstanceOf(CallRefused)
  })
  it('refuses invalid numbers', async () => {
    await expect(placeCall(setup(), 'jasmine', { ...req, to: '555' })).rejects.toMatchObject({ code: 'invalid_number' })
  })
  it('allows one live call at a time', async () => {
    const d = setup(LIVE_ENV)
    await placeCall(d, 'jasmine', { ...req, dry_run: false })
    await expect(placeCall(d, 'jasmine', { ...req, dry_run: false })).rejects.toMatchObject({ code: 'call_in_progress' })
  })
  it('records provider failures on the call', async () => {
    const d = setup(LIVE_ENV)
    d.twilio.createCall = async () => { throw new Error('twilio HTTP 400: 21216') }
    const c = await placeCall(d, 'jasmine', { ...req, dry_run: false })
    expect(c.status).toBe('failed')
    expect(c.error).toMatch(/21216/)
  })
})

describe('Twilio status', () => {
  it('tracks the call to completion and ignores late events', async () => {
    const d = setup(LIVE_ENV)
    const c = await placeCall(d, 'jasmine', { ...req, dry_run: false })
    applyTwilioStatus(d.db, c.id, { CallSid: 'CAtest1', CallStatus: 'in-progress' })
    expect(getCall(d.db, c.id)!.started_at).toBeTruthy()
    applyTwilioStatus(d.db, c.id, { CallSid: 'CAtest1', CallStatus: 'completed', CallDuration: '42' })
    applyTwilioStatus(d.db, c.id, { CallSid: 'CAtest1', CallStatus: 'ringing' })
    expect(getCall(d.db, c.id)).toMatchObject({ status: 'completed', duration_s: 42, end_reason: 'hangup' })
  })
  it('rejects a mismatched CallSid', async () => {
    const d = setup(LIVE_ENV)
    const c = await placeCall(d, 'jasmine', { ...req, dry_run: false })
    expect(applyTwilioStatus(d.db, c.id, { CallSid: 'CAother', CallStatus: 'completed' })).toBe(false)
  })
})
