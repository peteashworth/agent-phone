// Option B-lite opening (Oct 8): the agent's first_message is blank, so ElevenLabs waits up to turn.initial_wait_time
// (3s) for the callee to speak before the first turn reaches us. What they said, if anything, feeds the AMD verdict:
// a short "hello" is a person, a long unbroken greeting or voicemail wording is a machine.

/** Voicemail, carrier and IVR wording. Checked on every user turn until the brain has spoken. */
const MACHINE_WORDING = new RegExp([
  String.raw`leave (?:a|your|me a)(?: \w+)? message`, String.raw`(?:after|at) the (?:tone|beep)`, String.raw`voice ?mail`, 'mailbox',
  String.raw`(?:can ?not|can'?t|unable to) (?:come to|take|get to|answer) (?:the|your|my) (?:phone|call)`,
  String.raw`(?:you'?ve|you have) reached`, String.raw`(?:is|are) (?:not available|unavailable)`,
  String.raw`(?:trying to reach|you (?:have )?(?:called|dialed)) .*(?:not available|unavailable|not in service|disconnected)`,
  String.raw`record your (?:message|name)`, String.raw`press (?:one|1|pound|star)`, String.raw`(?:not|no longer) in service`,
].map(p => `\\b${p}`).join('|'), 'i')

/** A greeting this long, said before we've spoken at all, is a recording. */
export const MACHINE_GREETING_WORDS = 10
/** "Hello?", "Hi, this is Pete", "Yeah, hello": a person picking up. */
export const HUMAN_GREETING_WORDS = 4

export type GreetingClass = 'machine' | 'human' | null

/**
 * opening: the callee's first words, before the disclosure. Later turns (still before the brain has spoken) only
 * check the wording, since a person answering the disclosure can say anything at length.
 */
export function classifyGreeting(text: string, opening: boolean): GreetingClass {
  const t = text.replace(/[’]/g, "'").replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (MACHINE_WORDING.test(t)) return 'machine'
  if (!opening) return null
  const words = t.split(' ').filter(w => /\w/.test(w)).length
  if (words >= MACHINE_GREETING_WORDS) return 'machine'
  if (words <= HUMAN_GREETING_WORDS) return 'human'
  return null
}
