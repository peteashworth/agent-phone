// MCP over Streamable HTTP at {BASE_PATH}/mcp. Stateless: a fresh server + transport per request.
import type { FastifyInstance } from 'fastify'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { z } from 'zod'
import { type Deps, type CallRow, CallRefused, placeCall, getCall, listCalls, callEvents } from './calls.ts'
import { listNumbers } from './numbers.ts'
import { addContact, updateContact, getContact } from './contacts.ts'
import { authenticate } from './auth.ts'

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] })
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true })

function view(c: CallRow) {
  return {
    id: c.id, status: c.status, dry_run: !!c.dry_run, to: c.to_e164, contact: null as string | null,
    from: c.from_e164, from_label: c.from_label, purpose: c.purpose, created_at: c.created_at,
    started_at: c.started_at, ended_at: c.ended_at, duration_s: c.duration_s, end_reason: c.end_reason, error: c.error,
  }
}

export function buildMcpServer(d: Deps, agentId: string): McpServer {
  const s = new McpServer({ name: 'agent-phone', version: '0.1.0' })
  const withContact = (c: CallRow) => ({ ...view(c), contact: getContact(d.db, c.to_e164)?.name ?? null })
  const guard = <A,>(fn: (a: A) => unknown) => async (a: A) => {
    try { return json(await fn(a)) } catch (e) {
      return fail(e instanceof CallRefused ? `Refused (${e.code}): ${e.message}` : `Error: ${(e as Error).message}`)
    }
  }

  s.registerTool('place_call', {
    title: 'Place a phone call',
    description: 'Have Jasmine phone someone on Pete\'s behalf. The caller ID is chosen by the server. ' +
      'DRY RUN unless dry_run is explicitly false AND dialing is enabled on the server. ' +
      'Returns the call id immediately; poll get_call for the outcome.',
    inputSchema: {
      to: z.string().describe('Destination phone number (E.164 preferred; US numbers may omit +1)'),
      purpose: z.string().min(3).max(200).describe('One line: why we are calling'),
      brief: z.string().min(3).max(4000).describe('What the voice agent needs to know: who, context, facts it may share'),
      plan: z.string().max(4000).optional().describe('Step-by-step call plan / goals / what to do if X'),
      dry_run: z.boolean().optional().describe('Default true. Set false to actually dial.'),
    },
    annotations: { destructiveHint: true, openWorldHint: true, idempotentHint: false },
  }, guard(async a => withContact(await placeCall(d, agentId, a))))

  s.registerTool('get_call', {
    title: 'Get a call',
    description: 'Status and outcome of one call, with its status history.',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  }, guard(async ({ id }) => {
    const c = getCall(d.db, id)
    if (!c) throw new Error(`No call ${id}`)
    return { ...withContact(c), brief: c.brief, plan: c.plan, events: callEvents(d.db, id) }
  }))

  s.registerTool('list_calls', {
    title: 'List recent calls',
    description: 'Most recent first.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional(),
      status: z.string().optional(),
      to: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, guard(async a => listCalls(d.db, a).map(withContact)))

  s.registerTool('list_numbers', {
    title: 'List caller IDs',
    description: 'Numbers the service can call from. Which one is used is decided by server rules, not per call.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, guard(async () => listNumbers(d.db).map(n => ({ label: n.label, number: n.e164, kind: n.kind, active: !!n.active }))))

  s.registerTool('add_contact', {
    title: 'Add a contact',
    description: 'Save a name for a phone number. New contacts are not trusted.',
    inputSchema: { phone: z.string(), name: z.string().min(1).max(100), notes: z.string().max(2000).optional() },
  }, guard(async a => addContact(d.db, agentId, a.phone, a.name, a.notes)))

  s.registerTool('update_contact', {
    title: 'Update a contact',
    description: 'Change name/notes, or put the number on the do-not-call list. Trust and removing do-not-call are Pete-only.',
    // strict: an attempt to set trusted/inbound_allowed fails loudly instead of being silently dropped
    inputSchema: z.object({
      phone: z.string(),
      name: z.string().min(1).max(100).optional(),
      notes: z.string().max(2000).optional(),
      do_not_call: z.literal(true).optional().describe('Set true to stop all future calls to this number'),
    }).strict(),
  }, guard(async ({ phone, ...patch }) => updateContact(d.db, agentId, phone, patch)))

  return s
}

export async function mcpRoutes(app: FastifyInstance, d: Deps) {
  app.all('/mcp', async (req, reply) => {
    const agentId = authenticate(d.db, req.headers.authorization, 'agent')
    if (!agentId) return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' })
    if (req.method !== 'POST') return reply.code(405).header('allow', 'POST').send({ error: 'method not allowed (stateless server)' })

    const server = buildMcpServer(d, agentId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    reply.hijack()
    reply.raw.on('close', () => { void transport.close(); void server.close() })
    const raw = req.raw as typeof req.raw & { auth?: AuthInfo }
    raw.auth = { token: 'redacted', clientId: agentId, scopes: ['agent'] }
    await server.connect(transport)
    await transport.handleRequest(raw, reply.raw, req.body)
  })
}
