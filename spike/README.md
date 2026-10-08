# S0 spike: custom-LLM stub

A minimal OpenAI-compatible SSE endpoint used as the ElevenLabs Agents "Custom LLM" to time the ElevenLabs ↔ droplet hop.
If `ANTHROPIC_API_KEY` is unset, it streams three scripted replies and uses no model.

## Run (Node 22, no dependencies)

```sh
CUSTOM_LLM_SECRET=<random string> PORT=3000 node spike/custom-llm-stub.mjs
```

- Put HTTPS in front so `https://jasmine.ashworthhub.com/phone/v1` reaches port 3000. The reverse proxy may strip `/phone` or keep it; either works.
- It accepts `POST …/v1` and `POST …/chat/completions` with `Authorization: Bearer <CUSTOM_LLM_SECRET>`. Anything else returns 404.
- It logs one JSON line per request (method + path), plus timing per turn (`firstTokenMs`, `totalMs`).
- Give the secret to Jasmine/Carpet out of band. Never commit it.
