// Phone facts with share rules (docs/milestone-d-brain.md R4). The file lives on the droplet only (FACTS_FILE, 0600)
// and is re-read when it changes. Facts reach the brain only if place_call picked them (by id or topic) and the tier
// allows it; the output filter blocks every locked or never-share value across the whole file.
import { readFileSync, statSync } from 'node:fs'
import { z } from 'zod'
import type { Config } from './config.ts'

const factSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string(),
  value: z.string().min(1),
  share: z.enum(['anyone', 'code', 'never']),
  topics: z.array(z.string()).default([]),
})
const fileSchema = z.object({ version: z.literal(1), facts: z.array(factSchema) })

export type Fact = z.infer<typeof factSchema>
export type Tier = 'public' | 'personal'
/** What the brain is given for a fact: never the share rule's internals, never the topics. */
export type SharedFact = { id: string; label: string; value: string }

let cache: { path: string; mtimeMs: number; facts: Fact[] } | null = null

/** All facts in FACTS_FILE ([] if unset). A broken file throws: better no call than a filter without its block list. */
export function loadFacts(c: Config): Fact[] {
  if (!c.FACTS_FILE) return []
  const { mtimeMs } = statSync(c.FACTS_FILE)
  if (cache?.path === c.FACTS_FILE && cache.mtimeMs === mtimeMs) return cache.facts
  const parsed = fileSchema.safeParse(JSON.parse(readFileSync(c.FACTS_FILE, 'utf8')))
  if (!parsed.success) throw new Error(`FACTS_FILE is invalid: ${z.prettifyError(parsed.error)}`)
  cache = { path: c.FACTS_FILE, mtimeMs, facts: parsed.data.facts }
  return cache.facts
}

/** Facts picked by ids or topics. Unknown selectors are reported so place_call can refuse a typo. */
export function pickFacts(all: Fact[], selectors: string[]): { picked: Fact[]; unknown: string[] } {
  const unknown = selectors.filter(s => !all.some(f => f.id === s || f.topics.includes(s)))
  const picked = all.filter(f => selectors.some(s => f.id === s || f.topics.includes(s)))
  return { picked, unknown }
}

const share = (f: Fact): SharedFact => ({ id: f.id, label: f.label, value: f.value })

/** anyone facts go out from call.start; code facts only with the verified turn; never facts never. */
export function factsFor(picked: Fact[], rule: 'anyone' | 'code'): SharedFact[] {
  return picked.filter(f => f.share === rule).map(share)
}

/** Output-filter exemptions and blocks for this call at this tier. */
export function filterFacts(all: Fact[], picked: Fact[], tier: Tier): { allow: string[]; block: string[] } {
  const open = (f: Fact) => picked.includes(f) && (f.share === 'anyone' || (f.share === 'code' && tier === 'personal'))
  return {
    allow: all.filter(open).map(f => f.value),
    block: all.filter(f => f.share === 'never' || (f.share === 'code' && !open(f))).map(f => f.value),
  }
}
