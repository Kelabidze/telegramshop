#!/usr/bin/env bash
#
# Installs a pre-built artifact on this server.
#
# The build happens on a GitHub runner (see .github/workflows/deploy.yml) and
# this script only unpacks the result, installs production dependencies and
# flips a symlink. Nothing is compiled here: a small VPS has neither the CPU
# nor the RAM to run tsc + vite without risking the OOM killer.
#
# Strategy: unpack into a fresh release directory, then flip `current`
# atomically. A failed install never touches the running site, and the previous
# release stays on disk for instant rollback.
#
# Usage (as the shop user):
#   bash deploy.sh /path/to/artifact.tar.gz
#   ARTIFACT=/tmp/artifact.tar.gz bash deploy.sh
#
# The artifact is produced by `npm run pack` and contains compiled output plus
# manifests only — no node_modules, so native modules are always built or
# downloaded for THIS machine's Node ABI.

set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/shop}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
SERVICE="${SERVICE:-shop-api}"
ARTIFACT="${1:-${ARTIFACT:-$APP_ROOT/incoming/artifact.tar.gz}}"

RELEASES_DIR="$APP_ROOT/releases"
SHARED_DIR="$APP_ROOT/shared"
CURRENT_LINK="$APP_ROOT/current"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

# --- 1. validate the artifact ----------------------------------------------
log "Checking artifact"

[[ -f "$ARTIFACT" ]] || fail "artifact not found: $ARTIFACT"

