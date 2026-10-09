import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { migrate } from '../src/db.ts'
import { fromFor, inboundAllowed } from '../src/numbers.ts'
import { createKey, authenticate, revokeKey, twilioSignature } from '../src/auth.ts'
import { toE164 } from '../src/phone.ts'
import { conversationIdFromTwiml } from '../src/voice/elevenlabs.ts'
import { setup } from './helpers.ts'

describe('config', () => {
  it('defaults are safe', () => {
    const c = loadConfig({})
    expect(c.DIALING_ENABLED).toBe(false)
    expect(c.MAX_CALL_SECONDS).toBe(300)
  })
  it('blank values count as unset', () => {
    expect(loadConfig({ WEBHOOK_TOKEN: '', PUBLIC_BASE_URL: ' ' }).WEBHOOK_TOKEN).toBeUndefined()
  })
  it('refuses DIALING_ENABLED without creds', () => {
    expect(() => loadConfig({ DIALING_ENABLED: 'true' })).toThrow(/missing/)
  })
})

describe('db', () => {
  it('migrations are idempotent', () => {
    const { db } = setup()
    expect(migrate(db)).toEqual([])
  })
})

describe('caller-ID rule', () => {
  const { db } = setup()
  it('calls to Pete show the Twilio line', () => expect(fromFor(db, '+14358403707').e164).toBe('+14352644845'))
  it('everyone else sees Pete\'s mobile', () => expect(fromFor(db, '+14352419384').e164).toBe('+14358403707'))
  it('never calls a number from itself', () => {
    db.prepare("UPDATE from_rules SET from_label = 'mobile'").run()
    expect(() => fromFor(db, '+14358403707')).toThrow(/destination itself/)
  })
})

describe('inbound allow-list', () => {
  const { db } = setup()
  it('allows Pete, rejects others', () => {
    expect(inboundAllowed(db, '+14358403707')).toBe(true)
    expect(inboundAllowed(db, '+14352419384')).toBe(false)
  })
})

describe('keys', () => {
  it('create, authenticate by scope, revoke', () => {
    const { db } = setup()
    const { key, prefix } = createKey(db, 'jasmine', 'agent')
    expect(authenticate(db, `Bearer ${key}`, 'agent')).toBe('jasmine')
    expect(authenticate(db, `Bearer ${key}`, 'read')).toBeNull()
    expect(authenticate(db, 'Bearer nope', 'agent')).toBeNull()
    expect(revokeKey(db, prefix)).toBe(true)
    expect(authenticate(db, `Bearer ${key}`, 'agent')).toBeNull()
  })
})

describe('misc', () => {
  it('normalizes US numbers', () => {
    expect(toE164('(435) 840-3707')).toBe('+14358403707')
    expect(toE164('123')).toBeNull()
  })
  it('Twilio signature matches the documented example', () => {
    // https://www.twilio.com/docs/usage/security#validating-requests
    expect(twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
      CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212',
    })).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=')
  })
  it('extracts conversation id from TwiML', () => {
    expect(conversationIdFromTwiml('<Parameter name="conversation_id" value="conv_abc" />')).toBe('conv_abc')
  })
})
