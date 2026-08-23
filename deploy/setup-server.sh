#!/usr/bin/env bash
#
# One-time VPS provisioning for the Telegram Mini App shop.
# Target: Ubuntu 22.04 / 24.04 (Debian 12 also works).
#
# Installs Node + Caddy, creates the service user and directory layout, clones
# the repo and generates a secrets file. Does NOT deploy code (see deploy.sh)
# and never overwrites an existing secrets file.
#
# Idempotent: safe to re-run.
#
# Usage (as root, from a checkout of this repo):
#   sudo bash deploy/setup-server.sh
#
# Or standalone, without cloning first:
#   curl -fsSL https://raw.githubusercontent.com/Kelabidze/telegramshop/main/deploy/setup-server.sh | sudo bash
#
# Overridable: DOMAIN, REPO_URL, APP_USER, APP_ROOT, NODE_MAJOR

set -euo pipefail

DOMAIN="${DOMAIN:-ochkisk.shop}"
REPO_URL="${REPO_URL:-https://github.com/Kelabidze/telegramshop.git}"
NODE_MAJOR="${NODE_MAJOR:-22}"
APP_USER="${APP_USER:-shop}"
APP_ROOT="${APP_ROOT:-/srv/shop}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash setup-server.sh" >&2
  exit 1
fi

if [[ -z "$DOMAIN" ]]; then
  echo "DOMAIN is empty. Pass it explicitly: DOMAIN=your.domain bash setup-server.sh" >&2
  exit 1
fi

echo "==> Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# git: pulling the repo. curl/ca-certificates: fetching keys.
# sudo: deploy.sh uses it to restart the service and to drop privileges.
# build-essential + python3: fallback if a prebuilt SQLite binary is missing
# for this Node ABI, so `npm ci` can compile instead of failing.
apt-get install -y -qq \
  git curl ca-certificates gnupg debian-keyring debian-archive-keyring \
  apt-transport-https build-essential python3 ufw sudo openssl

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

echo "==> Preparing the source checkout"
# The repo is cloned AS the app user: deploy.sh runs as that user and must be
# able to `git fetch` here. A root-owned clone would break every deploy.
if [[ ! -d "$APP_ROOT/repo/.git" ]]; then
  sudo -u "$APP_USER" git clone --quiet "$REPO_URL" "$APP_ROOT/repo"
  echo "    cloned ${REPO_URL}"
else
  # Fix ownership in case an earlier run cloned it as root.
  chown -R "$APP_USER:$APP_USER" "$APP_ROOT/repo"
  sudo -u "$APP_USER" git -C "$APP_ROOT/repo" remote set-url origin "$REPO_URL"
  echo "    repo already present; ownership and remote refreshed"
fi

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
# Take the configs from the clone, not from $(dirname $0): that way this script
# also works when piped straight from curl, with no local checkout.
DEPLOY_DIR="$APP_ROOT/repo/deploy"
CADDY_SRC="$DEPLOY_DIR/Caddyfile"
if [[ -f "$CADDY_SRC" ]]; then
  # Rewrite whatever domain the site block declares to $DOMAIN, so this works
  # regardless of which domain is committed in the repo.
  awk -v d="$DOMAIN" '
    # The site address is the first line at column 0 that ends in "{".
    !done && /^[^[:space:]#].*\{[[:space:]]*$/ { print d " {"; done=1; next }
    { print }
  ' "$CADDY_SRC" > /etc/caddy/Caddyfile

  grep -q "^${DOMAIN} {" /etc/caddy/Caddyfile \
    || { echo "    ERROR: failed to set the domain in /etc/caddy/Caddyfile" >&2; exit 1; }

  install -d -o caddy -g caddy /var/log/caddy
  caddy validate --config /etc/caddy/Caddyfile >/dev/null \
    || { echo "    ERROR: Caddyfile failed validation" >&2; exit 1; }
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  echo "    Caddyfile installed and validated for ${DOMAIN}"
else
  echo "    ERROR: ${CADDY_SRC} not found" >&2
  exit 1
fi

echo "==> Installing systemd unit"
UNIT_SRC="$DEPLOY_DIR/shop-api.service"
if [[ -f "$UNIT_SRC" ]]; then
  cp "$UNIT_SRC" /etc/systemd/system/shop-api.service
  systemctl daemon-reload
  systemctl enable shop-api >/dev/null
  echo "    shop-api.service installed and enabled"
else
  echo "    ERROR: ${UNIT_SRC} not found" >&2
  exit 1
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

echo "==> Checking DNS for ${DOMAIN}"
# Caddy cannot obtain a certificate until the domain resolves to THIS server.
# Warn loudly instead of failing: DNS may still be propagating.
MY_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo '')"
RESOLVED="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)"
if [[ -z "$RESOLVED" ]]; then
  echo "    WARNING: ${DOMAIN} does not resolve yet; the certificate will fail until it does"
elif [[ -n "$MY_IP" && "$RESOLVED" != "$MY_IP" ]]; then
  echo "    WARNING: ${DOMAIN} -> ${RESOLVED}, but this server is ${MY_IP}"
  echo "             Let's Encrypt will refuse until the A record points here."
else
  echo "    OK: ${DOMAIN} -> ${RESOLVED}"
fi

cat <<EOF

==========================================================================
Server ready for ${DOMAIN}.

DNS already resolves ochkisk.shop -> 176.119.156.77, so Caddy will request a
certificate as soon as it serves the first request on port 80/443.

Next steps:

1. Put your bot token into the secrets file:
   nano ${APP_ROOT}/shared/api.env      # set TELEGRAM_BOT_TOKEN=

2. Deploy the code:
   sudo -u ${APP_USER} bash ${APP_ROOT}/repo/deploy/deploy.sh

3. Register the Telegram webhook (after the first deploy):
   cd ${APP_ROOT}/current/apps/api && sudo -u ${APP_USER} npm run bot:set-webhook

4. In @BotFather: /newapp -> Web App URL = https://${DOMAIN}

Useful:
   systemctl status shop-api
   journalctl -u shop-api -f
   journalctl -u caddy -n 30        # certificate issuance problems show here
==========================================================================
EOF