# Verify the checksum when it was shipped alongside: a truncated upload would
# otherwise surface as a confusing tar or node error later on.
if [[ -f "${ARTIFACT}.sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$ARTIFACT")" && sha256sum -c "$(basename "$ARTIFACT").sha256" >/dev/null) \
      || fail "artifact checksum mismatch; the upload is corrupt"
    echo "    checksum OK"
  fi
else
  echo "    no .sha256 alongside the artifact; skipping integrity check"
fi

tar -tzf "$ARTIFACT" >/dev/null 2>&1 || fail "artifact is not a readable tar.gz"

# --- 2. read metadata and refuse an incompatible build ---------------------
# Native modules are compiled against a specific Node ABI. Installing them here
# means they always match this machine, but the compiled JS also assumes the
# Node major it was built for, so a mismatch is worth reporting.
META="$(tar -xzOf "$ARTIFACT" ./artifact.json 2>/dev/null || echo '')"
[[ -n "$META" ]] || fail "artifact.json is missing; this is not a shop artifact"

json_value() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" <<<"$META" | head -1; }

COMMIT="$(json_value commitShort)"
SUBJECT="$(json_value subject)"
BUILD_NODE="$(json_value nodeMajor)"
BUILT_AT="$(json_value builtAt)"
[[ -n "$COMMIT" ]] || fail "artifact.json has no commit information"

LOCAL_NODE="$(node -p 'process.versions.node.split(".")[0]')"

echo "    commit    ${COMMIT}  ${SUBJECT}"
echo "    built     ${BUILT_AT} on Node ${BUILD_NODE}.x"
echo "    this host  Node ${LOCAL_NODE}.x"

if [[ "$BUILD_NODE" != "$LOCAL_NODE" ]]; then
  echo "    WARNING: built on Node ${BUILD_NODE}.x but this server runs ${LOCAL_NODE}.x."
  echo "             Align the Node major in the workflow and on the server."
fi

# --- 3. skip if already deployed ------------------------------------------
if [[ -L "$CURRENT_LINK" ]] && [[ -f "$CURRENT_LINK/.deployed-commit" ]]; then
  if [[ "$(cat "$CURRENT_LINK/.deployed-commit")" == "$COMMIT" ]]; then
    if [[ "${FORCE:-}" != "1" ]]; then
      echo "    ${COMMIT} is already live; nothing to do (FORCE=1 to override)"
      exit 0
    fi
  fi
fi

# --- 4. unpack into a new release -----------------------------------------
RELEASE="$RELEASES_DIR/$(date +%Y%m%d-%H%M%S)-${COMMIT}"
log "Unpacking release $(basename "$RELEASE")"

mkdir -p "$RELEASE"
# Clean up a half-finished release if anything below fails, so a broken deploy
# does not leave junk that later gets counted as a rollback target.
cleanup_release() {
  if [[ "${RELEASE_LIVE:-0}" != "1" ]] && [[ -d "$RELEASE" ]]; then
    rm -rf -- "$RELEASE"
  fi
}
trap cleanup_release EXIT

tar -xzf "$ARTIFACT" -C "$RELEASE" || fail "could not unpack the artifact"

[[ -f "$RELEASE/apps/api/dist/server.js" ]] || fail "artifact has no apps/api/dist/server.js"
[[ -f "$RELEASE/apps/miniapp/dist/index.html" ]] || fail "artifact has no Mini App build"

cd "$RELEASE"

# Point Prisma at the shared database before any of its commands run.
set -a
# shellcheck disable=SC1091
source "$SHARED_DIR/api.env"
set +a

# --- 5. production dependencies -------------------------------------------
log "Installing production dependencies"
# `--omit=dev` skips TypeScript, Vite and the test tooling: the code is already
# compiled, so ~425 MB of dev dependencies become ~100 MB of runtime ones.
#
# Install scripts stay ENABLED on purpose. The Prisma SQLite adapter depends on
# better-sqlite3, whose install step downloads a prebuilt binary for this exact
# platform and Node ABI (falling back to a source build). Disabling scripts here
# would leave the driver without its native module and the API would fail on the
# first query.
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -5 \
  || fail "npm ci failed; see the output above"

# Fail loudly here rather than at the first database query. The adapter resolves
# its own nested copy of better-sqlite3, so probe through the adapter itself
# instead of a bare require that may resolve elsewhere.
node -e "import('@prisma/adapter-better-sqlite3').then(()=>{},e=>{console.error(e.message);process.exit(1)})" \
  || fail "the SQLite driver did not load; check the npm ci output above"

# --- 6. database schema ----------------------------------------------------
log "Applying database schema"
# `db push` only adds missing tables and columns. It never drops data unless the
# schema itself removed something.
npm run db:push 2>&1 | tail -5 || fail "prisma db push failed"

echo "$COMMIT" > "$RELEASE/.deployed-commit"
cp -f "$RELEASE/artifact.json" "$RELEASE/.artifact.json" 2>/dev/null || true

# --- 7. switch over atomically --------------------------------------------
log "Switching to the new release"
PREVIOUS=""
[[ -L "$CURRENT_LINK" ]] && PREVIOUS="$(readlink -f "$CURRENT_LINK")"

# ln -T on a temp name + mv is atomic: there is no moment without a target.
ln -sfnT "$RELEASE" "${CURRENT_LINK}.new"
mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"
RELEASE_LIVE=1

log "Restarting ${SERVICE}"
# The deploy user is granted exactly this one sudo command (see setup-server.sh).
sudo -n systemctl restart "$SERVICE" \
  || fail "could not restart ${SERVICE}; check the sudoers rule for this user"

# --- 8. health check, roll back on failure --------------------------------
log "Health check"
HEALTH_URL="http://127.0.0.1:${PORT:-8080}/health"
HEALTHY=0
for _ in $(seq 1 20); do
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
    # Keep the failed release on disk: its logs and node_modules are what make
    # the failure diagnosable.
    fail "deploy rolled back; check: journalctl -u ${SERVICE} -n 50"
  fi
  fail "deploy unhealthy and no previous release to roll back to"
fi

curl -fsS --max-time 3 "$HEALTH_URL" || true
echo

# --- 9. prune old releases ------------------------------------------------
log "Pruning old releases (keeping ${KEEP_RELEASES})"
# Resolve the live release by reading the symlink directly. If resolution fails
# for any reason, skip pruning entirely rather than risk deleting what is live.
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
