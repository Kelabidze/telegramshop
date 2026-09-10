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
  # A real shell is required: GitHub Actions deploys by running deploy.sh over
  # SSH as this user. Password login stays disabled (`--disabled-password`
  # equivalent: no password is ever set), so access is key-only.
  useradd --system --create-home --home-dir "/home/${APP_USER}" \
          --shell /bin/bash "$APP_USER"
  # Explicitly lock the password so only SSH keys can authenticate.
  passwd --lock "$APP_USER" >/dev/null
  echo "    created (shell: /bin/bash, password locked, key-only access)"
else
  # An earlier version of this script created the account with nologin, which
  # silently breaks SSH-based deploys. Repair it.
  CURRENT_SHELL="$(getent passwd "$APP_USER" | cut -d: -f7)"
  if [[ "$CURRENT_SHELL" == *nologin* || "$CURRENT_SHELL" == *false* ]]; then
    usermod --shell /bin/bash "$APP_USER"
    echo "    existing account had ${CURRENT_SHELL}; switched to /bin/bash for SSH deploys"
  else
    echo "    already exists (shell: ${CURRENT_SHELL})"
  fi
fi

# SSH directory for the deploy key used by GitHub Actions.
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "/home/${APP_USER}/.ssh"
touch "/home/${APP_USER}/.ssh/authorized_keys"
chown "$APP_USER:$APP_USER" "/home/${APP_USER}/.ssh/authorized_keys"
chmod 600 "/home/${APP_USER}/.ssh/authorized_keys"

echo "==> Creating directory layout under ${APP_ROOT}"
# releases/  : timestamped deployments (atomic switch + rollback)
# incoming/  : upload target for build artifacts from CI
# shared/    : secrets and the SQLite database, never touched by a deploy
# current    : symlink to the active release
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT/releases"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT/incoming"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_ROOT/shared"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_ROOT/shared/data"
# Uploaded media. 755, unlike data/: Caddy runs as its own user and has to read
# these files to serve /uploads/*. The database stays private at 750.
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT/shared/uploads"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_ROOT/repo"

echo "==> Preparing the source checkout"
# Only the deploy scripts and server configs are needed here: application code
# arrives as a pre-built artifact from CI. The clone is made AS the app user so
# `git pull` below never hits "dubious ownership".
if [[ ! -d "$APP_ROOT/repo/.git" ]]; then
  sudo -u "$APP_USER" git clone --quiet "$REPO_URL" "$APP_ROOT/repo"
  echo "    cloned ${REPO_URL}"
else
  # Fix ownership in case an earlier run cloned it as root.
  chown -R "$APP_USER:$APP_USER" "$APP_ROOT/repo"
  sudo -u "$APP_USER" git -C "$APP_ROOT/repo" remote set-url origin "$REPO_URL"
  sudo -u "$APP_USER" git -C "$APP_ROOT/repo" fetch --quiet --prune origin || true
  sudo -u "$APP_USER" git -C "$APP_ROOT/repo" reset --quiet --hard origin/HEAD 2>/dev/null \
    || sudo -u "$APP_USER" git -C "$APP_ROOT/repo" reset --quiet --hard origin/main 2>/dev/null \
    || true
  echo "    repo refreshed (deploy scripts and server configs)"
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

# Uploaded banner and product media. MUST stay outside the release directory:
# deploys prune old releases, so anything written there disappears. Caddy serves
# this path directly as /uploads/*.
UPLOADS_DIR=${APP_ROOT}/shared/uploads

# From @BotFather. REQUIRED - the API refuses to start in production without it.
TELEGRAM_BOT_TOKEN=

# Pre-generated for you.
TELEGRAM_WEBHOOK_SECRET=${WEBHOOK_SECRET}

# Public HTTPS origin of this server.
PUBLIC_API_URL=https://${DOMAIN}

# Same origin: Caddy serves the Mini App and proxies /api. This is what the
# bot's inline buttons open, so it must be the app, not the API.
PUBLIC_APP_URL=https://${DOMAIN}

PAYMENT_PROVIDER=stars
TELEGRAM_PROVIDER_TOKEN=

# Same-origin: Caddy serves the app and proxies /api, so no cross-origin calls.
CORS_ORIGINS=https://${DOMAIN}

INIT_DATA_MAX_AGE_SECONDS=86400

# Club tier: membership in this channel lowers prices by 5%.
# Set BOTH or NEITHER - the API refuses to start with only one, because half the
# feature fails silently. The bot must be an ADMINISTRATOR of the channel.
#   CLUB_CHANNEL_ID=@your_channel
#   CLUB_CHANNEL_URL=https://t.me/your_channel
CLUB_CHANNEL_ID=
CLUB_CHANNEL_URL=
CLUB_MEMBERSHIP_TTL_SECONDS=60

# Your Telegram user id(s), comma-separated.
ADMIN_TELEGRAM_IDS=

