#!/usr/bin/env bash
# Update + restart on the droplet:  sudo /opt/agent-phone/deploy/deploy.sh
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/agent-phone}
cd "$APP_DIR"
sudo -u agent-phone git pull --ff-only
cd server
sudo -u agent-phone npm ci --omit=dev --no-audit --no-fund
# Migrations also run on boot; running them here surfaces errors before the restart.
set -a; source /etc/agent-phone.env; set +a
export NODE_NO_WARNINGS=1   # silences node:sqlite's ExperimentalWarning
# systemd creates the StateDirectory only on the service's first start; on a fresh install it doesn't exist yet.
DATA_DIR=${DATA_DIR:-/var/lib/agent-phone}
install -d -o agent-phone -g agent-phone -m 750 "$DATA_DIR"
sudo -u agent-phone --preserve-env node src/cli.ts migrate
systemctl restart agent-phone
sleep 2
curl -fsS http://127.0.0.1:3600/phone/health && echo
