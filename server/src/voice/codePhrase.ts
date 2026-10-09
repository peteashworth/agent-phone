// Code-phrase matching (docs/milestone-d-brain.md §7, Pete tier). Pure functions: the phrase comes from config
// (CODE_PHRASE) and is never logged, stored, or sent anywhere. The match is loose on purpose (speech-to-text noise):
// words are normalized, filler words dropped, numbers spelled out, near spellings / common homophones / plurals count
// as the same word, a word STT split in two (or two it joined) still matches, at most one stray word may sit between
// two phrase words, and a phrase of 5+ words may lose one word. Speech that comes close without matching is a
// near-miss: the caller never hears about it, but it counts as an attempt.

const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'oh'])
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

// Words that carry no weight in a near-miss: "the" and "my" turning up in order is just English.
const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'is', 'it',
  'its', 'i', 'im', 'me', 'my', 'you', 'your', 'we', 'our', 'us', 'he', 'she', 'they', 'this', 'that', 'be', 'are',
  'was', 'were', 'so', 'just', 'yes', 'no', 'yeah', 'okay', 'ok', 'well', 'like', 'do', 'dont', 'what', 'hi', 'hey'])

// Sound-alikes STT swaps freely. Each group is one word for matching.
const HOMOPHONES = [['to', 'too', 'two'], ['for', 'four', 'fore'], ['one', 'won'], ['eight', 'ate'], ['their', 'there', 'theyre'],
  ['by', 'buy', 'bye'], ['no', 'know'], ['new', 'knew'], ['right', 'write', 'rite'], ['see', 'sea'], ['blue', 'blew'],
  ['red', 'read'], ['here', 'hear'], ['son', 'sun'], ['i', 'eye'], ['night', 'knight'], ['flower', 'flour'], ['mail', 'male'],
  ['tail', 'tale'], ['pair', 'pear', 'pare'], ['bear', 'bare'], ['deer', 'dear'], ['which', 'witch'], ['whole', 'hole'],
  ['weather', 'whether'], ['meet', 'meat'], ['peace', 'piece'], ['rain', 'reign', 'rein'], ['road', 'rode'], ['sail', 'sale']]
const SOUND = new Map(HOMOPHONES.flatMap(g => g.map(w => [w, g[0]] as const)))

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

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j), prev2 = prev
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      // a swapped pair of letters ("purpel") is one edit
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1)
    }
    prev2 = prev
    prev = cur
  }
  return prev[b.length]
}

/** Same word for matching: exact, a sound-alike, a plural/tense of it, or a near spelling (1 edit at 4+ letters, 2 at 8+; a swapped letter pair is 1). */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  if ((SOUND.get(a) ?? a) === (SOUND.get(b) ?? b)) return true
  const sa = stem(a), sb = stem(b)
  if (sa === sb) return true
  const n = Math.min(a.length, b.length)
  const max = n >= 8 ? 2 : n >= 4 ? 1 : 0
  return max > 0 && editDistance(sa, sb, max) <= max
}

type Word = { w: string; tok: number }

function wordsOf(text: string): Word[] {
  const words: Word[] = []
  text.split(/\s+/).filter(Boolean).forEach((r, tok) => { for (const w of tokenWords(r)) words.push({ w, tok }) })
  return words
}

/**
 * Matches want[k..] against words from index j: how many text words and phrase words one step consumes, or null.
 * Covers one-to-one, a phrase word split by STT ("blue bird" for "bluebird") and two phrase words joined ("bluebird").
 */
function step(words: Word[], j: number, want: string[], k: number): { text: number; phrase: number } | null {
  const w = words[j]?.w
  if (w == null) return null
  if (sameWord(w, want[k])) return { text: 1, phrase: 1 }
  const next = words[j + 1]?.w
  if (next != null && want[k].length >= 6 && sameWord(w + next, want[k])) return { text: 2, phrase: 1 }
  if (k + 1 < want.length && w.length >= 6 && sameWord(w, want[k] + want[k + 1])) return { text: 1, phrase: 2 }
  return null
}

/** Span [start, end] of raw whitespace tokens holding the phrase, or null. */
export function findPhrase(text: string, phrase: string): { start: number; end: number } | null {
  const want = phraseWords(phrase)
  if (!want.length) return null
  const words = wordsOf(text)
  const maySkip = want.length >= 5 ? 1 : 0
  // Depth-first from each start: the phrase's words in order, one stray text word between two of them at most,
  // and (long phrases only) one phrase word missing.
  const go = (j: number, k: number, skipped: number, first: number): number | null => {
    if (k === want.length) return j - 1
    for (const gap of [0, 1]) {
      if (gap && j === first) break // no stray word before the first matched word
      const s = step(words, j + gap, want, k)
      if (s) {
        const end = go(j + gap + s.text, k + s.phrase, skipped, first)
        if (end != null) return end
      }
    }
    if (skipped < maySkip && k > 0 && k < want.length - 1) return go(j, k + 1, skipped + 1, first)
    return null
  }
  for (let i = 0; i < words.length; i++) {
    for (const k0 of maySkip ? [0, 1] : [0]) { // a long phrase may also lose its first word
      if (!step(words, i, want, k0)) continue
      const end = go(i, k0, k0, i)
      if (end != null) return { start: words[i].tok, end: words[end].tok }
    }
  }
  return null
}

/**
 * A near-miss: no match, but the phrase's weighty words (stopwords don't count) turn up in order within a short
 * window: more than half of them, and at least 2. Normal talk almost never does that with a 4-uncommon-word phrase.
 */
export function nearMiss(text: string, phrase: string): boolean {
  const want = phraseWords(phrase).filter(w => !STOPWORDS.has(w))
  if (want.length < 2 || findPhrase(text, phrase)) return false
  const words = wordsOf(text).map(x => x.w).filter(w => !STOPWORDS.has(w))
  const need = Math.max(2, Math.floor(want.length / 2) + 1)
  const span = want.length + 2
  for (let i = 0; i < words.length; i++) {
    const win = words.slice(i, i + span)
    // longest common subsequence under sameWord
    let prev = new Array(want.length + 1).fill(0)
    for (const w of win) {
      const cur = [0]
      for (let k = 1; k <= want.length; k++) cur[k] = sameWord(w, want[k - 1]) ? prev[k - 1] + 1 : Math.max(prev[k], cur[k - 1])
      prev = cur
    }
    if (prev[want.length] >= need) return true
  }
  return false
}

/** The text with the phrase's tokens removed (whitespace collapsed). */
export function removePhrase(text: string, phrase: string): { found: boolean; text: string } {
  const span = findPhrase(text, phrase)
  if (!span) return { found: false, text }
  const raw = text.split(/\s+/).filter(Boolean)
  return { found: true, text: [...raw.slice(0, span.start), ...raw.slice(span.end + 1)].join(' ') }
}
