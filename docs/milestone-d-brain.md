# Milestone D: Jasmine as the phone brain (DRAFT for review, no code yet)

Pete's decision (Oct 8): the voice brain is the real Jasmine, not a fast model, and there's no Anthropic key. Each turn
goes from `/phone/llm/v1` to a dedicated **phone session** of Jasmine. It uses the same pattern as ha-voice: a host
channel adapter, then a separate session under Jasmine's agent group, then the reply comes back. This doc covers the
droplet side and the contract with the host adapter.

## 0. Known numbers this design has to live with

- ha-voice adapter today: **cold start ~60s**, **warm turn ~8s**, one query at a time (a second one gets 503), 60s
  timeout. A phone turn will likely be in the same range.
- The ElevenLabs (EL) side adds about 0.3s for the end-of-turn wait and 0.15-0.2s of network to the droplet. The model
  time is the whole problem.
- An 8s silence after every sentence is a poor call. Filler lines (§4) cover it, but the call will still feel slow.
  **Step D0, before building:** measure the real warm turn time through the host adapter (the parked
  `adapter-latency.mjs`). If it's well over ~6s, Pete should know before we build this out.

## 1. Transport: the host long-polls the droplet (recommended)

The droplet is public and the host is tailnet-only. The droplet can't call the host unless it joins the tailnet, so the
host dials out instead:

| Call (host → droplet) | Purpose |
|---|---|
| `GET /phone/brain/next?wait=25` | Long-poll. Returns a job as soon as one exists (200), or 204 after 25s. The host loops forever. |
| `POST /phone/brain/jobs/:id/result` | The host's answer to a job. 200 = accepted; 409 = job cancelled or expired (drop the answer). |

- **Auth:** a new key scope `brain` (`node src/cli.ts key:create host --scope brain`, with the `host` agent added
  first). It lives only on the host, can't place calls and can't read the call log. Bearer over HTTPS (DNS-only, so it
  goes straight to the droplet).
- **Liveness:** each poll marks the brain as online. If there's been no poll for 30s, `place_call` refuses
  with `brain_offline` instead of dialing into silence.
- **Latency:** a held long-poll adds no measurable time. The job goes out on the already-open request.
- **Alternative (B):** the droplet joins the tailnet and POSTs each turn to the host adapter, waiting for the reply
  (exactly like HA → ollama-shim). It's simpler host code, but it puts Tailscale on a public box and needs an open port
  on the host. The job payloads below are the same either way.

## 2. Job types and payloads (droplet → host)

Every job has `{ job_id, type, call_id, deadline_at }`. The host must answer before `deadline_at` or the answer is
ignored.

**`call.start`**: sent at `place_call` time, *before* dialing (§3).
```json
{ "type": "call.start", "call_id": "call_…", "deadline_at": "…",
  "callee": { "name": "Pete", "relationship": "trusted" },
  "from_label": "Pete Mobile", "purpose": "…", "brief": "…", "plan": "…",
  "disclosure": "Hi, this is Jasmine, Pete's AI assistant. This call is being recorded.",
  "rules": { "max_seconds": 300, "tier": "public", "style": "spoken prose, 1-3 sentences, no markdown/emoji/URLs" } }
```
Expected result: `{ "ready": true }`.

**`turn`**: one per thing the person says.
```json
{ "type": "turn", "call_id": "call_…", "seq": 3, "deadline_at": "…",
  "tier": "public",
  "user_text": "Sure, Tuesday works.",
  "interrupted": { "spoken": "I can do Tuesday or Wed—" },
  "code_phrase": null }
```
- `user_text` holds only what's new since the last delivered turn. The session already has its own history; we don't
  replay EL's full message list.
- `interrupted` is set when the person cut off the last reply. `spoken` is what EL actually played, so the session knows
  what the person did and didn't hear.
- `code_phrase` is `null`, `"verified"` or `"incorrect"` (§7). The phrase itself is never sent.

Expected result:
```json
{ "say": "Tuesday at ten works. I'll put it in Pete's calendar.", "end_call": false, "ask_code": false,
  "note_for_jasmine": null }
```
- `end_call: true` means we speak `say`, then hang up (`end_reason=brain_end`).
- `ask_code: true` means Jasmine is asking for the code phrase, so the next user turn is checked as an attempt (§7).
- `note_for_jasmine` is stored on the call (for example "they want a callback Friday") and shown in `get_call`.

