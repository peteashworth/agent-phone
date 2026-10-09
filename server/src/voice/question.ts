// Did the callee just ask something? Used to refuse a brain [[end_call]] that would hang up on an open question
// (Bob call, Oct 8: "Why do all the hotshots drive a Ram?" → brain_end). Speech-to-text often drops the "?", so a
// last sentence that starts like a question counts too. A false positive only keeps the call open one more turn.

const QUESTION_START = /^(why|what|what's|how|how's|when|where|where's|who|who's|which|whose|can|could|would|will|do|does|did|is|are|was|were|should|shall|may|have|has|am|isn't|aren't|don't|doesn't|didn't|won't|wouldn't|can't|couldn't)\s/i

/** True if the last sentence of what the callee said is a question. */
export function isQuestion(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/\?["'”’)\s]*$/.test(t)) return true
  const sentences = t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)
  const last = (sentences.at(-1) ?? '').replace(/^[^\p{L}]+/u, '')
  return QUESTION_START.test(last + ' ')
}

const GOODBYE = /\b(bye|goodbye|bye-bye|good night|goodnight|see ya|talk to you (later|soon)|take care|gotta go|got to go|have to go|need to go|i.ll let you go|can i go|are we done)\b/i

/** True if the callee's own words are a goodbye ("Bye?", "Can I go now?"): their question doesn't keep the call open. */
export const isGoodbye = (text: string) => GOODBYE.test(text.replace(/[’]/g, "'"))
