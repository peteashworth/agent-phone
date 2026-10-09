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
- Note: before the phrase is verified, a private call is still public tier, so a public opt-out ("stop calling me")
  does put Pete on DNC. Clear it with the CLI: `contact:set +14358403707 do_not_call 0`.

## Not built yet
- Check-ins (step 6) and inbound (step 7).
