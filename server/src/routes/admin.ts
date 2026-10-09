// Pete's controls: {BASE_PATH}/admin/*. Admin-scope key ONLY (aph_a_, made with the CLI on the droplet). Agent, read
// and brain keys get 401 here, and no MCP tool can reach any of this: an agent a caller can talk to must never be able
// to widen its own permissions (allowlist, trust, limits). Every write is audited with the key's prefix.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Deps } from '../calls.ts'
import { authenticateKey } from '../auth.ts'
import { all, one } from '../db.ts'
import { type Contact, listContacts, adminSetContact, normalizeOrThrow } from '../contacts.ts'
import { describeSettings, saveSettings, effective, SettingError, MAX_ALLOWED } from '../settings.ts'
import { spend } from '../safety.ts'

const contactBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  notes: z.string().max(2000).optional(),
  tz: z.string().min(1).max(64).nullable().optional(),
  allowed: z.boolean().optional(),
  trusted: z.boolean().optional(),
  inbound_allowed: z.boolean().optional(),
  known: z.boolean().optional(), // shorter first-name opener (still says the call is recorded)
  do_not_call: z.literal(true).optional(), // clearing it is CLI-only
}).strict()

const view = (c: Contact) => ({
  phone: c.e164, name: c.name, tz: c.tz, notes: c.notes, allowed: !!c.allowed, trusted: !!c.trusted, known: !!c.known,
  inbound_allowed: !!c.inbound_allowed, do_not_call: !!c.do_not_call, updated_at: c.updated_at,
})

export async function adminRoutes(app: FastifyInstance, d: Deps) {
  const { db } = d
  const admin = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const k = authenticateKey(db, req.headers.authorization, 'admin')
    if (k) return `${k.agent_id} (${k.prefix})`
    void reply.code(401).send({ error: 'admin key required' })
    return null
  }
  const bad = (reply: FastifyReply, e: unknown) => reply.code(400).send({ error: e instanceof z.ZodError
    ? e.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') : (e as Error).message })

  app.get('/admin/contacts', async (req, reply) => {
    if (!admin(req, reply)) return reply
    const contacts = listContacts(db).map(view)
    return { contacts, allowed_count: contacts.filter(c => c.allowed).length, max_allowed: MAX_ALLOWED }
  })

  // Add or change one contact. POST and PATCH are the same upsert; a new number needs a name.
  const setContact = async (req: FastifyRequest, reply: FastifyReply, phone: string) => {
    const actor = admin(req, reply)
    if (!actor) return reply
    try {
      const body = contactBody.parse(req.body ?? {})
      return view(adminSetContact(db, actor, normalizeOrThrow(phone), body))
    } catch (e) { return bad(reply, e) }
  }
  app.post('/admin/contacts', async (req, reply) => {
    const { phone, ...rest } = (req.body ?? {}) as { phone?: string }
    if (typeof phone !== 'string') return reply.code(400).send({ error: 'phone is required' })
    req.body = rest
    return setContact(req, reply, phone)
  })
  app.patch('/admin/contacts/:phone', async (req, reply) => setContact(req, reply, (req.params as { phone: string }).phone))

  app.get('/admin/settings', async (req, reply) => {
    if (!admin(req, reply)) return reply
    const c = effective(d.config, db)
    return {
      settings: describeSettings(d.config, db),
      // Env-only, shown for context (change them in /etc/agent-phone.env on the droplet).
      env_only: { dialing_enabled: d.config.DIALING_ENABLED, voicemail_action: d.config.VOICEMAIL_ACTION, billing_tz: d.config.BILLING_TZ,
        cost_per_min_usd: d.config.COST_PER_MIN_USD },
      spend: { ...spend(c, db, new Date()), cap_day: c.SPEND_CAP_DAY_USD, cap_month: c.SPEND_CAP_MONTH_USD },
    }
  })

  // { KEY: value } saves, { KEY: null } goes back to the env value. All or nothing.
  app.patch('/admin/settings', async (req, reply) => {
    const actor = admin(req, reply)
    if (!actor) return reply
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'expected an object' })
    try { saveSettings(d.config, db, actor, body as Record<string, unknown>) } catch (e) {
      if (e instanceof SettingError) return bad(reply, e)
      throw e
    }
    return { settings: describeSettings(d.config, db) }
  })

  // The Changes list: who changed the allowlist, contacts, keys and limits, newest first.
  app.get('/admin/audit', async (req, reply) => {
    if (!admin(req, reply)) return reply
    const q = req.query as { limit?: string; before?: string }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500)
    const rows = all<{ id: number; at: string; actor: string; action: string; target: string | null; meta: string }>(db,
      `SELECT * FROM audit_log WHERE (action LIKE 'admin.%' OR action LIKE 'contact.%' OR action LIKE 'key.%'
        OR action = 'allowlist.bootstrap') AND id < ? ORDER BY id DESC LIMIT ?`,
      Number(q.before) || Number.MAX_SAFE_INTEGER, limit)
    return { changes: rows.map(r => ({ ...r, meta: JSON.parse(r.meta) as unknown })) }
  })

  // Lets the dashboard check a pasted key without changing anything.
  app.get('/admin/whoami', async (req, reply) => {
    const actor = admin(req, reply)
    if (!actor) return reply
    return { actor, contacts: one<{ n: number }>(db, 'SELECT count(*) AS n FROM contacts')!.n }
  })
}
