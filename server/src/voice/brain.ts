// What the voice agent says on a turn. 'canned' = scripted lines, no model (hard-stop tests, latency tests).
// 'openai' = streaming passthrough to any OpenAI-compatible chat/completions URL (Milestone D: the fast model).
import type { Config } from '../config.ts'
import { ProviderError } from './http.ts'

export type ChatMessage = { role: string; content: unknown }
export type Brain = { reply(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string> }

/** Message content may be a string or an array of {type:'text', text} parts. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(p => (p && typeof p === 'object' && 'text' in p ? String(p.text) : '')).join(' ')
  return ''
}

export const CANNED_LINES = [
  "Thanks. This is a test of Pete's phone line, so feel free to say anything you like.",
  'Got it. Keep going whenever you are ready.',
  'Understood. Anything else you want to try?',
  'Okay. I will wrap up the test whenever you hang up.',
]
// Saying "filter test" makes the canned brain try to leak a fake email, to prove the output filter live.
export const FILTER_TEST_LINE = 'Sure. The address on file is test.private@example.com, and that is all.'

export function cannedBrain(): Brain {
  return {
    async *reply(messages) {
      const users = messages.filter(m => m.role === 'user')
      const last = textOf(users.at(-1)?.content).toLowerCase()
      const line = /filter test/.test(last) ? FILTER_TEST_LINE : CANNED_LINES[Math.min(Math.max(users.length - 1, 0), CANNED_LINES.length - 1)]
      for (const w of line.split(/(?<= )/)) yield w
    },
  }
}

export function openaiBrain(c: Config, f: typeof fetch = fetch): Brain {
  return {
    async *reply(messages, signal) {
      const res = await f(c.BRAIN_URL!, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', ...(c.BRAIN_API_KEY ? { authorization: `Bearer ${c.BRAIN_API_KEY}` } : {}) },
        body: JSON.stringify({ model: c.BRAIN_MODEL, messages, stream: true }),
      })
      if (!res.ok || !res.body) throw new ProviderError('brain', res.status, await res.text())
      const dec = new TextDecoder()
      let buf = ''
      for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(bytes, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') return
          const text = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content
          if (text) yield text
        }
      }
    },
  }
}

export function makeBrain(c: Config): Brain {
  return c.BRAIN === 'openai' ? openaiBrain(c) : cannedBrain()
}
