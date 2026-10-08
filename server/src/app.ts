import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.ts'
import type { DB } from './db.ts'
import type { Deps } from './calls.ts'
import { elevenLabsClient } from './voice/elevenlabs.ts'
import { twilioClient } from './voice/twilio.ts'
import { twilioRoutes } from './routes/twilio.ts'
import { mcpRoutes } from './mcp.ts'

export type BuildOpts = { config: Config; db: DB; clients?: Partial<Pick<Deps, 'elevenlabs' | 'twilio'>>; logger?: boolean }

export async function buildApp(o: BuildOpts): Promise<FastifyInstance> {
  const d: Deps = {
    config: o.config, db: o.db,
    elevenlabs: o.clients?.elevenlabs ?? elevenLabsClient(o.config),
    twilio: o.clients?.twilio ?? twilioClient(o.config),
  }
  const app = Fastify({ logger: o.logger ?? false, trustProxy: '127.0.0.1', bodyLimit: 256 * 1024 })

  await app.register(async scope => {
    scope.get('/health', async () => ({ ok: true, dialing: o.config.DIALING_ENABLED, time: new Date().toISOString() }))
    await scope.register(async s => twilioRoutes(s, d))
    await scope.register(async s => mcpRoutes(s, d))
  }, { prefix: o.config.BASE_PATH })

  return app
}
