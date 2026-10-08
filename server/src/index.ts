import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { openDb, migrate } from './db.ts'
import { buildApp } from './app.ts'

const config = loadConfig()
const db = openDb(join(config.DATA_DIR, 'phone.db'))
const applied = migrate(db)
const app = await buildApp({ config, db, logger: true })
if (applied.length) app.log.info({ applied }, 'migrations applied')
app.log.info({ dialing: config.DIALING_ENABLED, allowed: config.ALLOWED_DESTINATIONS }, 'agent-phone config')

await app.listen({ host: config.HOST, port: config.PORT })

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => {
  await app.close(); db.close(); process.exit(0)
})
