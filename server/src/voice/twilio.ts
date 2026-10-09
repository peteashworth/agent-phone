import type { Config } from '../config.ts'
import { type Fetch, ProviderError } from './http.ts'

export type Dial = {
  to: string; from: string; twiml: string; timeLimit: number; statusCallback: string
  /** Async answering-machine detection: Twilio posts AnsweredBy here while the call carries on. */
  amd?: { callback: string; timeoutS: number }
  /** Seconds to ring before giving up (Twilio Timeout; Twilio's default is 60). */
  ringS?: number
}

export type TwilioClient = {
  createCall(d: Dial): Promise<{ sid: string; status: string }>
  /** Ends a live call (Status=completed). */
  endCall(sid: string): Promise<void>
  /** price is positive USD, null until Twilio has rated the call (a few minutes after it ends). */
  fetchCall(sid: string): Promise<{ status: string; duration: number | null; price?: number | null }>
}

export function twilioClient(c: Config, f: Fetch = fetch): TwilioClient {
  const auth = () => {
    if (!c.TWILIO_ACCOUNT_SID || !c.TWILIO_API_KEY_SID || !c.TWILIO_API_KEY_SECRET) throw new Error('Twilio is not configured')
    return 'Basic ' + Buffer.from(`${c.TWILIO_API_KEY_SID}:${c.TWILIO_API_KEY_SECRET}`).toString('base64')
  }
  const callUrl = (sid: string) => `${c.TWILIO_API_BASE}/2010-04-01/Accounts/${c.TWILIO_ACCOUNT_SID}/Calls/${encodeURIComponent(sid)}.json`
  return {
    async endCall(sid) {
      const res = await f(callUrl(sid), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: auth() },
        body: 'Status=completed',
      })
      if (!res.ok) throw new ProviderError('twilio', res.status, await res.text())
    },
    async fetchCall(sid) {
      const res = await f(callUrl(sid), { method: 'GET', headers: { authorization: auth() } })
      const body = await res.text()
      if (!res.ok) throw new ProviderError('twilio', res.status, body)
      const j = JSON.parse(body) as { status: string; duration: string | null; price: string | null }
      return { status: j.status, duration: j.duration ? Number(j.duration) : null, price: j.price != null ? Math.abs(Number(j.price)) : null }
    },
    async createCall(d) {
      const authorization = auth()
      const form = new URLSearchParams({
        To: d.to, From: d.from, Twiml: d.twiml, TimeLimit: String(d.timeLimit),
        StatusCallback: d.statusCallback, StatusCallbackMethod: 'POST',
      })
      if (d.ringS) form.set('Timeout', String(d.ringS))
      for (const e of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', e)
      if (d.amd) {
        form.set('MachineDetection', 'Enable'); form.set('AsyncAmd', 'true')
        form.set('AsyncAmdStatusCallback', d.amd.callback); form.set('AsyncAmdStatusCallbackMethod', 'POST')
        form.set('MachineDetectionTimeout', String(d.amd.timeoutS))
      }
      const res = await f(`${c.TWILIO_API_BASE}/2010-04-01/Accounts/${c.TWILIO_ACCOUNT_SID}/Calls.json`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization,
        },
        body: form.toString(),
      })
      const body = await res.text()
      if (!res.ok) throw new ProviderError('twilio', res.status, body)
      const j = JSON.parse(body) as { sid: string; status: string }
      return { sid: j.sid, status: j.status }
    },
  }
}
