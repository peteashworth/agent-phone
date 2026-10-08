// Switch how the production agent opens a call.
//   --wait <s>  wait-for-hello (Oct 8): first_message blank, ElevenLabs waits up to <s> seconds (turn.initial_wait_time)
//               for the callee, then the first turn reaches our server, which speaks the disclosure itself and judges the
//               greeting for AMD. ONLY after the server with the wait-for-hello opening is deployed: an older server
//               would let the brain talk with no disclosure.
//   --greet     the old way (revert): the disclosure is the agent's first_message, spoken the moment the call is answered.
// usage: node elevenlabs/opening-mode.mjs --wait 3 | --greet [--dry]      (needs xi-api-key; OneCLI injects it)
const arg = k => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined }
const AGENT = 'agent_2601m4ej7de7fjbtgxag3c0n7yv9'
const DISCLOSURE = "Hi, this is Jasmine, Pete's AI assistant. This call is being recorded." // = server/src/voice/lines.ts
const WAIT = arg('--wait') != null ? Number(arg('--wait')) : null, GREET = process.argv.includes('--greet'), DRY = process.argv.includes('--dry')
if ((WAIT == null) === !GREET) throw new Error('pass exactly one of --wait <seconds> or --greet')
if (WAIT != null && !(WAIT >= 1 && WAIT <= 10)) throw new Error('--wait must be 1-10 seconds')
const H = { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? 'placeholder', 'content-type': 'application/json' }
const el = async (m, p, b) => {
  const r = await fetch('https://api.elevenlabs.io' + p, { method: m, headers: H, body: b && JSON.stringify(b) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${t.slice(0, 500)}`)
  return JSON.parse(t)
}
const show = a => JSON.stringify({ first_message: a.conversation_config.agent.first_message,
  initial_wait_time: a.conversation_config.turn.initial_wait_time, llm: a.conversation_config.agent.prompt.llm })

const before = await el('GET', `/v1/convai/agents/${AGENT}`)
console.log('before:', show(before))
if (before.conversation_config.agent.prompt.llm !== 'custom-llm' && WAIT != null)
  throw new Error('wait-for-hello needs llm=custom-llm: only our server speaks the disclosure in that mode')
const patch = { conversation_config: {
  agent: { first_message: WAIT != null ? '' : DISCLOSURE },
  turn: { initial_wait_time: WAIT } } }
if (DRY) { console.log('dry run, would PATCH', JSON.stringify(patch)); process.exit(0) }
await el('PATCH', `/v1/convai/agents/${AGENT}`, patch)
console.log('after: ', show(await el('GET', `/v1/convai/agents/${AGENT}`)))
console.log(WAIT != null ? 'revert: node elevenlabs/opening-mode.mjs --greet' : 'greet mode (disclosure at answer)')
