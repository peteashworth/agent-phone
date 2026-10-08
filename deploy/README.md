# Deploying agent-phone (droplet)

One-time setup (as root). Requires Node ≥ 22.18 at /usr/bin/node.

```bash
useradd --system --home /opt/agent-phone --shell /usr/sbin/nologin agent-phone
git clone <repo url> /opt/agent-phone        # private repo: deploy key or token
chown -R agent-phone:agent-phone /opt/agent-phone
install -o root -g root -m 600 /dev/null /etc/agent-phone.env    # fill in from server/.env.example
# Each KEY at most once: systemd uses the LAST line for a key, so a later blank "KEY=" wipes an earlier value.
install -d -o agent-phone -g agent-phone -m 750 /var/lib/agent-phone   # deploy.sh does this too
cp /opt/agent-phone/deploy/agent-phone.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable agent-phone
# nginx: add deploy/nginx-phone.conf inside the jasmine.ashworthhub.com server block, then:
nginx -t && systemctl reload nginx
/opt/agent-phone/deploy/deploy.sh             # installs deps, migrates, starts, checks health

# Seed + Jasmine's MCP key (printed ONCE; goes into Jasmine's MCP config, never into git or chat logs)
cd /opt/agent-phone/server
set -a; source /etc/agent-phone.env; set +a
export NODE_NO_WARNINGS=1                     # hides node:sqlite's ExperimentalWarning
sudo -u agent-phone --preserve-env node src/cli.ts seed
sudo -u agent-phone --preserve-env node src/cli.ts key:create jasmine
```

Admin CLI later (same three setup lines first, then any command; `node src/cli.ts help` lists them):

```bash
cd /opt/agent-phone/server
set -a; source /etc/agent-phone.env; set +a; export NODE_NO_WARNINGS=1
sudo -u agent-phone --preserve-env node src/cli.ts key:list
```

Updates are manual: `sudo /opt/agent-phone/deploy/deploy.sh`. The spike stub has its own clone at /opt/agent-phone-spike.

Check: `curl https://jasmine.ashworthhub.com/phone/health` → `{"ok":true,"dialing":false,...}`

MCP endpoint: `https://jasmine.ashworthhub.com/phone/mcp` (Streamable HTTP, `Authorization: Bearer <key>`).

Safety: `DIALING_ENABLED=false` makes every call a dry run. `ALLOWED_DESTINATIONS` limits who can be dialed.

## Milestone D: Jasmine as the phone brain (BRAIN=jasmine)

Pete's host adapter (host side, Pete's build) long-polls the droplet with a **brain-scope** key. It never touches
inbound.db/outbound.db; it hands each job to the separate phone session and posts the answer back.

```bash
# (three setup lines from above first)
sudo -u agent-phone --preserve-env node src/cli.ts key:create jasmine --scope brain   # aph_b_..., printed ONCE, host only
sudo -u agent-phone --preserve-env node src/cli.ts brain:status                       # online / last poll / queued jobs
```

- `GET /phone/brain/next?wait=25` → 200 + job (`call.start`, `turn`, `call.end`) or 204. `POST /phone/brain/jobs/:id/result`
  with `{ready:true}` for call.start, `{say, end_call?, ask_code?, note_for_jasmine?}` for turns (or `[[end_call]]`,
  `[[ask_code]]`, `[[note: …]]` tags in `say`), or `{error}` (retried once). 409 = too late, drop it.
- Contract and order of checks: docs/milestone-d-brain.md (§1-§7). The phone session's instructions: docs/phone-persona.md.
- Pete adds to /etc/agent-phone.env himself: `CODE_PHRASE` (never anywhere else), optionally `FACTS_FILE` (0600, format
  docs/facts.example.json) and `INTIMATE_TERMS`. Leave `BRAIN=canned` and pass `brain:"jasmine"` per call while testing.
- Test without the real session: `PHONE_URL=https://jasmine.ashworthhub.com/phone PHONE_BRAIN_KEY=aph_b_… node
  server/scripts/stub-brain-host.mjs` (answers ready, then three scripted lines; `DELAY_MS=3000` to hear a filler).
- The ElevenLabs agent stays on the custom LLM (`/phone/llm/v1`); nothing changes there.
- Per-call timing: `get_call` / `GET /phone/api/calls/:id` → `turns` + `latency` (queue→pickup, host think time, reply, TTS start).
