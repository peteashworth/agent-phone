// Admin CLI (run on the droplet as the service user):  node src/cli.ts <command>
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { type DB, openDb, migrate, one, run, all, audit, tx } from './db.ts'
import { createKey, revokeKey, type Scope } from './auth.ts'
import { updateContact } from './contacts.ts'

/** Idempotent baseline: Pete's caller IDs, the caller-ID rule, Pete as trusted contact, agent 'jasmine'. */
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
    run(db, `INSERT OR IGNORE INTO contacts (e164, name, trusted, inbound_allowed) VALUES ('+14358403707', 'Pete', 1, 1)`)
    run(db, `INSERT OR IGNORE INTO agents (id, name) VALUES ('jasmine', 'Jasmine')`)
    audit(db, 'cli', 'seed', null)
  })
}

const USAGE = `usage: node src/cli.ts <command>
  migrate                         apply pending migrations
  seed                            migrate + insert baseline numbers/rules/contacts/agent (idempotent)
  agent:add <id> <name>
  key:create <agent_id> [--scope agent|read]   prints the key ONCE
  key:list
  key:revoke <prefix>
  contact:set <phone> <field> <0|1>             field: trusted | do_not_call | inbound_allowed
  numbers                         show numbers + caller-ID rules`

async function main(argv: string[]) {
  const [cmd, ...args] = argv
  if (!cmd || cmd === 'help') return console.log(USAGE)
  const config = loadConfig()
  const db = openDb(join(config.DATA_DIR, 'phone.db'))
  const applied = migrate(db)
  if (applied.length) console.log('migrated:', applied.join(', '))
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
      if (!args[0] || !['agent', 'read'].includes(scope)) throw new Error(USAGE)
      if (!one(db, 'SELECT 1 FROM agents WHERE id = ?', args[0])) throw new Error(`no agent ${args[0]}`)
      const { key } = createKey(db, args[0], scope)
      console.log(`${scope} key for ${args[0]} (shown once, store it now):\n${key}`); break
    }
    case 'key:list': console.table(all(db, 'SELECT prefix, agent_id, scope, created_at, revoked_at FROM agent_keys ORDER BY id')); break
    case 'key:revoke': console.log(revokeKey(db, args[0] ?? '') ? 'revoked' : 'no active key with that prefix'); break
    case 'contact:set': {
      const [phone, field, v] = args
      if (!phone || !['trusted', 'do_not_call', 'inbound_allowed'].includes(field) || !['0', '1'].includes(v)) throw new Error(USAGE)
      console.log(updateContact(db, 'cli', phone, { [field]: v === '1' })); break
    }
    case 'numbers':
      console.table(all(db, 'SELECT * FROM numbers'))
      console.table(all(db, 'SELECT priority, to_e164, from_label, note FROM from_rules ORDER BY priority')); break
    default: throw new Error(USAGE)
  }
  db.close()
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1) })
