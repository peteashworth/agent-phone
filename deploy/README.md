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
