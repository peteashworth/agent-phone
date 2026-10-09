import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { openDb, migrate } from './db.ts'
import { buildApp } from './app.ts'
import { bootstrapAllowlist } from './settings.ts'
import { watchdog } from './calls.ts'
import { postCallSweep, notifyDashboard } from './postcall.ts'

const config = loadConfig()
const db = openDb(join(config.DATA_DIR, 'phone.db'))
const applied = migrate(db)
const boot = bootstrapAllowlist(config, db)
const app = await buildApp({ config, db, logger: true })
if (applied.length) app.log.info({ applied }, 'migrations applied')
if (boot) app.log.info(boot, 'allowlist seeded from ALLOWED_DESTINATIONS (one time)')
else if (config.ALLOWED_DESTINATIONS) app.log.warn('ALLOWED_DESTINATIONS is ignored now (the allowlist is contacts.allowed); delete it from the env')
const allowed = db.prepare('SELECT e164 FROM contacts WHERE allowed = 1').all().map(r => r.e164)
app.log.info({ dialing: config.DIALING_ENABLED, allowed }, 'agent-phone config')

await app.listen({ host: config.HOST, port: config.PORT })

const dog = setInterval(() => {
  watchdog(app.deps).then(ids => { if (ids.length) app.log.warn({ ids }, 'watchdog acted') }, e => app.log.error(e, 'watchdog'))
    .then(() => postCallSweep(app.deps))
    .then(ids => { if (ids?.length) { app.log.info({ ids }, 'post-call updated'); notifyDashboard(app.deps) } }, e => app.log.error(e, 'post-call sweep'))
}, 30_000)

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, async () => {
  clearInterval(dog); await app.close(); db.close(); process.exit(0)
})
