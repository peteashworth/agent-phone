// Last line of defence on what the voice agent says: the brain's text is held back one sentence at a time and any
// sentence that looks like private data is swapped for a refusal line before it reaches TTS. Costs first-sentence
// latency, which is the price of being able to un-say something.

export const BLOCKED_LINE = "Sorry, I can't share that on this call."

export type BlockReason = 'email' | 'card_number' | 'ssn' | 'street_address' | 'private_term' | 'private_fact' | 'intimate'

// Blocked in the public tier, on top of INTIMATE_TERMS (docs/phone-persona.md). Pete's personal tier lets them through.
export const DEFAULT_INTIMATE_TERMS = ['girlfriend', 'sexy', 'sex', 'sexual', 'naked', 'nude', 'lingerie', 'intimate',
  'make love', 'making love', 'turn me on', 'foreplay', 'orgasm', 'aroused', 'horny', 'erotic',
  'in bed together', 'my love', 'i love you']

export type FilterOptions = {
  /**
   * Personal tier (code phrase verified, Pete only): intimate terms, email, street address and PRIVATE_TERMS are let
   * through. Card numbers, SSNs and never-facts stay blocked in every tier.
   */
  personal?: boolean
  /** Extra intimate terms (config INTIMATE_TERMS); blocked with DEFAULT_INTIMATE_TERMS outside the personal tier. */
  intimate?: string[]
  /** Exact fact values this call may say; exempt from the pattern checks (a VIN, an address the brief allows). */
  allow?: string[]
  /** Fact values that must never be said on this call (locked code facts, every never fact). */
  block?: string[]
}

const EMAIL = /[a-z0-9._%+-]+\s*(?:@|\bat\b)\s*[a-z0-9-]+(?:\s*(?:\.|\bdot\b)\s*[a-z0-9-]+)*\s*(?:\.|\bdot\b)\s*(?:com|net|org|edu|gov|io|ai|co|us|me|info)\b/i
const SSN = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/
const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g
const STREET = new RegExp(String.raw`\b\d{1,6}\s+(?:[nsew]\.?\s+|north\s+|south\s+|east\s+|west\s+)?(?:[a-z0-9]+\s+){0,3}` +
  String.raw`(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|circle|cir|place|pl|parkway|pkwy|terrace|ter|highway|hwy|trail|trl)\b\.?`, 'i')

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i])
    if (i % 2) { n *= 2; if (n > 9) n -= 9 }
    sum += n
  }
  return sum % 10 === 0
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ')

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordsRe = (terms: string[]) => terms.length
  ? new RegExp(String.raw`(?<![a-z0-9])(?:${terms.map(t => escape(squash(t))).join('|')})(?![a-z0-9])`, 'i') : null
const INTIMATE = wordsRe(DEFAULT_INTIMATE_TERMS)!

export function checkText(text: string, privateTerms: string[], o: FilterOptions = {}): BlockReason | null {
  let t = squash(text)
  if (!o.personal && (INTIMATE.test(t) || wordsRe(o.intimate ?? [])?.test(t))) return 'intimate'
  if (o.block?.some(v => v && t.includes(squash(v)))) return 'private_fact'
  for (const v of o.allow ?? []) if (v) t = t.split(squash(v)).join(' allowed ')
  if (!o.personal && EMAIL.test(t)) return 'email'
  if (SSN.test(t)) return 'ssn'
  for (const m of t.match(DIGIT_RUN) ?? []) {
    const d = m.replace(/\D/g, '')
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return 'card_number'
  }
  if (!o.personal && STREET.test(t)) return 'street_address'
  if (!o.personal && privateTerms.some(p => p && t.includes(squash(p)))) return 'private_term'
  return null
}

/**
 * Makes model text safe to read aloud: drops [[control tags]], markdown, URLs and emoji. Bracket audio tags like
 * [warmly] stay (ElevenLabs uses them for delivery and doesn't read them).
 */
export function speakable(text: string): string {
  return text
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[*_#`~>|]+/g, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
}

// Sentence end: . ! ? followed by whitespace. "1.5", "a@b.com" and "Dr. Smith"-style abbreviations mostly don't split
// because the next char isn't whitespace or the fragment is re-checked together with what follows.
const BOUNDARY = /[.!?]+["')\]]*\s+/g

export class OutputFilter {
  private buf = ''
  private lastBlocked = false
  readonly blocked: BlockReason[] = []
  private terms: string[]
  private opts: FilterOptions
  constructor(terms: string[], opts: FilterOptions = {}) { this.terms = terms; this.opts = opts }

  /** Feed streamed text; returns whatever is now safe to speak (possibly ''). */
  push(chunk: string): string {
    this.buf += chunk
    let out = '', cut = 0
    for (const m of this.buf.matchAll(BOUNDARY)) {
      const end = m.index! + m[0].length
      out += this.emit(this.buf.slice(cut, end))
      cut = end
    }
    this.buf = this.buf.slice(cut)
    return out
  }

  /** End of the reply: release (or block) the tail. */
  flush(): string {
    const out = this.buf ? this.emit(this.buf) : ''
    this.buf = ''
    return out
  }

  private emit(raw: string): string {
    const sentence = speakable(raw)
    if (!sentence.trim()) return ''
    const why = checkText(sentence, this.terms, this.opts)
    if (!why) { this.lastBlocked = false; return sentence }
    this.blocked.push(why)
    if (this.lastBlocked) return '' // one refusal line per run of blocked sentences
    this.lastBlocked = true
    return BLOCKED_LINE + ' '
  }
}
