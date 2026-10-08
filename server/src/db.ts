import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type DB = DatabaseSync
type Row = Record<string, unknown>

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  return db
}

/** Applies src/migrations/NNN_*.sql in order, each in its own transaction. Idempotent. */
export function migrate(db: DB): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => String(r.name)))
  const applied: string[] = []
  for (const name of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue
    tx(db, () => {
      db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'))
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(name, new Date().toISOString())
    })
    applied.push(name)
  }
  return applied
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e }
}

export function one<T = Row>(db: DB, sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined
}

export function all<T = Row>(db: DB, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}

export function run(db: DB, sql: string, ...params: (string | number | null)[]) {
  return db.prepare(sql).run(...params)
}

export function audit(db: DB, actor: string, action: string, target: string | null, meta: object = {}) {
  run(db, 'INSERT INTO audit_log (actor, action, target, meta) VALUES (?, ?, ?, ?)', actor, action, target, JSON.stringify(meta))
}
