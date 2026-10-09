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
  "last_user_is_question": false,
  "code_phrase": null }
```
- `user_text` holds only what's new since the last delivered turn. The session already has its own history; we don't
  replay EL's full message list.
- `interrupted` is set when the person cut off the last reply. `spoken` is what EL actually played, so the session knows
  what the person did and didn't hear.
- `last_user_is_question` (Oct 8): `user_text` ends in "?" or its last sentence starts like a question (STT often drops the
  "?"). It leans towards yes. The session should answer the question, not end the call.
- `code_phrase` is `null`, `"verified"` or `"incorrect"` (§7). The phrase itself is never sent.
- `continues` (only sometimes): the `seq` of an earlier turn this one replaces (continuation, §5). Its `user_text`
  already holds the earlier words too, and the answer to the earlier turn was never spoken.

Expected result:
```json
{ "say": "Tuesday at ten works. I'll put it in Pete's calendar.", "end_call": false, "ask_code": false,
  "note_for_jasmine": null }
```
- `end_call: true` means we speak `say`, then hang up (`end_reason=brain_end`). **Exception (Oct 8, Bob call):** if
  `last_user_is_question` was true and the callee's words aren't a goodbye ("Bye?", "Can I go now?"), the server
  refuses it. `say` is still spoken, the call stays open, the turn outcome is `end_call_refused`, and a
  `end_call_refused` event is logged.
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

- At `FILLER_AFTER_MS` (2500 since Oct 8; was 1500): one short line, picked at random from a fixed, server-owned list of
  five ("One moment.", "Let me check.", ...), never the one the call used last. It contains nothing personal and is never model-written.
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
- **Continuation** (Oct 8): ElevenLabs can end a turn on a short pause and then send the rest of the sentence as a new
  request, dropping the first. If the previous turn spoke nothing but a filler and was dropped less than
  `CONTINUATION_MS` (1.5s) earlier, or is still open, the new request carries it on. The old job is cancelled, the
  new one gets the whole sentence in `user_text` plus `continues: <old seq>` (if the host had picked the old one).
  It is logged as `continued`, not `barge_in`, and has no `interrupted`. Once real answer text has been spoken it
  is a barge-in as before. `user_text` is never empty: if EL rewrote the last user message in place, it is sent again.
- **Settle** (Oct 8): ElevenLabs re-sends the request every ~150ms while the callee is still talking (seen with
  speculative_turn on and off). A jasmine turn waits `SETTLE_MS` (250) for a newer request on the same call before it
  goes to the host; a superseded request is answered empty and leaves no turn row. Settle time is not in the turn
  timings (the row starts after it). `SETTLE_MS=0` turns it off.
  Adaptive (Oct 8, after the Carolee call: pieces ~420ms apart each got through 250ms): a request that arrives within
  `SETTLE_BURST_WINDOW_MS` (1500) of the call's previous one waits `SETTLE_BURST_MS` (600) instead. A lone first
  request still waits 250ms. Logged as `burst settle` with the gap.

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

## 12. Additions from the persona draft (Oct 8)

- **Reply format:** the session writes plain spoken text plus `[[end_call]]`, `[[ask_code]]`, `[[note: …]]` tag lines
  (`phone-persona.md`). The host converts that into the JSON result. That's easier for the model than strict JSON.
- **Personal part of the brief:** `place_call` gets an optional `brief_personal`. The droplet withholds it until the
  code phrase is verified, then sends it once with that turn. Personal details never reach the session on a call that
  stays public.
- **Separate agent group:** Jasmine recommends a separate phone agent group (not a session in her main group), so the
  phone session cannot load her `CLAUDE.local.md`. Pending Pete.

---

# Revision 2 (Oct 8, 3:54pm): hybrid brain

Pete chose the hybrid, with a separate phone agent group. The sections below **replace** §0, §3, §4, §6, §7 (partly),
§10 and §11 above. §1, §2, §5 and §9 still describe the escalation path to the true Jasmine, with the additions
noted below.

## R1. Two brains

- **Fast voice (default for every turn):** runs on the droplet. It calls the Anthropic Messages API directly, streaming,
  with prompt caching. Its prompt contains the phone persona, this call's brief/plan, the phone facts this call is
  allowed (R4), and the transcript so far.
  - Model: `FAST_MODEL`, default `claude-haiku-4-5-20251001` (fastest). `claude-sonnet-5-5` is the alternative if
    Haiku's judgement is too weak; D0 measures both.
  - Key: `ANTHROPIC_API_KEY` in `/etc/agent-phone.env`, which Pete enters himself. Its token cost is added to the
    call's `cost_usd` and the daily/monthly caps.
- **True Jasmine (escalations only):** the phone agent group's session behind the host adapter. It uses the
  long-poll job contract from §1-§2.

## R2. When a turn escalates

**Proposed default: server rules decide first, then the fast model's tag. Either one escalates.**

1. **Server rules (deterministic; the model can't override them):**
   - **Code-phrase turns:** the turn where the code phrase is verified, plus any turn that asks for `brief_personal`
     content (the fast model never gets `brief_personal`).
   - **Jasmine's per-call keywords:** `escalate_on` is an optional list of words or phrases she sets in `place_call`
     (for example `["deposit", "cancel"]`). A match in the caller's words escalates.
   - **Money:** a dollar amount or price word ("$", "dollars", "price", "quote", "fee", "deposit") in the caller's
     words. This is on by default. Jasmine can turn it off per call with `escalate_on_money: false` when the plan
     already sets a limit.
   - **Fast model failure:** an API error, a timeout (no first token in 4s), or an empty reply escalates instead of
     ending the call.
2. **Fast model tag:** the persona tells it to begin its reply with `[[escalate: <reason>]]` when one of these applies:
   - a question the brief and facts don't answer;
   - a decision or commitment the plan doesn't already allow;
   - a changed price, date or terms;
   - anything personal;
   - when it's unsure.

   The server already holds back the first sentence for the output filter, so a tag at the start is caught before
   anything is spoken. The tag's reason goes to the true Jasmine.
3. **If escalation is impossible** (host offline, or the true Jasmine times out): the server speaks a fixed line,
   "I'll need to check that with Pete. He'll follow up with you.", adds a note to the call, and **keeps the call
   going** on the fast voice. It doesn't hang up, since the rest of the call may be fine.

**What the true Jasmine gets** (an addition to the §2 `turn` job): `escalation: { reason, source: "rule"|"model" }`
and `transcript_since_last` (the fast voice's turns she hasn't seen yet), plus `tier` and the code-phrase note as
before.

**What comes back** (addition): what to say (spoken verbatim, after the filter), plus an optional
`[[guide: …]]`. A guide is a short instruction appended to the fast voice's prompt for the rest of the call (for
example "Pete accepts $180; you may confirm Tuesday 10am."). That way, one escalation can settle what the fast voice
can say next. After `[[guide]]`, the next turn goes back to the fast voice.

## R3. Latency by path

Measured numbers are marked; everything else is an estimate for D0 to confirm. "Heard gap" means the time from the
end of the caller's speech to the start of our audio.

| Path | Heard gap | Notes |
|---|---|---|
| Hard stop / voicemail (server-only) | **0.62-0.73s measured** (canned line, Oct 8 call) | No model involved. |
| Fast voice, Haiku 4.5 | est. **1.1-1.9s** | 0.25-0.35 end-of-turn wait (measured) + 0.15-0.2 network (measured) + 0.4-0.8 time to first token (est., with a cached prompt) + 0.2-0.5 first-sentence hold for the filter + 0.08 voice. |
| Fast voice, Sonnet 5.5 | est. 1.5-2.5s | Slower first token. |
| Escalation to true Jasmine | **~9-10s total**, with filler at ~1s | The fast model's tag shows up in ~0.5-0.8s, then the filler plays **immediately** (not at 1.5s), then ~8s for a warm turn (the ha-voice figure; D0 measures the phone group), then a second filler at 9s if needed. |
| Escalation, session cold | ~60s, so not usable | This is why the pre-warm stays (R5). |

## R4. Phone facts file

- **Location:** `/var/lib/agent-phone/facts.yaml` on the droplet (owner agent-phone, mode 0600). **It's never in the
  repo.** The repo gets `facts.example.yaml` with fake values only. Pete edits the file over SSH; a later MCP
  `set_fact` tool could let Jasmine maintain it. The server reloads it when the file changes.
- **Format:**

```yaml
version: 1
facts:
  - id: mach1_vin
    label: VIN of Pete's 2021 Mustang Mach 1
    value: "1FA6P8R0XM5000000"
    share: anyone        # anyone | code | never
    topics: [car, mach1, service, insurance]
  - id: pete_birthdate
    label: Pete's date of birth
    value: "1975-01-01"
    share: code
    topics: [identity, insurance, doctor]
  - id: pete_ssn
    label: Pete's social security number
    value: "000-00-0000"
    share: never         # never sent to any model; the value is blocked by the output filter
