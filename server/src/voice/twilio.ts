import type { Config } from '../config.ts'
import { type Fetch, ProviderError } from './http.ts'

export type Dial = { to: string; from: string; twiml: string; timeLimit: number; statusCallback: string }

export type TwilioClient = {
  createCall(d: Dial): Promise<{ sid: string; status: string }>
}

export function twilioClient(c: Config, f: Fetch = fetch): TwilioClient {
  return {
    async createCall(d) {
      if (!c.TWILIO_ACCOUNT_SID || !c.TWILIO_API_KEY_SID || !c.TWILIO_API_KEY_SECRET) throw new Error('Twilio is not configured')
      const form = new URLSearchParams({
        To: d.to, From: d.from, Twiml: d.twiml, TimeLimit: String(d.timeLimit),
        StatusCallback: d.statusCallback, StatusCallbackMethod: 'POST',
      })
      for (const e of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', e)
      const res = await f(`${c.TWILIO_API_BASE}/2010-04-01/Accounts/${c.TWILIO_ACCOUNT_SID}/Calls.json`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: 'Basic ' + Buffer.from(`${c.TWILIO_API_KEY_SID}:${c.TWILIO_API_KEY_SECRET}`).toString('base64'),
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
