// Fixed, server-owned lines (never model-written, nothing personal in them).

export const DISCLOSURE = "Hi, this is Jasmine, Pete's AI assistant. This call is being recorded."

/**
 * The opener for this callee. Contacts Pete marked known (admin/CLI only) get a shorter one with their first name;
 * everyone else gets DISCLOSURE. The name is the first word of the contact name, letters only, so an odd name can't
 * put other words in Jasmine's mouth. Every opener must say the call is recorded, or DISCLOSURE is used instead.
 * The notice comes right after the name, so it's heard even if the callee talks over the rest (Bob call, Oct 8).
 */
export function openerFor(contact?: { name?: string | null; known?: number | boolean | null } | null): string {
  if (!contact?.known) return DISCLOSURE
  const first = (contact.name ?? '').trim().split(/\s+/)[0] ?? ''
  if (!/^\p{L}[\p{L}'’-]{0,29}$/u.test(first)) return DISCLOSURE
  return withRecordingNotice(`Hi ${first}, this call's being recorded. It's Jasmine, Pete's assistant.`)
}
/**
 * Pete-agent calls (calls.private): recording is off on that agent, so there's no recording notice, and the callee is
 * Pete himself.
 */
export const PETE_OPENER = "Hey Pete, it's Jasmine."

/** The guard: an opener without the recording notice is never spoken. */
export const withRecordingNotice = (line: string) => /\bbeing recorded\b/i.test(line) ? line : DISCLOSURE

/**
 * Said ahead of the next reply when no agent message so far has the notice in it (ElevenLabs passes back only what
 * was actually played, so a cut-off opener shows up as one without "being recorded").
 */
export const NOTICE_LINE = "Just so you know, this call's being recorded. "
/** True once the callee has heard the recording notice, judging by the agent messages ElevenLabs sends back. */
export const noticeHeard = (agentTexts: string[]) => agentTexts.some(t => /\bbeing recorded\b/i.test(t))

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

/** Roughly how long a line takes to say, so a hangup after it doesn't cut it off. */
export const speakMs = (text: string, floorMs: number) => Math.max(floorMs, 1000 + text.split(/\s+/).filter(Boolean).length * 400)
