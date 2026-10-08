// Code-phrase matching (docs/milestone-d-brain.md §7). Pure functions: the phrase comes from config (CODE_PHRASE) and
// is never logged, stored, or sent anywhere. The match is loose on purpose (speech-to-text noise): words are
// normalized, filler words dropped, numbers spelled out, and the phrase's words must appear in order with at most one
// stray word between them.

const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'oh'])
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function numberWords(n: string): string[] {
  const v = Number(n)
  if (n.length <= 2 && v < 20) return [ONES[v]]
  if (n.length === 2) return v % 10 ? [TENS[Math.floor(v / 10)], ONES[v % 10]] : [TENS[v / 10]]
  return [...n].map(d => ONES[Number(d)]) // longer numbers: digit by digit
}

/** Normalized words of one raw token ("Blue-bird," -> ["blue", "bird"], "42" -> ["forty", "two"]). */
function tokenWords(raw: string): string[] {
  const t = raw.toLowerCase().replace(/[’‘`']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  if (!t) return []
  return t.split(' ').flatMap(w => /^\d+$/.test(w) ? numberWords(w) : [w]).filter(w => !FILLERS.has(w))
}

export function phraseWords(phrase: string): string[] {
  return phrase.split(/\s+/).flatMap(tokenWords)
}

/** Span [start, end] of raw whitespace tokens holding the phrase, or null. */
export function findPhrase(text: string, phrase: string): { start: number; end: number } | null {
  const want = phraseWords(phrase)
  if (!want.length) return null
  const raw = text.split(/\s+/).filter(Boolean)
  const words: { w: string; tok: number }[] = []
  raw.forEach((r, tok) => { for (const w of tokenWords(r)) words.push({ w, tok }) })
  for (let i = 0; i < words.length; i++) {
    if (words[i].w !== want[0]) continue
    let j = i, k = 1
    while (k < want.length) {
      if (words[j + 1]?.w === want[k]) j += 1
      else if (words[j + 2]?.w === want[k]) j += 2 // one stray word allowed
      else break
      k++
    }
    if (k === want.length) return { start: words[i].tok, end: words[j].tok }
  }
  return null
}

/** The text with the phrase's tokens removed (whitespace collapsed). */
export function removePhrase(text: string, phrase: string): { found: boolean; text: string } {
  const span = findPhrase(text, phrase)
  if (!span) return { found: false, text }
  const raw = text.split(/\s+/).filter(Boolean)
  return { found: true, text: [...raw.slice(0, span.start), ...raw.slice(span.end + 1)].join(' ') }
}
