import { loadConfig, type Config } from '../src/config.ts'
import { openDb, migrate, type DB } from '../src/db.ts'
import { seed } from '../src/cli.ts'
import type { ElevenLabsClient, Conversation } from '../src/voice/elevenlabs.ts'
import type { TwilioClient, Dial } from '../src/voice/twilio.ts'

// 2pm Eastern / 11am Pacific / noon Mountain: inside the default calling window everywhere in the continental US.
export const NOON = new Date('2026-10-08T18:00:00Z')

export function setup(env: Record<string, string> = {}) {
  const config: Config = loadConfig({ DATA_DIR: '/tmp/unused', HANGUP_DELAY_MS: '0', ...env })
  const db: DB = openDb(':memory:')
  migrate(db)
  seed(db)
  const dials: Dial[] = []
  const ended: string[] = []
  const registered: unknown[] = []
  const twilioState: Record<string, { status: string; duration: number | null; price?: number | null }> = {}
  const conversations: Record<string, Conversation> = {}
  const audio: Record<string, Uint8Array> = {}
  const deleted: string[] = []
  const failDelete = { on: false }
  const elevenlabs: ElevenLabsClient = {
    async registerCall(r) {
      registered.push(r)
      return { twiml: '<Response><Connect><Stream url="wss://x"><Parameter name="conversation_id" value="conv_test1"/></Stream></Connect></Response>', conversationId: 'conv_test1' }
    },
    async getConversation(id) { return conversations[id] ?? { status: 'processing' } },
    async getAudio(id) { if (!audio[id]) throw new Error('no audio'); return audio[id] },
    async deleteConversation(id) { if (failDelete.on) throw new Error('delete failed'); deleted.push(id); delete conversations[id] },
  }
  const twilio: TwilioClient = {
    async createCall(d) { dials.push(d); return { sid: 'CAtest' + dials.length, status: 'queued' } },
    async endCall(sid) { ended.push(sid) },
    async fetchCall(sid) { return twilioState[sid] ?? { status: 'in-progress', duration: null } },
  }
  const now = { t: NOON }
  const clock = () => now.t
  return { config, db, elevenlabs, twilio, dials, ended, registered, twilioState, conversations, audio, deleted, failDelete, clock, now }
}

export const LIVE_ENV = {
  DIALING_ENABLED: 'true', TWILIO_ACCOUNT_SID: 'ACx', TWILIO_API_KEY_SID: 'SKx', TWILIO_API_KEY_SECRET: 's',
  TWILIO_AUTH_TOKEN: 'authtoken', ELEVENLABS_API_KEY: 'k', ELEVENLABS_AGENT_ID: 'agent_x',
}
