# ElevenLabs agent config

`jasmine-phone-agent.json` is the create body for the production **Jasmine Phone** agent
(`agent_2601m4ej7de7fjbtgxag3c0n7yv9`, created Oct 8 2026). It's kept here as the source of truth for the
prompt and settings; changes are applied with PATCH /v1/convai/agents/{id} and committed here.

- Built-in LLM (qwen35-397b-a17b) until Milestone D switches it to the custom-LLM endpoint.
- End-call tool OFF until the server-side hard stops (Milestone B) are built and tested.
- No post-call webhook until Milestone C.
- Client overrides are all off (callers can't change the prompt, first message, voice or max duration).
- Per-call context arrives as dynamic variables from place_call: call_id, purpose, brief, plan.

## Opening mode (`opening-mode.mjs`)

- `--greet` (what `jasmine-phone-agent.json` has): the disclosure is the first message, spoken the moment the call is
  answered.
- `--wait 3` (wait-for-hello, approved by Pete on Oct 8): blank first message, and `turn.initial_wait_time` = 3s. The
  callee's "hello", or 3s of silence, triggers the first turn. The server answers it with the disclosure only
  (`server/src/voice/lines.ts`), and the greeting feeds the AMD verdict: a short hello gives `human_greeting`, while a
  long greeting or voicemail wording gives `machine_greeting`, which ends the call as `voicemail`. Deploy the server
  first: an older server would let the brain talk without the disclosure.

## turn-eagerness.mjs

`node elevenlabs/turn-eagerness.mjs patient|normal|eager` sets `turn.turn_eagerness` on the production agent and
prints it before and after. Since Oct 8 it is **patient**: on "normal", ~0.9s pauses split one sentence into several
turns. Revert with `normal`. There is no millisecond silence setting in the API. `speculative_turn` is OFF (`--speculative off`, Oct 8): on, it re-sent the request ~every 150ms while the callee talked (call_ETdA_LdKkwZV). Revert with `--speculative on`.

## Backup LLM: off on both agents (Oct 9)

`conversation_config.agent.prompt.backup_llm_config.preference` = `disabled` on the production agent (Jasmine's OK,
Oct 9) and on the Pete agent. With the backup on ("default") and `cascade_timeout_seconds` 4, a reply from our
endpoint that hadn't started within 4s could be answered by ElevenLabs' own LLM. Now nothing else ever answers: if
the brain throws before saying anything, the server says `EXIT_LINE` once and hangs up (`end_reason` `brain_error`).
If the droplet is unreachable altogether, ElevenLabs has no one to ask; Twilio's TimeLimit and the watchdog end the call.
Revert: PATCH `{"conversation_config":{"agent":{"prompt":{"backup_llm_config":{"preference":"default"}}}}}`.

## Pete agent (`jasmine-phone-pete-agent.json`)

`agent_4501m4gc64c0em2t52mzpd37e22h` "Jasmine Phone — Pete", for every call to or from `PERSONAL_OK_NUMBERS`
(server env `ELEVENLABS_PETE_AGENT_ID`). Recording off, retention 0 days, transcript/PII and audio delete on, sentiment
analysis off, no evaluation or data collection. Zero-retention mode is allowed on the plan, but ElevenLabs rejects it
with a custom LLM (`custom_llm_not_allowed_in_zrm`), so the server DELETEs each Pete-agent conversation after the call
instead. The post-call summary/title can't be switched off in the API (`analysis_llm` has no "none"); it is generated,
then deleted along with the conversation, and the server never fetches it.