# MUST stay false in production: it bypasses Telegram signature checks.
ALLOW_DEV_AUTH=false
EOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "    created ${ENV_FILE} (webhook secret generated)"
else
  # Existing installations predate configuration additions. Add only this safe,
  # required production default; never rewrite values or secrets managed on-host.
  if ! grep -qE '^[[:space:]]*(export[[:space:]]+)?NODE_ENV=' "$ENV_FILE"; then
    printf '\n# Added by setup-server.sh: enables production safety checks.\nNODE_ENV=production\n' >> "$ENV_FILE"
    chown "$APP_USER:$APP_USER" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "    added NODE_ENV=production to existing ${ENV_FILE}"
  else
    echo "    ${ENV_FILE} already exists, left untouched"
  fi
fi

echo "==> Configuring Caddy for ${DOMAIN}"
# Take the configs from the clone, not from $(dirname $0): that way this script
# also works when piped straight from curl, with no local checkout.
DEPLOY_DIR="$APP_ROOT/repo/deploy"
CADDY_SYNC="$DEPLOY_DIR/sync-caddy.sh"

# Staging area for the config, owned by the deploy user. This is what lets
# deploy.sh synchronise Caddy through narrowly scoped sudo rules: every
# privileged command takes a fixed path inside this directory, so no rule needs a
# wildcard. 750 because the file describes the whole reverse-proxy topology.
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_ROOT/caddy"

# Caddy's log directory must exist before validation: `caddy validate` provisions
# the modules the config declares, and the file logger fails on a missing path.
install -d -o caddy -g caddy /var/log/caddy

if [[ -f "$CADDY_SYNC" ]]; then
  # One implementation, shared with deploy.sh. This used to be an inline
  # awk + validate + reload sequence here, which had two problems: it was a
  # second copy of logic that also had to exist for deploys, and it redirected
  # awk straight into /etc/caddy/Caddyfile and validated *afterwards* — so a
  # broken config destroyed the working one, leaving a server that ran fine
  # until its next reload and then would not come back.
  #
  # sync-caddy.sh renders to a staging file, validates that, and only installs
  # once validation passes.
  DOMAIN="$DOMAIN" APP_ROOT="$APP_ROOT" APP_USER="$APP_USER" \
    bash "$CADDY_SYNC" apply \
    || { echo "    ERROR: Caddy config sync failed" >&2; exit 1; }
  echo "    Caddyfile installed and validated for ${DOMAIN}"
else
  echo "    ERROR: ${CADDY_SYNC} not found" >&2
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

echo "==> Granting the deploy user its privileged commands"
# Resolve real paths instead of assuming /usr/bin: a wrong path in sudoers
# silently fails to match, and the deploy then cannot restart the service or
# install the config.
SYSTEMCTL="$(command -v systemctl)"
CADDY_BIN="$(command -v caddy)"
INSTALL_BIN="$(command -v install)"
STAGED_CONFIG="$APP_ROOT/caddy/Caddyfile.staged"
ROLLBACK_CONFIG="$APP_ROOT/caddy/Caddyfile.rollback"

# Narrowly scoped, every rule with fixed arguments and no wildcard:
#
#   systemctl restart|status|is-active shop-api   the application service
#   caddy validate --config <staged>              fallback only; see below
#   install <staged>   -> /etc/caddy/Caddyfile    apply a synchronised config
#   install <rollback> -> /etc/caddy/Caddyfile    undo it when a deploy fails
#   systemctl reload caddy                        make the installed config live
#
# The two `install` rules are what make this safe to grant: the source paths are
# literal, so the right to write /etc/caddy/Caddyfile cannot be reused to write
# anywhere else, and the mode and ownership are fixed by the rule itself.
#
# The `caddy validate` rule is a fallback. sync-caddy.sh validates unprivileged
# first and only escalates if that fails, which happens when Caddy's log
# directory is unreadable to this user. On a server where the unprivileged call
# works the rule is never used and can be removed.
cat > /etc/sudoers.d/shop-deploy <<EOF
${APP_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL} restart shop-api, ${SYSTEMCTL} status shop-api, ${SYSTEMCTL} is-active shop-api, ${CADDY_BIN} validate --config ${STAGED_CONFIG}, ${INSTALL_BIN} -o root -g root -m 644 ${STAGED_CONFIG} /etc/caddy/Caddyfile, ${INSTALL_BIN} -o root -g root -m 644 ${ROLLBACK_CONFIG} /etc/caddy/Caddyfile, ${SYSTEMCTL} reload caddy
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
   cd ${APP_ROOT}/current/apps/api
   sudo -u ${APP_USER} node --env-file=${APP_ROOT}/shared/api.env dist/cli/webhook.js set

4. In @BotFather: /newapp -> Web App URL = https://${DOMAIN}

5. Optional: fill the catalog with demo products:
   cd ${APP_ROOT}/current/apps/api
   sudo -u ${APP_USER} node --env-file=${APP_ROOT}/shared/api.env dist/cli/seed.js

Note: use plain "node", not "npm run". The artifact carries production
dependencies only, so tsx (a devDependency) is absent; these entry points
ship pre-compiled in dist/cli.

Useful:
   systemctl status shop-api
   journalctl -u shop-api -f
   journalctl -u caddy -n 30        # certificate issuance problems show here
==========================================================================
EOF