**`call.end`**: sent once the post-call record is finalized.
```json
{ "type": "call.end", "call_id": "call_…", "end_reason": "completed", "duration_s": 74,
  "summary": "…", "transcript": [ {"role":"agent","text":"…"}, … ], "notes": ["…"] }
```
The code phrase is redacted from the transcript. The host closes the phone session and posts the completion notice to
Jasmine's main session (this is the "call-end notice pushed to Jasmine" item; `get_call` remains the backup).

## 3. Pre-warming at dial time

1. `place_call` passes all safety checks (caps, hours, confirm-before-dial, DNC, Pete-only allowlist), then sets the
   status to `warming` and queues `call.start`. MCP returns immediately: `{ status: "warming" }`.
2. The host wakes or creates the phone session, loads the brief, and answers `{ ready: true }`.
3. Only then do we register with ElevenLabs and dial.
4. If there's no `ready` within `WARM_TIMEOUT_S` (default 90s, which covers the ~60s cold start), the call ends as
   `failed: brain_not_ready` and **is never dialed**. Nobody gets called by a brain that isn't there.

The session stays warm for the whole call because turns keep arriving. The 5-minute call limit is far below any idle
timeout.

## 4. Filler lines for slow turns

The droplet streams these on the same SSE response that later carries the real reply, so EL speaks the filler, then
continues with the answer as soon as it arrives:

