import type { Config } from '../config.ts'
import { type Fetch, ProviderError } from './http.ts'

export type RegisterCall = {
  from: string; to: string
  /** Defaults to ELEVENLABS_AGENT_ID. */
  agentId?: string
  dynamicVariables?: Record<string, string | number | boolean>
}

export type ElevenLabsClient = {
  /** Returns TwiML that bridges the Twilio call audio to our agent; the conversation id is embedded in it. */
  registerCall(r: RegisterCall): Promise<{ twiml: string; conversationId: string | null }>
  /** Post-call record: status, transcript, analysis (summary), metadata (cost). */
  getConversation(id: string): Promise<Conversation>
  /** Call audio (mp3). */
  getAudio(id: string): Promise<Uint8Array>
  /** Deletes the conversation (transcript, audio, analysis). A 404 counts as deleted. */
  deleteConversation(id: string): Promise<void>
}

export type Conversation = {
  status: string  // initiated | in-progress | processing | done | failed
  transcript?: { role: string; message: string | null; time_in_call_secs?: number }[]
  analysis?: { transcript_summary?: string | null; call_summary_title?: string | null } | null
  metadata?: { cost?: number | null; call_duration_secs?: number | null; termination_reason?: string | null }
  has_audio?: boolean
}

export function elevenLabsClient(c: Config, f: Fetch = fetch): ElevenLabsClient {
  const key = () => {
    if (!c.ELEVENLABS_API_KEY) throw new Error('ElevenLabs is not configured')
    return c.ELEVENLABS_API_KEY
  }
  const conv = (id: string) => `${c.ELEVENLABS_API_BASE}/v1/convai/conversations/${encodeURIComponent(id)}`
  return {
    async getConversation(id) {
      const res = await f(conv(id), { method: 'GET', headers: { 'xi-api-key': key() } })
      const body = await res.text()
      if (!res.ok) throw new ProviderError('elevenlabs', res.status, body)
      return JSON.parse(body) as Conversation
    },
    async getAudio(id) {
      const res = await f(conv(id) + '/audio', { method: 'GET', headers: { 'xi-api-key': key() } })
      if (!res.ok) throw new ProviderError('elevenlabs', res.status, await res.text())
      return new Uint8Array(await res.arrayBuffer())
    },
    async deleteConversation(id) {
      const res = await f(conv(id), { method: 'DELETE', headers: { 'xi-api-key': key() } })
      if (!res.ok && res.status !== 404) throw new ProviderError('elevenlabs', res.status, await res.text())
    },
    async registerCall(r) {
      const agentId = r.agentId ?? c.ELEVENLABS_AGENT_ID
      if (!c.ELEVENLABS_API_KEY || !agentId) throw new Error('ElevenLabs is not configured')
      const res = await f(`${c.ELEVENLABS_API_BASE}/v1/convai/twilio/register-call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': c.ELEVENLABS_API_KEY },
        body: JSON.stringify({
          agent_id: agentId, from_number: r.from, to_number: r.to, direction: 'outbound',
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
