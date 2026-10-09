// Twilio webhooks: call status callbacks + inbound voice on our owned number.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Deps } from '../calls.ts'
import { applyTwilioStatus, getCall, callBySid } from '../calls.ts'
import { applyAmd, notifyDashboard } from '../postcall.ts'
import { handleInbound } from '../inbound.ts'
import { safeEqual, twilioSignature } from '../auth.ts'

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
    // ?call= on outbound; inbound calls arrive via the number's status callback (no ?call=), matched by CallSid.
    const sid = (req.body as Form).CallSid
    const id = (req.query as Form).call ?? (sid ? callBySid(db, sid)?.id : undefined)
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

  // Inbound to our owned number: Pete's numbers reach the Pete agent (src/inbound.ts); everyone else hears a fixed line.
  app.post('/twilio/voice', async (req, reply) => {
    if (!verified(req)) return reply.code(403).send('forbidden')
    const r = await handleInbound(d, req.body as Form)
    if (r.callId) { req.log.info({ call: r.callId }, 'inbound call'); notifyDashboard(d) }
    return reply.type('text/xml').send(r.twiml)
  })
}
