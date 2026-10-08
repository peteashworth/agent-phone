# ElevenLabs agent config

`jasmine-phone-agent.json` is the create body for the production **Jasmine Phone** agent
(`agent_2601m4ej7de7fjbtgxag3c0n7yv9`, created Oct 8 2026). It's kept here as the source of truth for the
prompt and settings; changes are applied with PATCH /v1/convai/agents/{id} and committed here.

- Built-in LLM (qwen35-397b-a17b) until Milestone D switches it to the custom-LLM endpoint.
- End-call tool OFF until the server-side hard stops (Milestone B) are built and tested.
- No post-call webhook until Milestone C.
- Client overrides are all off (callers can't change the prompt, first message, voice or max duration).
- Per-call context arrives as dynamic variables from place_call: call_id, purpose, brief, plan.
