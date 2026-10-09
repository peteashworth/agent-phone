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
