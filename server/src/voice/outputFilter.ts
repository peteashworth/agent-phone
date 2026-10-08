// Last line of defence on what the voice agent says: the brain's text is held back one sentence at a time and any
// sentence that looks like private data is swapped for a refusal line before it reaches TTS. Costs first-sentence
// latency, which is the price of being able to un-say something.

export const BLOCKED_LINE = "Sorry, I can't share that on this call."

export type BlockReason = 'email' | 'card_number' | 'ssn' | 'street_address' | 'private_term'

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

export function checkText(text: string, privateTerms: string[]): BlockReason | null {
  if (EMAIL.test(text)) return 'email'
  if (SSN.test(text)) return 'ssn'
  for (const m of text.match(DIGIT_RUN) ?? []) {
    const d = m.replace(/\D/g, '')
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return 'card_number'
  }
  if (STREET.test(text)) return 'street_address'
  const t = squash(text)
  if (privateTerms.some(p => p && t.includes(squash(p)))) return 'private_term'
  return null
}

// Sentence end: . ! ? followed by whitespace. "1.5", "a@b.com" and "Dr. Smith"-style abbreviations mostly don't split
// because the next char isn't whitespace or the fragment is re-checked together with what follows.
const BOUNDARY = /[.!?]+["')\]]*\s+/g

export class OutputFilter {
  private buf = ''
  private lastBlocked = false
  readonly blocked: BlockReason[] = []
  private terms: string[]
  constructor(terms: string[]) { this.terms = terms }

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

  private emit(sentence: string): string {
    const why = checkText(sentence, this.terms)
    if (!why) { this.lastBlocked = false; return sentence }
    this.blocked.push(why)
    if (this.lastBlocked) return '' // one refusal line per run of blocked sentences
    this.lastBlocked = true
    return BLOCKED_LINE + ' '
  }
}
