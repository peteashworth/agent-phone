import { loadConfig, type Config } from '../src/config.ts'
import { openDb, migrate, type DB } from '../src/db.ts'
import { seed } from '../src/cli.ts'
import type { ElevenLabsClient } from '../src/voice/elevenlabs.ts'
import type { TwilioClient, Dial } from '../src/voice/twilio.ts'

export function setup(env: Record<string, string> = {}) {
  const config: Config = loadConfig({ DATA_DIR: '/tmp/unused', ...env })
  const db: DB = openDb(':memory:')
  migrate(db)
  seed(db)
  const dials: Dial[] = []
  const registered: unknown[] = []
  const elevenlabs: ElevenLabsClient = {
    async registerCall(r) {
      registered.push(r)
      return { twiml: '<Response><Connect><Stream url="wss://x"><Parameter name="conversation_id" value="conv_test1"/></Stream></Connect></Response>', conversationId: 'conv_test1' }
    },
  }
  const twilio: TwilioClient = { async createCall(d) { dials.push(d); return { sid: 'CAtest' + dials.length, status: 'queued' } } }
  return { config, db, elevenlabs, twilio, dials, registered }
}

export const LIVE_ENV = {
  DIALING_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'ACx', TWILIO_API_KEY_SID: 'SKx', TWILIO_API_KEY_SECRET: 's',
  TWILIO_AUTH_TOKEN: 'authtoken', ELEVENLABS_API_KEY: 'k', ELEVENLABS_AGENT_ID: 'agent_x',
}
