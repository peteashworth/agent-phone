// Sets how long ElevenLabs waits before it decides the callee has finished a turn (turn.turn_eagerness).
//   patient  waits for higher turn confidence, so ~1s mid-sentence pauses don't end the turn (Oct 8, call_b2xhPMDZe6Yi:
//            "normal" split one sentence into fragments, each one cancelling the request before it)
//   normal   ElevenLabs default (revert)
//   eager    responds sooner
// The API has no millisecond silence threshold; this enum is the only knob besides turn_model.
// --speculative on|off  also sets turn.speculative_turn. On, ElevenLabs re-sends the LLM request ~every 150ms while the
//            callee is still talking (call_ETdA_LdKkwZV: 3 bursts, each cancelling the last), so we run it OFF (Oct 8).
// usage: node elevenlabs/turn-eagerness.mjs patient|normal|eager [--speculative on|off] [--dry]   (needs xi-api-key; OneCLI injects it)
const AGENT = 'agent_2601m4ej7de7fjbtgxag3c0n7yv9'
const MODE = process.argv[2], DRY = process.argv.includes('--dry')
const SPEC = process.argv.includes('--speculative') ? process.argv[process.argv.indexOf('--speculative') + 1] : undefined
if (SPEC !== undefined && !['on', 'off'].includes(SPEC)) throw new Error('--speculative on|off')
if (!['patient', 'normal', 'eager'].includes(MODE)) throw new Error('usage: turn-eagerness.mjs patient|normal|eager [--dry]')
const H = { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? 'placeholder', 'content-type': 'application/json' }
const el = async (m, p, b) => {
  const r = await fetch('https://api.elevenlabs.io' + p, { method: m, headers: H, body: b && JSON.stringify(b) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${t.slice(0, 500)}`)
  return JSON.parse(t)
}
const show = a => JSON.stringify({ turn: a.conversation_config.turn, first_message: a.conversation_config.agent.first_message,
  llm: a.conversation_config.agent.prompt.llm })

const before = await el('GET', `/v1/convai/agents/${AGENT}`)
console.log('before:', show(before))
const patch = { conversation_config: { turn: { turn_eagerness: MODE, ...(SPEC ? { speculative_turn: SPEC === 'on' } : {}) } } }
if (DRY) { console.log('dry run, would PATCH', JSON.stringify(patch)); process.exit(0) }
await el('PATCH', `/v1/convai/agents/${AGENT}`, patch)
console.log('after: ', show(await el('GET', `/v1/convai/agents/${AGENT}`)))
