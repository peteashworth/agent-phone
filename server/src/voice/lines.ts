// Fixed, server-owned lines (never model-written, nothing personal in them).

export const DISCLOSURE = "Hi, this is Jasmine, Pete's AI assistant. This call is being recorded."

// Slow BRAIN=jasmine turns (docs/milestone-d-brain.md §4-§5). Trailing space: each is a whole sentence the output
// filter can release at once.
export const FILLER_LINES = ['One moment. ', 'Let me check. ', 'Mm, let me see. ', 'Just a second. ', 'Hang on, one sec. ']
/** A random filler, never the one this call used last (pass -1 if none yet). */
export function pickFiller(lastIdx: number, rand = Math.random): number {
  const options = FILLER_LINES.map((_, i) => i).filter(i => i !== lastIdx)
  return options[Math.floor(rand() * options.length)]
}
export const FILLER2_LINE = 'Still with you, just a second. '
export const EXIT_LINE = "I'm sorry, I'm having trouble on my end. Pete will follow up with you. Goodbye."

/** Stands in for a code-phrase attempt in what the brain sees: the words themselves never leave the droplet. */
export const CODE_ATTEMPT_PLACEHOLDER = '[code phrase attempt, words withheld]'

/** Roughly how long a line takes to say, so a hangup after it doesn't cut it off. */
export const speakMs = (text: string, floorMs: number) => Math.max(floorMs, 1000 + text.split(/\s+/).filter(Boolean).length * 400)
