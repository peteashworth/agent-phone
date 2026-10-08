// Server-enforced hard stops (docs/disclosure.md). Deterministic on purpose: the model never gets a chance to talk
// the person out of it. Errs toward stopping; a false positive costs one call, a false negative costs trust.

export type HardStop = 'ai_objection' | 'recording_objection' | 'opt_out'

export const CLOSE_LINES: Record<HardStop, string> = {
  ai_objection: 'Understood, sorry to bother you. Goodbye.',
  recording_objection: 'Understood, sorry to bother you. Goodbye.',
  opt_out: "Of course, we won't call again. Goodbye.",
}

const NOT = String.raw`(?:dont|do not|doesnt|does not|not|never|no|wont|will not|cant|cannot|refuse to|rather not|wouldnt)`
const BOT = String.raw`(?:an? )?(?:ai|a\.i\.?|robot|robo ?call(?:er)?|bot|machine|computer|recording|automated (?:system|voice|call)|artificial intelligence)`

const RULES: [HardStop, RegExp][] = [
  // opt-out first: "don't call me again" also contains a refusal
  ['opt_out', new RegExp([
    String.raw`\b${NOT} (?:ever )?call(?:ing)? (?:me|us|this number|here|my number)(?: \w+)? ?(?:again|anymore|any more)\b`,
    String.raw`\bstop calling\b`,
    String.raw`\b(?:take|remove|delete|put) (?:me|us|my number|this number) (?:off|from|on) (?:your|the|this) (?:list|do not call|dont call)`,
    String.raw`\bdo not call list\b`, String.raw`\bdont call list\b`,
    String.raw`\b(?:lose|delete) (?:my|this) number\b`,
  ].join('|')) ],
  ['recording_objection', new RegExp([
    String.raw`\b${NOT} (?:\w+ ){0,3}(?:be(?:ing)? |get(?:ting)? )?record(?:ed|ing)?\b`,
    String.raw`\bstop (?:the )?record(?:ing)?\b`,
    String.raw`\b(?:turn|shut) (?:off|of) (?:the )?record(?:ing|er)?\b`,
    String.raw`\b${NOT} (?:\w+ ){0,2}consent\b`,
    String.raw`\brecording (?:isnt|is not) (?:ok|okay|alright|fine|allowed)\b`,
    String.raw`\bnot (?:ok|okay|alright|fine|comfortable) (?:with )?(?:being |the |this )?record`,
  ].join('|')) ],
  ['ai_objection', new RegExp([
    String.raw`\b${NOT} (?:\w+ ){0,3}(?:talk|speak|deal|chat)(?:ing)? (?:to|with) ${BOT}\b`,
    String.raw`\b(?:want|need|let me|can i|put me through to|get me|give me|transfer me to|connect me (?:to|with)) (?:talk to |speak (?:to|with) )?(?:a |an )?(?:real|actual|live) (?:person|human|someone)\b`,
    String.raw`\b(?:talk|speak) (?:to|with) (?:a |an )?(?:real |actual |live )?(?:human|person) (?:please|instead)\b`,
    String.raw`\b(?:i|we) (?:dont|do not) (?:talk|speak) to (?:ai|robots?|bots?|machines?)\b`,
    String.raw`\bno (?:ai|robots?|bots?|robocalls?)\b`,
    String.raw`\b(?:hang|hanging) up on (?:a |an |the |this )?(?:ai|robot|bot|machine)\b`,
  ].join('|')) ],
]

// "I don't mind…", "no problem", "not a problem" are consent, not objection.
const CONSENT = /\b(?:dont|do not) mind\b|\bno problem\b|\bnot a problem\b|\bnot an issue\b|\bthats (?:fine|ok|okay)\b/

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[’‘`]/g, "'").replace(/'/g, '').replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function detectHardStop(utterance: string): HardStop | null {
  const t = normalize(utterance)
  if (!t) return null
  for (const [kind, re] of RULES) {
    const m = re.exec(t)
    if (!m) continue
    // consent phrasing only rescues objections, never an explicit opt-out
    if (kind !== 'opt_out' && CONSENT.test(t) && !/\b(?:stop|hang up|goodbye|bye)\b/.test(t)) continue
    return kind
  }
  return null
}
