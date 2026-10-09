import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.ts'
import type { DB } from './db.ts'
import type { Deps } from './calls.ts'
import { elevenLabsClient } from './voice/elevenlabs.ts'
import { twilioClient } from './voice/twilio.ts'
import { twilioRoutes } from './routes/twilio.ts'
import { mcpRoutes } from './mcp.ts'
import { llmRoutes } from './routes/llm.ts'
import { apiRoutes } from './routes/api.ts'
import { brainRoutes } from './routes/brain.ts'
import { adminRoutes } from './routes/admin.ts'

export type BuildOpts = { config: Config; db: DB; clients?: Partial<Pick<Deps, 'elevenlabs' | 'twilio' | 'brain' | 'clock'>>; logger?: boolean }

export type RouteInfo = { method: string; url: string }

export async function buildApp(o: BuildOpts): Promise<FastifyInstance & { deps: Deps; routeList: RouteInfo[] }> {
  const d: Deps = {
    config: o.config, db: o.db,
    elevenlabs: o.clients?.elevenlabs ?? elevenLabsClient(o.config),
    twilio: o.clients?.twilio ?? twilioClient(o.config),
    brain: o.clients?.brain, clock: o.clients?.clock,
  }
  const app = Fastify({ logger: o.logger ?? false, trustProxy: '127.0.0.1', bodyLimit: 256 * 1024 })

  // Every route, for the permission tests (no agent-reachable route may write the allowlist or limits).
  const routeList: RouteInfo[] = []
  app.addHook('onRoute', r => { for (const m of [r.method].flat()) routeList.push({ method: m, url: r.url }) })

  await app.register(async scope => {
    scope.get('/health', async () => ({ ok: true, dialing: o.config.DIALING_ENABLED, time: new Date().toISOString() }))
    await scope.register(async s => twilioRoutes(s, d))
    await scope.register(async s => mcpRoutes(s, d))
    await scope.register(async s => llmRoutes(s, d))
    await scope.register(async s => apiRoutes(s, d))
    await scope.register(async s => brainRoutes(s, d))
    await scope.register(async s => adminRoutes(s, d))
  }, { prefix: o.config.BASE_PATH })

  return Object.assign(app, { deps: d, routeList }) as unknown as FastifyInstance & { deps: Deps; routeList: RouteInfo[] }
}
