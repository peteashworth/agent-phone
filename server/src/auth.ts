import { createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto'
import { type DB, one, run, audit } from './db.ts'

export type Scope = 'agent' | 'read'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Creates a bearer key. The plaintext is returned once and never stored. */
export function createKey(db: DB, agentId: string, scope: Scope): { key: string; prefix: string } {
  const key = `aph_${scope === 'read' ? 'r' : 'a'}_${randomBytes(24).toString('base64url')}`
  const prefix = key.slice(0, 12)
  run(db, 'INSERT INTO agent_keys (agent_id, scope, hash, prefix) VALUES (?, ?, ?, ?)', agentId, scope, sha256(key), prefix)
  audit(db, 'cli', 'key.create', agentId, { scope, prefix })
  return { key, prefix }
}

export function revokeKey(db: DB, prefix: string): boolean {
  const r = run(db, "UPDATE agent_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE prefix = ? AND revoked_at IS NULL", prefix)
  if (r.changes) audit(db, 'cli', 'key.revoke', prefix)
  return r.changes > 0
}

/** Resolves "Bearer <key>" to the agent id, or null. */
export function authenticate(db: DB, header: string | undefined, scope: Scope): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  if (!m) return null
  const row = one<{ agent_id: string }>(db,
    'SELECT agent_id FROM agent_keys WHERE hash = ? AND scope = ? AND revoked_at IS NULL', sha256(m[1]), scope)
  return row?.agent_id ?? null
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted(key+value)...)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('')
  return createHmac('sha1', authToken).update(data).digest('base64')
}