- At `FILLER_AFTER_MS` (1500): one short line from a fixed, server-owned list ("Mm, one moment.", "Let me check
  that."). It contains nothing personal and is never model-written. Lines rotate and never repeat back-to-back.
- At `FILLER2_AFTER_MS` (9000): a second line ("Still with you, just a second.").
- No third filler. The next thing is either the answer or the timeout exit (§5).
- If the reply arrives before 1.5s, no filler is spoken.

EL also has its own "soft timeout" filler setting (VERIFY that it exists on this plan). We leave it off: ours is
logged, tested and consistent.

## 5. Per-turn timeout and graceful exit

- `TURN_TIMEOUT_S` (default 20s). When it's reached, we speak the fixed exit line "I'm sorry, I'm having trouble
  on my end. Pete will follow up with you. Goodbye." and hang up (`end_reason=brain_timeout`). The job is cancelled,
  so a late answer gets 409.
- If the host returns an error or 503 (busy), we retry once inside the same deadline. After that, the same exit.
- If the brain goes offline mid-call (no poll for 30s), the next turn takes the exit immediately.
- **Barge-in:** if the person speaks while a turn is pending, EL aborts our SSE request. We cancel that job and send the
  new words as the next `turn`, with `interrupted` filled in. The host may still be working on the old job; its answer
  gets 409 and is dropped. The session must accept that some answers are never spoken.

## 6. Order of checks per turn (all on the droplet, before Jasmine sees anything)

1. Shared-secret auth from EL. Identify the call (call_id tag, otherwise the single live call).
2. **Hard stops** on the latest user text. A hit means the fixed close line, a server hangup, and (for opt-out) the
   do-not-call list. **The brain is not consulted.** No change from today.
3. **AMD gate:** wait for the "human" verdict (6s maximum). A machine gets a hangup or the voicemail line. **The brain
   is not consulted**, and the brief is never sent for a voicemail turn.
4. Calls already marked ending keep repeating the close line.
5. **Code-phrase check** on the user text (§7). The phrase is replaced before anything leaves the droplet.
6. Send the `turn` job with the current `tier`, then stream fillers and the reply.
7. **Output filter** on every sentence of `say`, as today (email, card number, SSN, street address,
   `PRIVATE_TERMS`). In the `personal` tier, only `PRIVATE_TERMS` is relaxed (§7). Proposed addition: an
   always-on `INTIMATE_TERMS` list that is blocked in **every** tier, as a backstop (see §9).
8. Strip markdown, emoji and URLs before TTS. Bracket audio tags like `[warmly]` pass through (Pete confirmed they
   aren't read aloud).

Hard stops, AMD and the filter stay deterministic server code. Jasmine can't skip them, and they don't depend on the
host.

## 7. Privacy rule: personal content only after the code phrase

- **Tiers:** every call starts in `public`. That means the brief, plan and general conversation only; nothing about
  Pete's life, calendar, health, money or relationships beyond what the brief itself says. `personal` unlocks only
  through the code phrase. **Intimate content is not in any tier on the phone.**
- **Where the phrase lives:** `CODE_PHRASE` in `/etc/agent-phone.env` (root 0600). Pete enters it himself over SSH.
  It is never in the repo, the EL prompt, any job payload, or chat. If it's unset, `personal` can never unlock.
- **Who can unlock:** only callees in `PERSONAL_OK_NUMBERS` (default: Pete's number). For anyone else, saying the
  phrase does nothing (it's logged as `code_phrase_wrong_callee`).
- **How it's checked:** the transcript is normalized (lowercase, punctuation and filler words removed, numbers as
  words), then the phrase's words must appear in order. Exact matching would fail on speech-to-text noise; this is a
  loose match on purpose, so the phrase should be 4+ uncommon words.
- **Attempts:** when Jasmine returns `ask_code: true`, the next user turn counts as an attempt. A miss sends
  `code_phrase: "incorrect"`. After 3 misses, the call is locked to `public` for its remainder. A match on any turn
  (asked for or not) unlocks.
- **What Jasmine sees:** `code_phrase: "verified"` and `tier: "personal"`, never the words themselves. On that turn
  the phrase is removed from `user_text`.
- **Records:** the phrase is redacted from our stored transcript and the `call.end` payload. **Gap:** ElevenLabs
  still holds the raw speech-to-text for 30 days. Closing it needs EL's history-redaction setting on the agent, which
  is a production agent change, so I'd ask first.
- Unlocks and failed attempts go in the audit log (with the attempt count, never the text).

## 8. The brief: brief and plan only

- The droplet sends `purpose`, `brief`, `plan`, the callee's display name and trust level, the from label, the
  disclosure and the rules in `call.start`. That's all it has. It has no access to Jasmine's memory files and never
  will.
- What the **phone session itself** loads is the host's choice (§9). The design assumes it gets a phone-specific
  instructions file, not Jasmine's full working memory.
- The brief and plan are still never returned to read-scope keys (dashboard), as in Milestone C.

## 9. What Pete's host side must build (plain terms)

1. **A small always-running service on the host** (like ollama-shim) that keeps one request open to
   `https://jasmine.ashworthhub.com/phone/brain/next` with the brain key, and loops.
2. **On `call.start`:** start (or wake) a session named something like "phone" under Jasmine's agent group, give it the
   brief, and reply `{ready:true}` once it can answer.
3. **On `turn`:** pass `user_text` (plus the interrupted/code-phrase/tier notes) into that session, wait for its reply,
   and POST it back as `{say, end_call, ask_code, note_for_jasmine}`. One turn at a time. If the session is busy, answer
   with an error and we retry once.
4. **On `call.end`:** give the session the summary, close it, and drop a short "call finished" note into Jasmine's main
   session.
5. **The same lessons as ha-voice:** go through NanoClaw's normal session delivery. No direct `inbound.db`/
   `outbound.db` writes and no WAL changes.
6. **The phone session's instructions** (host decision, Jasmine/Pete to review). The phone session must **not** inherit
   anything intimate. If, like ha-voice, it loads Jasmine's shared `CLAUDE.local.md`, then the intimate and personal
   guidance in there is in its context, and only instructions keep it off the phone. My strong recommendation: give
   the phone session its own short persona file (voice, manners, tiers, the reply format above) and no shared memory
   files. The server's `INTIMATE_TERMS` filter is a backstop, not a guarantee.
7. Keep the brain key on the host only.

## 10. Server config (new)

`BRAIN=jasmine` (alongside `canned`/`openai`), `WARM_TIMEOUT_S=90`, `FILLER_AFTER_MS=1500`, `FILLER2_AFTER_MS=9000`,
`TURN_TIMEOUT_S=20`, `CODE_PHRASE` (secret, optional), `CODE_PHRASE_MAX_ATTEMPTS=3`,
`PERSONAL_OK_NUMBERS=+14358403707`, `INTIMATE_TERMS` (list, optional).

## 11. Build order once approved

D0: latency measurement through the adapter (no build). D1: brain jobs, the long-poll, brain keys, `BRAIN=jasmine` with
a fake host in tests. D2: pre-warm in `place_call`, fillers, timeout exit, barge-in. D3: code phrase, tiers,
redaction. D4: live test, Pete only, with Pete's host adapter.
