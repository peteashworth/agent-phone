// S0-6: minimal OpenAI-compatible SSE endpoint for an ElevenLabs Custom LLM, to time real calls.
// Logs: request arrival → first token sent, per turn. Proxies to the fast model (Anthropic streaming).
// usage: CUSTOM_LLM_SECRET=... [HOST=127.0.0.1] PORT=3000 node custom-llm-stub.mjs   (needs a public HTTPS URL in front)
// No ANTHROPIC_API_KEY → canned mode: streams scripted replies, no model. Measures only the ElevenLabs ↔ droplet hop.
import http from 'node:http'
const SECRET = process.env.CUSTOM_LLM_SECRET, MODEL = process.env.MODEL || 'claude-sonnet-5-5'
const KEY = process.env.ANTHROPIC_API_KEY, CANNED = !KEY
if (!SECRET) { console.error('set CUSTOM_LLM_SECRET'); process.exit(1) }
const SCRIPT = [
  "Thanks. This is a quick test of Jasmine's custom phone line. Can you hear me clearly?",
  "Great. One more check: does my voice sound the same as last time?",
  "Perfect, that's everything I needed. I'll let Pete know the test worked. Goodbye!",
]

http.createServer(async (req, res) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), req: `${req.method} ${req.url}` }))
  if (req.method !== 'POST' || !/(\/chat\/completions|\/v1)\/?(\?.*)?$/.test(req.url)) { res.writeHead(404).end(); return }
  if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401).end(); return }
  const t0 = performance.now()
  let raw = ''; for await (const c of req) raw += c
  const body = JSON.parse(raw)
  const system = body.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
  const messages = body.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') }))
  if (!messages.length || messages[0].role !== 'user') messages.unshift({ role: 'user', content: '(call connected)' })

  if (CANNED) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const id = `chatcmpl-${Date.now()}`, send = o => res.write(`data: ${JSON.stringify(o)}\n\n`)
    const n = messages.filter(m => m.role === 'assistant').length, first = performance.now() - t0
    for (const w of SCRIPT[Math.min(n, SCRIPT.length - 1)].split(/(?<= )/))
      send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'canned',
        choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })
    send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    res.end('data: [DONE]\n\n')
    console.log(JSON.stringify({ at: new Date().toISOString(), mode: 'canned', turns: messages.length, firstTokenMs: Math.round(first), totalMs: Math.round(performance.now() - t0) }))
    return
  }

  const up = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 200, stream: true, system, messages }),
  })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const id = `chatcmpl-${Date.now()}`, send = o => res.write(`data: ${JSON.stringify(o)}\n\n`)
  let first = null, buf = ''; const dec = new TextDecoder()
  for await (const chunk of up.body) {
    buf += dec.decode(chunk, { stream: true }); let nl
    while ((nl = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const ev = JSON.parse(line.slice(5))
      if (ev.type === 'content_block_delta' && ev.delta?.text) {
        first ??= performance.now() - t0
        send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL,
          choices: [{ index: 0, delta: { content: ev.delta.text }, finish_reason: null }] })
      }
    }
  }
  send({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  res.end('data: [DONE]\n\n')
  console.log(JSON.stringify({ at: new Date().toISOString(), turns: messages.length, firstTokenMs: Math.round(first ?? -1), totalMs: Math.round(performance.now() - t0) }))
}).listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => console.error(`custom-llm stub listening on ${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000} (${CANNED ? 'canned' : MODEL})`))
