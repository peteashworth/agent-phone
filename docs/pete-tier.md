# Pete-only tier (approved Oct 9, 2026)

Spec: Jasmine-nanoclaw/projects/phone-pete-tier-spec.md. This file records what is built.

## Pete agent (private calls)
- Calls to PERSONAL_OK_NUMBERS use the ElevenLabs agent "Jasmine Phone — Pete" (`ELEVENLABS_PETE_AGENT_ID`), when set.
  Settings: recording off, retention 0 days, delete transcript/audio on, backup LLM off, sentiment off. The post-call
  analysis model can't be disabled, so a summary is generated and then deleted with the conversation.
  Snapshot: elevenlabs/jasmine-phone-pete-agent.json.
- `calls.private = 1` and `el_agent_id` are set at place_call. Only private calls can unlock the personal tier.
  `brief_personal` is refused unless the Pete agent is configured.
- Opener: "Hey Pete, it's Jasmine." No recording notice, no notice re-speak, no after-disclosure objection rule.
- call.start to the host carries `private: true`.

## After the call
- The post-call sweep keeps credits and duration only. It never pulls the transcript, summary or audio, and then it
  DELETEs the ElevenLabs conversation (a 404 counts as deleted; failures retry every sweep; events `el_deleted` /
  `el_delete_error`).
- Scrub (after `PERSONAL_RETENTION_HOURS`, default 0, held while a call.end job is still pending): brain_jobs payload
  `{}` and result/error NULL, call_turns `said`/`redact_hash` NULL, and calls purpose `(personal)`, brief `''`, with
  plan, notes, brief_personal, transcript, summary and title NULL. Timings and outcomes stay. Event `scrubbed`.
- The read API and dashboard show metadata only for private calls (purpose, summary, transcript and notes are
  withheld, even before the scrub), plus flags `private`, `el_deleted` and `scrubbed`.
- Logs: request logs carry no bodies; events carry no spoken text (notice_repeated never fires on private calls).

## Code phrase
- Loose match on every turn; the match is cut out of the text and never stored. Near-misses count silently (max
  `CODE_PHRASE_MAX_ATTEMPTS`), and nothing ever asks for or hints at the phrase.

## Personal tier
- Output filter: INTIMATE terms off; card/SSN/secrets still blocked.
- Hard stops: no ai_objection, no "off the record"; opt-out ends the call without DNC. A real recording objection
  still stops.
- Opt-out on Pete's number (any tier, Oct 9): ends the call with "Okay, I'll let you go. Bye." and never sets DNC
  (audit `dnc_skipped: pete`). Other numbers still go on DNC.

## Check-ins (step 6)
- `place_call` with `checkin: true`. Refused (`checkin_not_allowed`) unless the number is in PERSONAL_OK_NUMBERS and
  the Pete agent is configured, so check-ins are always private calls. `calls.checkin = 1` (migration 008).
- Window `CHECKIN_HOURS_START`–`END` (9–21) in `CHECKIN_TZ` (America/Denver). It replaces the general calling hours
  for check-ins. Caps, do-not-call, one live call and the confirm rules still apply.
- Max `CHECKIN_MAX_PER_DAY` (2) per local day and `CHECKIN_MIN_GAP_H` (4h) between check-ins. Only dialed calls count
  (not dry runs or refusals), but a missed or declined check-in does count.
- None within `CHECKIN_QUIET_H` (2h) of any other dialed call to him (from its end, or its start if still live).
- One ring of `CHECKIN_RING_S` (25s, Twilio Timeout), never redials, and on voicemail hangs up with no message
  whatever VOICEMAIL_ACTION says.
- Pause: `CHECKINS_PAUSED` (dashboard Calls → Limits, `node src/cli.ts checkins:pause|resume`, or env). Refusal codes:
  `checkins_paused`, `outside_checkin_hours`, `checkin_cap`, `checkin_too_soon`, `checkin_quiet`.
- call.start to the host carries `checkin: true`.

## Inbound (step 7)
- Twilio Voice URL on our number → `/phone/twilio/voice` → `src/inbound.ts`. The number check is on the caller
  (`From`): PERSONAL_OK_NUMBERS and contact `inbound_allowed`.
- Everyone else hears NO_INCOMING_LINE ("This line doesn't take incoming calls. Goodbye.") from Twilio `<Say>`, or a
  `<Reject>` with `INBOUND_OTHERS=reject`. No name, nothing about a phrase, never reaches ElevenLabs or the brain.
  Audit `inbound.rejected`.
- Pete, with `INBOUND_ENABLED=false` or no Pete agent: the same NO_INCOMING_LINE. Pete while another call is live,
  over the spend cap or with the phone session offline: "Hi Pete. Jasmine can't pick up right now…". Audit
  `inbound.turned_away` with the code.
- Pete, otherwise: a calls row with `direction = 'inbound'` (migration 009; `to_e164` = the caller, `from_e164` =
  our number), `private = 1`, brain jasmine, Pete agent, `agent_id 'inbound'`, purpose "Pete called in". call.start
  goes to the host (`direction: 'inbound'`) while the server registers the call with ElevenLabs (`direction: inbound`);
  Pete hears ringing for up to `INBOUND_WARM_WAIT_S` (8s) and then it answers whether or not the session said ready.
  From there it is the same as an outbound Pete call: PETE_OPENER, code phrase, tiers, filter, hard stops, delete +
  scrub after the call.
- Caller ID can be spoofed. A spoofed call gets the Pete opener and the public tier only; the personal tier still needs
  the phrase. Twilio's STIR/SHAKEN result is kept on the `inbound` event (`stir_verstat`).
- Length: Twilio has no TimeLimit on inbound, so a server timer hangs up at MAX_CALL_SECONDS and the watchdog backs it
  up. The watchdog also polls Twilio for live inbound calls, since they have no `?call=` status callback. If the
  number's own status callback points at `/phone/twilio/status`, it is matched by CallSid.
