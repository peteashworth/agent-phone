# agent-phone — repo skeleton plan (DRAFT, not created yet)

Repo: github.com/peteashworth/agent-phone · Host: phone.ashworthhub.com
Node 22 + TypeScript, ESM, pnpm workspace with 2 packages (server, web). Single deployable image.

```
agent-phone/
├── server/
│   ├── src/
│   │   ├── index.ts              # Fastify bootstrap, plugin registration
│   │   ├── config.ts             # env schema (zod), fails fast on missing vars
│   │   ├── db/
│   │   │   ├── pool.ts           # pg Pool
│   │   │   └── migrations/       # 001_init.sql, 002_fts.sql … (plain SQL, run on boot)
│   │   ├── auth/
│   │   │   ├── agentKey.ts       # Bearer → sha256 lookup in agent_keys (constant-time compare)
│   │   │   ├── admin.ts          # argon2id password + otplib TOTP, session cookie
│   │   │   └── audit.ts          # audit(actor, action, target, meta) helper
│   │   ├── rules/
│   │   │   ├── engine.ts         # preflight(callRequest) → {allow, reasons[], needsConfirm}
│   │   │   ├── quietHours.ts     # libphonenumber-js → tz → local hour check
│   │   │   ├── spend.ts          # ledger: estimate + reconcile; day/month/per-dest caps
│   │   │   ├── confirm.ts        # 30-min single-use confirm tokens
│   │   │   └── lookup.ts         # Twilio Lookup v2 line_type_intelligence (cached)
│   │   ├── mcp/
│   │   │   └── server.ts         # @modelcontextprotocol/sdk Streamable HTTP at /mcp
│   │   │                         # tools: place_call, confirm_call, get_call, end_call, list_calls
│   │   ├── jasmine/
│   │   │   └── adapter.ts        # client for host phone adapter: plan(), ask(), notifyEnded()
│   │   ├── voice/
│   │   │   ├── driver.ts         # interface VoiceDriver { dial, hangup } (swap A/B/fallback)
│   │   │   ├── elevenlabs.ts     # option B driver (native Twilio outbound OR register-call bridge)
│   │   │   ├── customLlm.ts      # POST /llm/v1/chat/completions — OpenAI-compatible SSE front door
│   │   │   ├── fastModel.ts      # streaming fast model (Sonnet 5.5) w/ persona + call plan
│   │   │   ├── filter.ts         # sentence-buffered output filter (email/address/card/SSN)
│   │   │   ├── hardStops.ts      # caller-turn detectors → end_call
│   │   │   └── watchdog.ts       # per-call timer: max minutes, spend cap, kill switch
│   │   ├── webhooks/
│   │   │   ├── twilio.ts         # status callbacks (signature verified)
│   │   │   └── elevenlabs.ts     # post-call transcript/audio (HMAC verified)
│   │   ├── jobs/
│   │   │   └── purgeAudio.ts     # daily: delete audio > 90 days, keep transcripts
│   │   └── admin/                # JSON API for the web UI (session-auth only)
│   └── test/                     # vitest — rules engine, filter, hard stops = 100% branch target
├── web/                          # Vite + React + Tailwind admin UI (dashboard amber/dark styling)
│   └── src/pages/                # Login, Dashboard, Conversations, Rules, Agents, Numbers, Audit
├── spike/                        # S0 scripts (kept for re-running latency checks)
├── deploy/
│   ├── docker-compose.yml        # app + postgres:16 + caddy
│   ├── Caddyfile                 # phone.ashworthhub.com → app:3000
│   └── backup.sh                 # nightly pg_dump, 14-day rotation
├── Dockerfile
└── README.md                     # setup, env vars, OneCLI keys, runbook
```

## Tables (001_init.sql)
agents, agent_keys(hash, agent_id, created_at, revoked_at), contacts(e164, name, trusted, per_dest_cap_cents),
rules(singleton JSONB global + per-agent JSONB, versioned), calls(id, agent_id, to_e164, brief, plan, status,
started_at, ended_at, end_reason, est_cents, actual_cents, el_conversation_id, twilio_sid),
call_turns(call_id, seq, role, text, t_offset_ms, filtered bool), confirm_tokens, spend_ledger,
audio_files(call_id, path, bytes, purge_after), audit_log(ts, actor, action, target, meta JSONB),
admin_users(password_hash, totp_secret_enc).
002_fts.sql: calls.search tsvector (generated from turns via trigger) + GIN index.

## Call flow (hybrid)
place_call(to, purpose, brief) → preflight rules → (needsConfirm? return token) → adapter.plan(brief) ∥ Lookup
→ dial → ElevenLabs agent (Jasmine voice, fixed disclosure first message, see docs/disclosure.md) → each turn hits /llm (secret check)
→ hardStops(caller turn) → fastModel(persona+plan, tools: ask_jasmine, end_call) → filter → SSE back
→ watchdog runs in parallel → webhook post-call → store audio+turns → reconcile spend → adapter.notifyEnded().
ask_jasmine: model speaks a hold line, server calls adapter.ask() with 20s timeout, result injected as a tool result.

## Env / secrets (all via OneCLI where possible)
TWILIO_ACCOUNT_SID/API_KEY (new standalone account), ELEVENLABS_API_KEY, ANTHROPIC_API_KEY (fast model),
CUSTOM_LLM_SECRET (shared w/ ElevenLabs), JASMINE_ADAPTER_URL + token (tailnet), DATABASE_URL, SESSION_SECRET.
