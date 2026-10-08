// Point the production agent at our custom-LLM endpoint (hard stops + output filter run there) and tag its prompt
// with the call id so the server knows which call each turn belongs to. The secret is referenced by NAME; its value
// never passes through here.
// usage: node elevenlabs/use-custom-llm.mjs --secret-name <name> [--dry]      (needs xi-api-key; OneCLI injects it)
const arg = k => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined }
const AGENT = 'agent_2601m4ej7de7fjbtgxag3c0n7yv9'
const URL_ = 'https://jasmine.ashworthhub.com/phone/llm/v1'
const TAG = 'Call reference (internal, never say it aloud): call_id: {{call_id}}'
const NAME = arg('--secret-name'), DRY = process.argv.includes('--dry')
if (!NAME) throw new Error('--secret-name required')
const H = { 'xi-api-key': process.env.ELEVENLABS_API_KEY ?? 'placeholder', 'content-type': 'application/json' }
const el = async (m, p, b) => {
  const r = await fetch('https://api.elevenlabs.io' + p, { method: m, headers: H, body: b && JSON.stringify(b) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${t.slice(0, 500)}`)
  return JSON.parse(t)
}

const sec = await el('GET', '/v1/convai/secrets')
const s = (sec.secrets || sec).find(x => x.name === NAME)
if (!s) throw new Error(`no workspace secret named ${NAME}`)
const before = (await el('GET', `/v1/convai/agents/${AGENT}`)).conversation_config.agent.prompt
console.log('before:', before.llm, JSON.stringify(before.custom_llm ?? null), 'tagged:', before.prompt.includes('{{call_id}}'))
const prompt = before.prompt.includes('{{call_id}}') ? before.prompt : `${TAG}\n\n${before.prompt}`
const patch = { conversation_config: { agent: { prompt: {
  prompt, llm: 'custom-llm', custom_llm: { url: URL_, model_id: 'canned', api_key: { secret_id: s.secret_id } } } } } }
if (DRY) { console.log('dry run, would PATCH llm/custom_llm/prompt'); process.exit(0) }
await el('PATCH', `/v1/convai/agents/${AGENT}`, patch)
const after = (await el('GET', `/v1/convai/agents/${AGENT}`)).conversation_config.agent.prompt
console.log('after:', after.llm, after.custom_llm?.url, after.custom_llm?.model_id, 'secret ok:', after.custom_llm?.api_key?.secret_id === s.secret_id,
  'tagged:', after.prompt.startsWith(TAG))
console.log('revert: llm=qwen35-397b-a17b')
