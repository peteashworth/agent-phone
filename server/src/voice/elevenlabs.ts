import type { Config } from '../config.ts'
import { type Fetch, ProviderError } from './http.ts'

export type RegisterCall = {
  from: string; to: string
  dynamicVariables?: Record<string, string | number | boolean>
}

export type ElevenLabsClient = {
  /** Returns TwiML that bridges the Twilio call audio to our agent; the conversation id is embedded in it. */
  registerCall(r: RegisterCall): Promise<{ twiml: string; conversationId: string | null }>
}

export function elevenLabsClient(c: Config, f: Fetch = fetch): ElevenLabsClient {
  return {
    async registerCall(r) {
      if (!c.ELEVENLABS_API_KEY || !c.ELEVENLABS_AGENT_ID) throw new Error('ElevenLabs is not configured')
      const res = await f(`${c.ELEVENLABS_API_BASE}/v1/convai/twilio/register-call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': c.ELEVENLABS_API_KEY },
        body: JSON.stringify({
          agent_id: c.ELEVENLABS_AGENT_ID, from_number: r.from, to_number: r.to, direction: 'outbound',
          ...(r.dynamicVariables && { conversation_initiation_client_data: { dynamic_variables: r.dynamicVariables } }),
        }),
      })
      const body = await res.text()
      if (!res.ok) throw new ProviderError('elevenlabs', res.status, body)
      return { twiml: body, conversationId: conversationIdFromTwiml(body) }
    },
  }
}

export function conversationIdFromTwiml(twiml: string): string | null {
  return /name="conversation_id"\s+value="([^"]+)"/.exec(twiml)?.[1]
    ?? /value="([^"]+)"\s+name="conversation_id"/.exec(twiml)?.[1]
    ?? /\b(conv_[A-Za-z0-9]+)/.exec(twiml)?.[1] ?? null
}
