#!/usr/bin/env bash
#
# Deploys the current main branch to this server.
#
# Strategy: build into a fresh release directory, then flip the `current`
# symlink atomically. A failed build never touches the running site, and the
# previous release stays on disk for instant rollback.
#
# Usage (as the shop user):
#   REPO_URL=https://github.com/you/repo.git bash deploy.sh
#   REF=some-branch bash deploy.sh          # deploy a specific ref

set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/shop}"
REPO_URL="${REPO_URL:-https://github.com/Kelabidze/telegramshop.git}"
REF="${REF:-main}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
SERVICE="${SERVICE:-shop-api}"

REPO_DIR="$APP_ROOT/repo"
RELEASES_DIR="$APP_ROOT/releases"
SHARED_DIR="$APP_ROOT/shared"
CURRENT_LINK="$APP_ROOT/current"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

# --- 1. fetch source -------------------------------------------------------
log "Fetching source (${REF})"

# Git refuses to operate on a repo owned by another user ("dubious ownership").
# Declaring it safe keeps the deploy working even if the clone was made by root.
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$REPO_DIR" \
  || git config --global --add safe.directory "$REPO_DIR"

if [[ ! -d "$REPO_DIR/.git" ]]; then
  [[ -n "$REPO_URL" ]] || fail "REPO_URL is required for the first deploy"
  git clone --quiet "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"
git remote set-url origin "${REPO_URL:-$(git remote get-url origin)}"
git fetch --quiet --prune origin
# Hard reset: the server is a deployment target, not a place to edit code.
git checkout --quiet --detach "origin/${REF}" 2>/dev/null \
  || git checkout --quiet --detach "$REF"
git reset --quiet --hard

COMMIT="$(git rev-parse --short HEAD)"
SUBJECT="$(git log -1 --pretty=%s)"
echo "    ${COMMIT}  ${SUBJECT}"

# --- 2. skip if already deployed ------------------------------------------
if [[ -L "$CURRENT_LINK" ]] && [[ -f "$CURRENT_LINK/.deployed-commit" ]]; then
  if [[ "$(cat "$CURRENT_LINK/.deployed-commit")" == "$COMMIT" ]]; then
    if [[ "${FORCE:-}" != "1" ]]; then
      echo "    ${COMMIT} is already live; nothing to do (FORCE=1 to override)"
      exit 0
    fi
  fi
fi

# --- 3. build into a new release ------------------------------------------
RELEASE="$RELEASES_DIR/$(date +%Y%m%d-%H%M%S)-${COMMIT}"
log "Building release $(basename "$RELEASE")"

# Clean copy of the working tree, without .git history.
mkdir -p "$RELEASE"
git archive HEAD | tar -x -C "$RELEASE"
cd "$RELEASE"

# Point the API at the shared database before any Prisma command runs.
set -a
# shellcheck disable=SC1091
source "$SHARED_DIR/api.env"
set +a

log "Installing dependencies"
# devDependencies are required: the release is built from source on the server
# (TypeScript, Vite, the Prisma CLI all live in devDependencies).
#
# `npm ci` installs exactly what package-lock.json specifies. The `allowScripts`
# block in package.json is what permits the native SQLite module to install;
# without it npm 11 blocks install scripts and the driver fails at runtime.
npm ci --no-audit --no-fund 2>&1 | tail -5 || fail "npm ci failed"

# Fail loudly here rather than at the first database query.
node -e "require('better-sqlite3')" 2>/dev/null \
  || fail "native better-sqlite3 module did not load; check npm allowScripts and build-essential"

log "Applying database schema"
# `db push` is safe here: it only adds missing tables/columns. It never drops
# data unless the schema removes something.
npm run db:push 2>&1 | tail -5 || fail "prisma db push failed"

log "Building"
npm run build 2>&1 | tail -8 || fail "build failed"

# Verify the compiled entrypoint actually exists before going live.
[[ -f "$RELEASE/apps/api/dist/server.js" ]] || fail "API build produced no dist/server.js"
[[ -f "$RELEASE/apps/miniapp/dist/index.html" ]] || fail "Mini App build produced no index.html"

echo "$COMMIT" > "$RELEASE/.deployed-commit"

# --- 4. switch over atomically --------------------------------------------
log "Switching to the new release"
PREVIOUS=""
[[ -L "$CURRENT_LINK" ]] && PREVIOUS="$(readlink -f "$CURRENT_LINK")"

# ln -T on a temp name + mv is atomic: there is no moment without a target.
ln -sfnT "$RELEASE" "${CURRENT_LINK}.new"
mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"

log "Restarting ${SERVICE}"
# The deploy user is granted exactly this one sudo command (see setup notes).
sudo -n systemctl restart "$SERVICE" \
  || fail "could not restart ${SERVICE}; check the sudoers rule for this user"

# --- 5. health check, roll back on failure --------------------------------
log "Health check"
HEALTH_URL="http://127.0.0.1:${PORT:-8080}/health"
HEALTHY=0
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [[ "$HEALTHY" -ne 1 ]]; then
  echo "    health check failed"
  if [[ -n "$PREVIOUS" ]] && [[ -d "$PREVIOUS" ]]; then
    log "Rolling back to $(basename "$PREVIOUS")"
    ln -sfnT "$PREVIOUS" "${CURRENT_LINK}.new"
    mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"
    sudo -n systemctl restart "$SERVICE" || true
    fail "deploy rolled back; check: journalctl -u ${SERVICE} -n 50"
  fi
  fail "deploy unhealthy and no previous release to roll back to"
fi

curl -fsS --max-time 3 "$HEALTH_URL" || true
echo

# --- 6. prune old releases ------------------------------------------------
log "Pruning old releases (keeping ${KEEP_RELEASES})"
# Resolve the live release without relying on `readlink -f` alone: read the
# symlink target directly, then take its basename. If resolution fails for any
# reason, skip pruning entirely rather than risk deleting the running release.
CURRENT_TARGET=""
if [[ -L "$CURRENT_LINK" ]]; then
  CURRENT_TARGET="$(basename "$(readlink "$CURRENT_LINK")")"
fi

if [[ -z "$CURRENT_TARGET" || "$CURRENT_TARGET" == "current" ]]; then
  echo "    could not determine the live release; skipping prune to stay safe"
else
  echo "    live release: ${CURRENT_TARGET}"
  cd "$RELEASES_DIR"
  ls -1dt */ 2>/dev/null | tail -n "+$((KEEP_RELEASES + 1))" | while read -r old; do
    old="${old%/}"
    # Never delete the live release, whatever the sort order says.
    if [[ "$old" == "$CURRENT_TARGET" ]]; then
      echo "    keeping ${old} (currently live)"
      continue
    fi
    echo "    removing ${old}"
    rm -rf -- "$old"
  done
fi

# Fail loudly if pruning somehow broke the symlink.
[[ -d "$CURRENT_LINK" ]] || fail "current symlink is broken after pruning"

log "Deployed ${COMMIT} successfully"
