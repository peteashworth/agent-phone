#!/usr/bin/env node
// Stand-in for Pete's host adapter, for testing BRAIN=jasmine end to end without the real phone session.
// It long-polls the droplet like the real adapter: call.start -> {ready:true}, each turn -> the next scripted line,
// call.end -> logged only. No dependencies.
//
//   PHONE_URL=https://jasmine.ashworthhub.com/phone PHONE_BRAIN_KEY=aph_b_... node scripts/stub-brain-host.mjs
//   Optional: DELAY_MS=3000 (pretend thinking time per turn; >FILLER_AFTER_MS to hear a filler),
//             NOT_READY=1 (answer call.start with ready:false, to test brain_not_ready)
//
// The key is a brain-scope key: node src/cli.ts key:create <agent> --scope brain. Never commit or paste it.

const BASE = (process.env.PHONE_URL ?? 'http://127.0.0.1:3600/phone').replace(/\/$/, '')
const KEY = process.env.PHONE_BRAIN_KEY
const DELAY = Number(process.env.DELAY_MS ?? 0)
if (!KEY) { console.error('PHONE_BRAIN_KEY is required (a brain-scope key)'); process.exit(1) }

const SCRIPT = [
  "Hi Pete, it's the stub brain. The line is working.",
  'Got it. Say anything and I will answer with the next test line.',
  'This is the last scripted line. Goodbye. [[end_call]] [[note: stub brain test call finished]]',
]
const H = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const lineFor = new Map() // call_id -> next script index

async function answer(job, body) {
  const r = await fetch(`${BASE}/brain/jobs/${job.job_id}/result`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  console.log(new Date().toISOString(), job.type, job.call_id, job.seq ?? '', '->', r.status, r.status === 409 ? '(stale, dropped)' : '')
}

for (;;) {
  let r
  try { r = await fetch(`${BASE}/brain/next?wait=25`, { headers: H }) } catch (e) { console.error('poll failed:', e.message); await sleep(2000); continue }
  if (r.status === 204) continue
  if (r.status !== 200) { console.error('poll:', r.status, await r.text()); await sleep(5000); continue }
  const job = await r.json()
  if (job.type === 'call.end') { console.log('call.end', job.call_id, job.end_reason, job.duration_s, 'notes:', job.notes); lineFor.delete(job.call_id); continue }
  if (job.type === 'call.start') { await answer(job, process.env.NOT_READY ? { ready: false } : { ready: true }); continue }
  // turn: log only the metadata, never user_text (it can be personal)
  console.log('turn', job.call_id, 'seq', job.seq, 'tier', job.tier, 'code_phrase', job.code_phrase, 'interrupted', !!job.interrupted)
  const i = lineFor.get(job.call_id) ?? 0
  lineFor.set(job.call_id, i + 1)
  if (DELAY) await sleep(DELAY)
  void answer(job, { say: SCRIPT[Math.min(i, SCRIPT.length - 1)] })
}