```

- **The three share rules:**
  - `anyone`: may be given to whoever is on the call, but only when they ask for it or the call needs it.
  - `code`: only after the code phrase is verified, so in practice only to Pete himself.
  - `never`: never in any prompt.
- **Picking facts per call:** `place_call` takes `facts: ["mach1_vin", …]` (ids or topics). Only the listed facts
  are considered, so the default is none. Then the share rules apply:
  - `anyone` facts go into the fast voice's prompt from the start.
  - `code` facts are added only on the turn after the code phrase is verified.
  - `never` facts are never sent.

  The true Jasmine gets the same permitted set as the fast voice on escalation turns.
- **The output filter:**
  - It **allows the exact value** of facts permitted on this call. Today's filter would otherwise block a VIN-like or
    address-like value.
  - It **always blocks** every `code` fact that isn't unlocked yet, plus every `never` fact, **across the whole file**
    (not just the facts picked for this call). That works like an automatic `PRIVATE_TERMS` list: a leak would need
    both the model and the filter to fail.
- **Audit:** every fact sent to a model is logged with its id (never the value).

## R5. Pre-warm (replaces §3 step 4)

The fast voice needs no warm-up. The true Jasmine still gets `call.start` before dialing. If she isn't ready in 90s:
- **Default (`require_escalation: true`):** the call fails as `brain_not_ready` and is never dialed.
- **With `require_escalation: false` in `place_call`:** the call dials anyway, and every escalation gets the fixed
  "Pete will follow up" line from R2.3.

## R6. Fillers (replaces §4)

- **Fast voice turns:** no filler. It answers in under 2s.
- **Escalated turns:** the first filler plays **as soon as the turn escalates**, about 0.5-1s in, from the fixed list.
  A second filler plays at 9s and a third never does. The 20s exit (§5) now becomes the R2.3 "Pete will follow up"
  line, and the call continues on the fast voice.

## R7. Order of checks per turn (replaces §6)

1. Auth and call identification.
2. Hard stops.
3. AMD gate.
4. Closing calls keep repeating their closing line.
5. Code-phrase check, with the phrase redacted.
6. **Server escalation rules (R2.1).**
7. Fast voice, unless a rule escalated.
8. If the fast voice emits `[[escalate]]` or fails, the escalation job goes out with an immediate filler.
9. Output filter on whatever will be spoken, with fact exemptions and blocks (R4), `PRIVATE_TERMS` and
   `INTIMATE_TERMS` (on every tier).
10. Strip markdown and tags.

Steps 1-6 and 9-10 are server code that neither brain can bypass.

## R8. Privacy additions (adds to §7)

- **What the fast voice never gets:** `brief_personal`, `code` facts before verification, `never` facts, Jasmine's
  memory, or anything from her main group.
- **After the code phrase:** the fast voice gets the call's `code` facts, so Pete can ask "what's my VIN" quickly.
  Open-ended personal requests still escalate (the persona tells it to; `brief_personal` questions escalate by rule).
- **Anthropic:** the fast voice's prompts and transcript go to Anthropic's API (standard API data handling). They
  contain the brief, permitted facts and the call text, nothing else.

## R9. Persona changes

- `phone-persona.md` gets a short "Fast voice" section: the `[[escalate: reason]]` rule, the list of escalation cases,
  and "never invent an answer; escalate instead".
- The phone agent group's instructions (the true Jasmine) are the same persona plus: you only see escalated turns;
  read `transcript_since_last`; settle the hard part, then hand back with `[[guide: …]]`.

## R10. New config (adds to §10)

- **Fast voice:** `BRAIN=hybrid`, `ANTHROPIC_API_KEY` (secret), `FAST_MODEL`, `FAST_FIRST_TOKEN_TIMEOUT_MS=4000`,
  `ESCALATE_ON_MONEY=true`.
- **Facts:** `FACTS_FILE=/var/lib/agent-phone/facts.yaml`.
- **`place_call` gains** `facts`, `escalate_on`, `escalate_on_money`, `require_escalation` and `brief_personal`.

## R11. Build order (replaces §11)

- **D0a, fast path latency.** Needs: Pete puts `ANTHROPIC_API_KEY` in the droplet env.
  - A script he runs on the droplet sends 20 timed requests each to Haiku 4.5 and Sonnet 5.5, with a realistic
    ~3k-token prompt, with and without prompt caching.
  - It reports time to first token and time to the first full sentence. No calls.
- **D0b, escalation latency.** Needs: Pete's host adapter and the phone agent group.
  - Measures the cold start, then 10 warm turns with phone-sized payloads, through the real long-poll.
  - Can run before D2 using a minimal job endpoint.
- **D1, fast voice.** Can be built now that the approach is chosen; it doesn't need the host.
  - The Anthropic streaming client, prompt assembly (persona + brief + facts + transcript) and the facts file
    loader.
  - Per-call fact selection, filter exemptions and blocks, and token cost in `cost_usd`.
  - Tested with fakes. Then text-only simulations, then one call to Pete.
- **D2, escalation.**
  - Brain jobs, the long-poll and the brain key.
  - Server rules, tag detection, the immediate filler, `[[guide]]`, and the "Pete will follow up" fallback.
  - The pre-warm (R5).
- **D3, code phrase.** Tiers, `brief_personal`, `code` facts after verification, redaction.
- **D4, live tests (calls to Pete only).**
  - A fast-only call.
  - A money-rule escalation.
  - A model-tag escalation.
  - A code-phrase unlock and a failed unlock.
  - Host offline (fallback line).
