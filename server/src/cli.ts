// Admin CLI (run on the droplet as the service user):  node src/cli.ts <command>
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { type DB, openDb, migrate, one, run, all, audit, tx } from './db.ts'
import { createKey, revokeKey, type Scope } from './auth.ts'
import { updateContact, adminSetContact } from './contacts.ts'
import { bootstrapAllowlist, saveSettings } from './settings.ts'
import { brainStatus } from './brainJobs.ts'

/** Idempotent baseline: Pete's caller IDs, the caller-ID rule, Pete as trusted + allowed contact, agents 'jasmine' and 'pete' (admin). */
export function seed(db: DB) {
  tx(db, () => {
    run(db, `INSERT OR IGNORE INTO numbers (label, e164, kind, description) VALUES
      ('mobile', '+14358403707', 'verified', 'Pete''s mobile (Twilio Verified Caller ID)'),
      ('line',   '+14352644845', 'owned',    'Twilio number; used when calling Pete himself')`)
    if (!one(db, 'SELECT 1 FROM from_rules')) {
      run(db, `INSERT INTO from_rules (priority, to_e164, from_label, note) VALUES
        (10, '+14358403707', 'line', 'Calls to Pete show the Twilio line'),
        (100, NULL, 'mobile', 'Default: every other call shows Pete''s mobile')`)
    }
    run(db, `INSERT OR IGNORE INTO contacts (e164, name, trusted, inbound_allowed, tz, allowed) VALUES ('+14358403707', 'Pete', 1, 1, 'America/Denver', 1)`)
    run(db, `UPDATE contacts SET tz = 'America/Denver' WHERE e164 = '+14358403707' AND tz IS NULL`)
    run(db, `INSERT OR IGNORE INTO agents (id, name) VALUES ('jasmine', 'Jasmine'), ('pete', 'Pete (admin keys)')`)
    audit(db, 'cli', 'seed', null)
  })
}

const USAGE = `usage: node src/cli.ts <command>
  migrate                         apply pending migrations
  seed                            migrate + insert baseline numbers/rules/contacts/agent (idempotent)
  agent:add <id> <name>
  key:create <agent_id> [--scope agent|read|brain|admin]   prints the key ONCE (brain = Pete's host adapter; admin = Pete's dashboard, e.g. key:create pete --scope admin)
  brain:status                    is the host adapter polling? jobs waiting?
  key:list
  key:revoke <prefix>
  contact:set <phone> <field> <0|1>             field: allowed | trusted | known | do_not_call | inbound_allowed
  contact:add <phone> <name>                    new contact (not allowed, not trusted)
  contacts                        list contacts
  contact:tz <phone> <IANA zone|none>           e.g. America/Denver; none = unknown (window must fit both US coasts)
  numbers                         show numbers + caller-ID rules
  checkins:pause | checkins:resume              stop / allow check-in calls (same switch as the dashboard Limits tab)`

async function main(argv: string[]) {
  const [cmd, ...args] = argv
  if (!cmd || cmd === 'help') return console.log(USAGE)
  const config = loadConfig()
  const db = openDb(join(config.DATA_DIR, 'phone.db'))
  const applied = migrate(db)
  if (applied.length) console.log('migrated:', applied.join(', '))
  const boot = bootstrapAllowlist(config, db)
  if (boot) console.log('allowlist seeded from ALLOWED_DESTINATIONS:', boot)
  switch (cmd) {
    case 'migrate': break
    case 'seed': seed(db); console.log('seeded'); break
    case 'agent:add': {
      const [id, name] = args
      if (!id || !name) throw new Error(USAGE)
      run(db, 'INSERT INTO agents (id, name) VALUES (?, ?)', id, name); audit(db, 'cli', 'agent.add', id)
      console.log('added', id); break
    }
    case 'key:create': {
      const i = args.indexOf('--scope'), scope = (i > -1 ? args[i + 1] : 'agent') as Scope
      if (!args[0] || !['agent', 'read', 'brain', 'admin'].includes(scope)) throw new Error(USAGE)
      if (!one(db, 'SELECT 1 FROM agents WHERE id = ?', args[0])) throw new Error(`no agent ${args[0]}`)
      const { key } = createKey(db, args[0], scope)
      console.log(`${scope} key for ${args[0]} (shown once, store it now):\n${key}`); break
    }
    case 'key:list': console.table(all(db, 'SELECT prefix, agent_id, scope, created_at, revoked_at FROM agent_keys ORDER BY id')); break
    case 'brain:status': console.log(brainStatus(config, db)); break
    case 'key:revoke': console.log(revokeKey(db, args[0] ?? '') ? 'revoked' : 'no active key with that prefix'); break
    case 'contact:set': {
      const [phone, field, v] = args
      if (!phone || !['allowed', 'trusted', 'known', 'do_not_call', 'inbound_allowed'].includes(field) || !['0', '1'].includes(v)) throw new Error(USAGE)
      // allowed and known go through the admin path (25-contact ceiling, field-level audit line).
      console.log(field === 'allowed' || field === 'known' ? adminSetContact(db, 'cli', phone, { [field]: v === '1' })
        : updateContact(db, 'cli', phone, { [field]: v === '1' })); break
    }
    case 'contact:add': {
      const [phone, ...name] = args
      if (!phone || !name.length) throw new Error(USAGE)
      console.log(adminSetContact(db, 'cli', phone, { name: name.join(' ') })); break
    }
    case 'contacts': console.table(all(db, 'SELECT e164, name, allowed, trusted, known, do_not_call, inbound_allowed, tz FROM contacts ORDER BY name')); break
    case 'checkins:pause': case 'checkins:resume':
      saveSettings(config, db, 'cli', { CHECKINS_PAUSED: cmd === 'checkins:pause' })
      console.log(cmd === 'checkins:pause' ? 'check-ins paused' : 'check-ins allowed'); break
    case 'contact:tz': {
      const [phone, tz] = args
      if (!phone || !tz) throw new Error(USAGE)
      console.log(updateContact(db, 'cli', phone, { tz: tz === 'none' ? null : tz })); break
    }
    case 'numbers':
      console.table(all(db, 'SELECT * FROM numbers'))
      console.table(all(db, 'SELECT priority, to_e164, from_label, note FROM from_rules ORDER BY priority')); break
    default: throw new Error(USAGE)
  }
  db.close()
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1) })
