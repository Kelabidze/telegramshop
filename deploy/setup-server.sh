#!/usr/bin/env bash
#
# One-time VPS provisioning for the Telegram Mini App shop.
# Target: Ubuntu 22.04 / 24.04 (Debian 12 also works).
#
# Idempotent: safe to re-run. Installs Node, Caddy, creates the service user
# and directory layout, but does NOT deploy code (see deploy.sh) and does NOT
# write secrets (you do that once, by hand).
#
# Usage (as root):
#   DOMAIN=shop.example.com bash setup-server.sh

set -euo pipefail

DOMAIN="${DOMAIN:-}"
NODE_MAJOR="${NODE_MAJOR:-22}"
APP_USER="${APP_USER:-shop}"
APP_ROOT="${APP_ROOT:-/srv/shop}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo DOMAIN=your.domain bash setup-server.sh" >&2
  exit 1
fi

if [[ -z "$DOMAIN" ]]; then
  echo "DOMAIN is required, e.g. DOMAIN=shop.example.com bash setup-server.sh" >&2
  exit 1
fi

echo "==> Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# git: pulling the repo. curl/ca-certificates: fetching keys.
# build-essential + python3: fallback if a prebuilt SQLite binary is missing
# for this Node ABI, so `npm ci` can compile instead of failing.
apt-get install -y -qq \
  git curl ca-certificates gnupg debian-keyring debian-archive-keyring \
  apt-transport-https build-essential python3 ufw

echo "==> Installing Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null 2>&1 || \
   [[ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v), npm $(npm -v)"

echo "==> Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "==> Creating service user '${APP_USER}'"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  # System account: no login shell, no password. It only runs the API.
  useradd --system --create-home --home-dir "/home/${APP_USER}" \
          --shell /usr/sbin/nologin "$APP_USER"
fi

echo "==> Creating directory layout under ${APP_ROOT}"
# releases/  : timestamped deployments (atomic switch + rollback)
# shared/    : secrets and the SQLite database, never touched by a deploy
# current    : symlink to the active release
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT/releases"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_ROOT/shared"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_ROOT/shared/data"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT/repo"

echo "==> Preparing secrets file"
ENV_FILE="$APP_ROOT/shared/api.env"
if [[ ! -f "$ENV_FILE" ]]; then
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
# Secrets for the shop API. Edit TELEGRAM_BOT_TOKEN, then restart:
#   systemctl restart shop-api
NODE_ENV=production
PORT=8080
HOST=127.0.0.1
LOG_LEVEL=info

# Absolute path: the API must not depend on its working directory.
DATABASE_URL=file:${APP_ROOT}/shared/data/prod.db

# From @BotFather. REQUIRED - the API refuses to start in production without it.
TELEGRAM_BOT_TOKEN=

# Pre-generated for you.
TELEGRAM_WEBHOOK_SECRET=${WEBHOOK_SECRET}

# Public HTTPS origin of this server.
PUBLIC_API_URL=https://${DOMAIN}

PAYMENT_PROVIDER=stars
TELEGRAM_PROVIDER_TOKEN=

# Same-origin: Caddy serves the app and proxies /api, so no cross-origin calls.
CORS_ORIGINS=https://${DOMAIN}

INIT_DATA_MAX_AGE_SECONDS=86400

# Your Telegram user id(s), comma-separated.
ADMIN_TELEGRAM_IDS=

# MUST stay false in production: it bypasses Telegram signature checks.
ALLOW_DEV_AUTH=false
EOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "    created ${ENV_FILE} (webhook secret generated)"
else
  echo "    ${ENV_FILE} already exists, left untouched"
fi

echo "==> Configuring Caddy for ${DOMAIN}"
CADDY_SRC="$(dirname "$0")/Caddyfile"
if [[ -f "$CADDY_SRC" ]]; then
  sed "s/shop\.example\.com/${DOMAIN}/g" "$CADDY_SRC" > /etc/caddy/Caddyfile
  install -d -o caddy -g caddy /var/log/caddy
  caddy validate --config /etc/caddy/Caddyfile >/dev/null
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  echo "    Caddyfile installed and validated"
else
  echo "    WARNING: Caddyfile not found next to this script; configure manually"
fi

echo "==> Installing systemd unit"
UNIT_SRC="$(dirname "$0")/shop-api.service"
if [[ -f "$UNIT_SRC" ]]; then
  cp "$UNIT_SRC" /etc/systemd/system/shop-api.service
  systemctl daemon-reload
  systemctl enable shop-api >/dev/null
  echo "    shop-api.service installed and enabled"
fi

echo "==> Granting the deploy user permission to restart the service"
# Resolve systemctl's real path instead of assuming /usr/bin: a wrong path in
# sudoers silently fails to match and the deploy cannot restart the service.
SYSTEMCTL="$(command -v systemctl)"
# Narrowly scoped: this user may restart/inspect ONLY this one unit, nothing else.
cat > /etc/sudoers.d/shop-deploy <<EOF
${APP_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL} restart shop-api, ${SYSTEMCTL} status shop-api, ${SYSTEMCTL} is-active shop-api
EOF
chmod 440 /etc/sudoers.d/shop-deploy
# Reject a malformed sudoers file instead of locking sudo for everyone.
visudo -c -f /etc/sudoers.d/shop-deploy >/dev/null || {
  rm -f /etc/sudoers.d/shop-deploy
  echo "    ERROR: generated sudoers rule was invalid and has been removed" >&2
  exit 1
}
echo "    /etc/sudoers.d/shop-deploy installed"

echo "==> Configuring firewall"
# Caddy needs 80 (ACME HTTP challenge + redirect) and 443. The API port 8080
# stays closed: it is only reachable via the reverse proxy on localhost.
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
echo "    ufw active; 8080 intentionally NOT exposed"

cat <<EOF

==========================================================================
Server ready. Next steps:

1. Point DNS: an A record for ${DOMAIN} -> this server's IP.
   Verify:  dig +short ${DOMAIN}

2. Put your bot token into the secrets file:
   nano ${APP_ROOT}/shared/api.env      # set TELEGRAM_BOT_TOKEN=

3. Deploy the code (from your machine or via GitHub Actions):
   sudo -u ${APP_USER} REPO_URL=https://github.com/<you>/<repo>.git \\
        bash ${APP_ROOT}/repo/deploy/deploy.sh

4. Register the Telegram webhook (after the first deploy):
   cd ${APP_ROOT}/current/apps/api && sudo -u ${APP_USER} npm run bot:set-webhook

5. In @BotFather: /newapp -> Web App URL = https://${DOMAIN}
==========================================================================
EOF
