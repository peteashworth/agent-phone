// Twilio webhooks: call status callbacks + inbound voice on our owned number.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Deps } from '../calls.ts'
import { applyTwilioStatus, getCall } from '../calls.ts'
import { applyAmd, notifyDashboard } from '../postcall.ts'
import { inboundAllowed } from '../numbers.ts'
import { safeEqual, twilioSignature } from '../auth.ts'
import { audit } from '../db.ts'
import { toE164 } from '../phone.ts'

type Form = Record<string, string>

export async function twilioRoutes(app: FastifyInstance, d: Deps) {
  const { config: c, db } = d

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  })

  /** Real signature check with the auth token if we have it, else the shared ?t= token. Neither → reject. */
  function verified(req: FastifyRequest): boolean {
    const params = (req.body ?? {}) as Form
    if (c.TWILIO_AUTH_TOKEN) {
      const url = c.PUBLIC_BASE_URL + req.url.slice(c.BASE_PATH.length)
      const sig = req.headers['x-twilio-signature']
      return typeof sig === 'string' && safeEqual(sig, twilioSignature(c.TWILIO_AUTH_TOKEN, url, params))
    }
    const t = (req.query as Form).t
    return !!c.WEBHOOK_TOKEN && typeof t === 'string' && safeEqual(t, c.WEBHOOK_TOKEN)
  }

  app.post('/twilio/status', async (req, reply) => {
    if (!verified(req)) return reply.code(403).send('forbidden')
    const id = (req.query as Form).call
    if (!id || !applyTwilioStatus(db, id, req.body as Form)) req.log.warn({ id }, 'status callback for unknown call')
    else notifyDashboard(d)
    return reply.code(204).send()
  })

  // Async answering-machine detection verdict (AnsweredBy: human | machine_start | machine_end_* | fax | unknown).
  app.post('/twilio/amd', async (req, reply) => {
    if (!verified(req)) return reply.code(403).send('forbidden')
    const id = (req.query as Form).call, p = req.body as Form
    const call = id ? getCall(db, id) : undefined
    if (!call || (call.twilio_sid && p.CallSid && call.twilio_sid !== p.CallSid)) {
      req.log.warn({ id }, 'amd callback for unknown call')
      return reply.code(204).send()
    }
    req.log.info({ call: id, answered_by: p.AnsweredBy, ms: p.MachineDetectionDuration }, 'amd')
    await applyAmd(d, id, p.AnsweredBy || 'unknown')
    notifyDashboard(d)
    return reply.code(204).send()
  })

  // Inbound to our owned number: allow-listed contacts hear a short notice; everyone else is rejected unanswered.
  app.post('/twilio/voice', async (req, reply) => {
    if (!verified(req)) return reply.code(403).send('forbidden')
    const p = req.body as Form
    const from = toE164(p.From ?? '') ?? p.From ?? 'unknown'
    const ok = from !== 'unknown' && inboundAllowed(db, from)
    audit(db, 'twilio', ok ? 'inbound.allowed' : 'inbound.rejected', from, { to: p.To, sid: p.CallSid })
    reply.type('text/xml')
    return ok
      ? '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hi Pete. This line does not take incoming calls yet. Goodbye.</Say><Hangup/></Response>'
      : '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>'
  })
}
