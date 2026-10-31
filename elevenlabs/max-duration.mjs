// Sets conversation.max_duration_seconds on BOTH phone agents (ElevenLabs ends the call there, whatever our server allows).
// Keep it >= the server's MAX_CALL_SECONDS ceiling (server/src/config.ts + settings.ts), or ElevenLabs is the real limit.
// The agent schema has no maximum (default 600); the API rejects bad values. Oct 30: 300 -> 1200 (Pete approved).
// usage: node elevenlabs/max-duration.mjs <seconds> [--dry]   (revert: 300; needs xi-api-key, OneCLI injects it)
const AGENTS = ['agent_2601m4ej7de7fjbtgxag3c0n7yv9', 'agent_4501m4gc64c0em2t52mzpd37e22h'] // Jasmine Phone, Jasmine Phone — Pete
const SECS = Number(process.argv[2]), DRY = process.argv.includes('--dry')
if (!Number.isInteger(SECS) || SECS < 60 || SECS > 3600) throw new Error('usage: max-duration.mjs <seconds 60-3600> [--dry]')
const H = { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? 'placeholder', 'content-type': 'application/json' }
const el = async (m, p, b) => {
  const r = await fetch('https://api.elevenlabs.io' + p, { method: m, headers: H, body: b && JSON.stringify(b) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${t.slice(0, 500)}`)
  return JSON.parse(t)
}
const show = a => `${a.name}: max_duration_seconds ${a.conversation_config.conversation?.max_duration_seconds}`
for (const id of AGENTS) {
  console.log('before:', show(await el('GET', `/v1/convai/agents/${id}`)))
  if (DRY) { console.log('dry run, would PATCH', SECS); continue }
  await el('PATCH', `/v1/convai/agents/${id}`, { conversation_config: { conversation: { max_duration_seconds: SECS } } })
  console.log('after: ', show(await el('GET', `/v1/convai/agents/${id}`)))
}
