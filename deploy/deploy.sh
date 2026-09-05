#!/usr/bin/env bash
#
# Installs a pre-built artifact on this server.
#
# The build happens on a GitHub runner (see .github/workflows/deploy.yml) and
# this script only unpacks the result and flips a symlink. Nothing is compiled
# and nothing is installed here: a small VPS has neither the CPU nor the RAM to
# run tsc + vite (or even `npm ci`) without risking the OOM killer.
#
# Strategy: unpack into a fresh release directory, then flip `current`
# atomically. A failed install never touches the running site, and the live
# release stays on disk for instant rollback.
#
# Usage (as the shop user):
#   bash deploy.sh /path/to/artifact.tar.gz
#   ARTIFACT=/tmp/artifact.tar.gz bash deploy.sh
#
# The artifact is produced by `npm run pack` and carries compiled output,
# manifests AND the production node_modules built on the runner — which is why
# it weighs ~100 MB gzipped, ~400 MB unpacked, and why only two releases are kept
# (see KEEP_RELEASES).

set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/shop}"
# How many release directories may remain after a successful deploy, the new one
# included. Two means: the live release plus one rollback target.
#
# It used to be five, which this disk cannot afford: every release now carries
# its own production node_modules (~400 MB unpacked), so five of them hold well
# over 2 GB. On a 9.7 GB VPS that was enough to reach 100% usage, and the next
# deploy died inside tar with "No space left on device".
KEEP_RELEASES="${KEEP_RELEASES:-2}"
SERVICE="${SERVICE:-shop-api}"
ARTIFACT="${1:-${ARTIFACT:-$APP_ROOT/incoming/artifact.tar.gz}}"

RELEASES_DIR="$APP_ROOT/releases"
SHARED_DIR="$APP_ROOT/shared"
CURRENT_LINK="$APP_ROOT/current"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

# Trims $RELEASES_DIR down to $1 release directories, newest first.
#
# The live release is always kept and never counted as a deletion candidate,
# whatever its position in the sort order — a previous deploy that failed its
# health check is left on disk for diagnosis, so the newest directory is not
# necessarily the one serving traffic.
#
# Called twice: before unpacking, to free the disk, and after the switch, to
# trim what the new release displaced.
prune_releases() {
  local keep="$1"
  local live=""
  local candidates=()
  local entry name

  [[ -d "$RELEASES_DIR" ]] || return 0
  if (( keep < 1 )); then keep=1; fi

  if [[ -L "$CURRENT_LINK" ]]; then
    live="$(basename "$(readlink "$CURRENT_LINK")")"
  fi

  # Without knowing what is live, deleting anything risks removing the directory
  # that is serving traffic. Leaving junk behind is the lesser evil.
  if [[ -z "$live" || "$live" == "current" ]]; then
    echo "    could not determine the live release; skipping prune to stay safe"
    return 0
  fi

  echo "    live release: ${live}"

  # `ls` exits non-zero when the glob matches nothing, and process substitution
  # keeps the loop out of a subshell so `candidates` survives it.
  while read -r entry; do
    name="${entry%/}"
    if [[ -z "$name" || "$name" == "$live" ]]; then
      continue
    fi
    candidates+=("$name")
  done < <(cd "$RELEASES_DIR" && ls -1dt */ 2>/dev/null || true)

  if (( ${#candidates[@]} == 0 )); then
    return 0
  fi

  # The live release occupies one of the kept slots — unless `current` dangles,
  # which happens when someone deletes the live release by hand to free space.
  # Reserving a slot for a directory that no longer exists would silently keep
  # one release fewer than KEEP_RELEASES promises.
  local keep_others="$keep"
  if [[ -d "$RELEASES_DIR/$live" ]]; then
    keep_others=$(( keep - 1 ))
  fi

  local index=0

  for name in "${candidates[@]}"; do
    if (( index < keep_others )); then
      index=$(( index + 1 ))
      continue
    fi
    echo "    removing ${name}"
    # A failed removal must not abort the deploy: it is a housekeeping problem,
    # not a broken release.
    rm -rf -- "${RELEASES_DIR:?}/${name}" || echo "    WARNING: could not remove ${name}"
  done
}

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
BUILD_PLATFORM="$(json_value platform)"
BUILD_ARCH="$(json_value arch)"
BUNDLED="$(sed -n 's/.*"bundledDependencies"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' <<<"$META" | head -1)"
[[ -n "$COMMIT" ]] || fail "artifact.json has no commit information"

LOCAL_NODE="$(node -p 'process.versions.node.split(".")[0]')"

echo "    commit    ${COMMIT}  ${SUBJECT}"
echo "    built     ${BUILT_AT} on Node ${BUILD_NODE}.x"
echo "    this host  Node ${LOCAL_NODE}.x"

# node_modules now travel inside the artifact, including better-sqlite3's
# compiled binary. That binary is valid for exactly one Node ABI, OS and
# architecture, so a mismatch must stop the deploy instead of producing a
# baffling "invalid ELF header" or "was compiled against a different Node
# version" at the first database query.
if [[ "$BUNDLED" == "true" ]]; then
  echo "    deps      bundled (${BUILD_PLATFORM:-?}/${BUILD_ARCH:-?})"

  if [[ "$BUILD_NODE" != "$LOCAL_NODE" ]]; then
    fail "artifact was built on Node ${BUILD_NODE}.x but this host runs ${LOCAL_NODE}.x.
       The bundled native SQLite driver is ABI-bound and would fail at runtime.
       Align env.NODE_VERSION in .github/workflows/deploy.yml with NODE_MAJOR
       in deploy/setup-server.sh, then rebuild."
  fi

  LOCAL_PLATFORM="$(node -p 'process.platform')"
  LOCAL_ARCH="$(node -p 'process.arch')"
  if [[ -n "$BUILD_PLATFORM" && "$BUILD_PLATFORM" != "$LOCAL_PLATFORM" ]] \
    || [[ -n "$BUILD_ARCH" && "$BUILD_ARCH" != "$LOCAL_ARCH" ]]; then
    fail "artifact was built for ${BUILD_PLATFORM}/${BUILD_ARCH} but this host is ${LOCAL_PLATFORM}/${LOCAL_ARCH}."
  fi
elif [[ "$BUILD_NODE" != "$LOCAL_NODE" ]]; then
  # Legacy artifact without bundled dependencies: a warning is enough, since
  # the server used to install (and therefore compile) its own binaries.
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

# --- 4. make room BEFORE unpacking ----------------------------------------
# Pruning used to happen only at the very end, after the switch. That was too
# late: with node_modules inside every release the directories grew large enough
# to fill the disk, and the deploy then died inside tar with "No space left on
# device" — before ever reaching the code that would have freed the space.
# Freeing first makes the deploy self-healing instead of a dead end that needs
# manual SSH cleanup.
#
# KEEP_RELEASES - 1 is deliberate: the release about to be unpacked claims the
# last slot. The live release is never a deletion candidate, so the rollback
# target of THIS deploy survives; what goes away is the older rollback target,
# which the final prune would have deleted anyway.
log "Making room (keeping ${KEEP_RELEASES} releases after this deploy)"
prune_releases "$(( KEEP_RELEASES - 1 ))"

# Refuse early, with a readable message, instead of letting tar fail halfway
# through with the reason buried in its output.
ARTIFACT_KB=$(( $(stat -c %s "$ARTIFACT" 2>/dev/null || wc -c <"$ARTIFACT") / 1024 ))
AVAILABLE_KB="$(df -Pk "$RELEASES_DIR" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
# node_modules compresses roughly fourfold; ask for five times the archive so
# that prisma db push, the journal and the database still have room afterwards.
NEEDED_KB=$(( ARTIFACT_KB * 5 ))

echo "    artifact  $(( ARTIFACT_KB / 1024 )) MB compressed"
if [[ -n "$AVAILABLE_KB" ]]; then
  echo "    free      $(( AVAILABLE_KB / 1024 )) MB (need ~$(( NEEDED_KB / 1024 )) MB)"
  if (( AVAILABLE_KB < NEEDED_KB )); then
    echo
    echo "    releases on disk:"
    du -sh "$RELEASES_DIR"/*/ 2>/dev/null || true
    fail "not enough free disk space to unpack this release.
       Nothing was changed; the live release keeps serving. Free space by hand:
         du -sh ${RELEASES_DIR}/*/         # what takes the room
         ls -1t ${RELEASES_DIR}            # newest first
         rm -rf ${RELEASES_DIR}/<release>  # never the target of ${CURRENT_LINK}"
  fi
fi

# --- 5. unpack into a new release -----------------------------------------
RELEASE="$RELEASES_DIR/$(date +%Y%m%d-%H%M%S)-${COMMIT}"
log "Unpacking release $(basename "$RELEASE")"

mkdir -p "$RELEASE"
# Clean up a half-finished release if anything below fails, so a broken deploy
# does not leave junk that later gets counted as a rollback target — or, worse,
# keeps hundreds of megabytes of a failed unpack occupying the disk.
cleanup_release() {
  if [[ "${RELEASE_LIVE:-0}" != "1" ]] && [[ -d "$RELEASE" ]]; then
    rm -rf -- "$RELEASE"
  fi
}
trap cleanup_release EXIT

tar -xzf "$ARTIFACT" -C "$RELEASE" \
  || fail "could not unpack the artifact (out of disk space? see df -h ${APP_ROOT})"

[[ -f "$RELEASE/apps/api/dist/server.js" ]] || fail "artifact has no apps/api/dist/server.js"
[[ -f "$RELEASE/apps/miniapp/dist/index.html" ]] || fail "artifact has no Mini App build"

cd "$RELEASE"

# Point Prisma at the shared database before any of its commands run.
set -a
# shellcheck disable=SC1091
source "$SHARED_DIR/api.env"
set +a

# --- 6. dependencies -------------------------------------------------------
# Nothing is installed here. `npm ci` used to run at this point and was killed
# by the OOM killer on this VPS: resolving the workspace graph (~13.8k files,
# ~370 MB on disk) needs more memory than the box has. The runner now installs
# the production tree and ships it inside the artifact, so this step is a
# verification rather than an installation.
log "Verifying bundled dependencies"

if [[ "$BUNDLED" == "true" ]]; then
  [[ -d "$RELEASE/node_modules" ]] \
    || fail "artifact claims bundled dependencies but has no node_modules"

  # The workspace link npm would normally create; pack-artifact.mjs replaces it
  # with the real compiled package because a symlink to the runner's checkout
  # would dangle here.
  [[ -f "$RELEASE/node_modules/@shop/shared/dist/index.js" ]] \
    || fail "bundled node_modules is missing the compiled @shop/shared contract"
else
  # Legacy artifact: fall back to installing, accepting the OOM risk.
  log "Legacy artifact without bundled dependencies; installing on the server"
  npm ci --omit=dev --no-audit --no-fund \
    || fail "npm ci failed (this host has little RAM; prefer an artifact with bundled dependencies)"
fi

# Fail loudly here rather than at the first database query. The adapter resolves
# its own nested copy of better-sqlite3, so probe through the adapter itself
# instead of a bare require that may resolve elsewhere. With a bundled tree this
# is also the ABI check: a binary built for another Node major fails right here.
node -e "import('@prisma/adapter-better-sqlite3').then(()=>{},e=>{console.error(e.message);process.exit(1)})" \
  || fail "the bundled SQLite driver did not load; the artifact was likely built for a different Node ABI or platform"

# --- 6. database schema ----------------------------------------------------
log "Applying database schema"
# `db push` only adds missing tables and columns. It never drops data unless the
# schema itself removed something. The Prisma CLI travels inside the artifact,
# so this needs no network and no install.
#
# Full output on failure: `tail -5` used to hide the actual Prisma error.
npm run db:push || fail "prisma db push failed; see the output above"

# Demo banners, so the promo strip is not empty on a fresh install. Only creates
# what is missing and never edits an existing banner, so this is safe to run on
# every deploy: text changed through the API survives.
#
# Not `db:seed`: the full seed also upserts the demo catalog and would overwrite
# real products with samples.
#
# A failure here must not fail the deploy — an empty promo strip is cosmetic,
# and the shop works without it.
# Path is relative to $RELEASE (the release root), not to apps/api: this script
# runs from the release root, unlike the systemd unit which sets
# WorkingDirectory=.../apps/api. DATABASE_URL is absolute in production, so the
# working directory does not affect which database is touched.
log "Seeding demo banners (idempotent)"
node apps/api/dist/cli/seed-banners.js \
  || log "WARNING: banner seeding failed; the promo strip may be empty"

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

# --- 9. prune what the new release displaced -------------------------------
# Most of the work was already done before unpacking. This pass exists because
# the live release has changed since then: the deploy we just replaced is now an
# ordinary directory and becomes the rollback target, so the previous one can go.
log "Pruning old releases (keeping ${KEEP_RELEASES})"
prune_releases "$KEEP_RELEASES"

# Fail loudly if pruning somehow broke the symlink.
[[ -d "$CURRENT_LINK" ]] || fail "current symlink is broken after pruning"

# --- 10. drop the consumed artifact ---------------------------------------
# ~100 MB per deploy that nothing reads again: the release is unpacked, live and
# healthy, and CI uploads a fresh copy on every run. Keeping it only shortens the
# time until the disk fills up again.
#
# Deliberately narrow: only the archive this run consumed and its checksum, and
# only when it sits in incoming/. A path passed explicitly from somewhere else
# belongs to whoever passed it and must not disappear behind their back.
#
# Both sides are resolved with `cd && pwd` so a trailing slash or a symlinked
# APP_ROOT cannot make the comparison silently false.
ARTIFACT_DIR="$(cd "$(dirname "$ARTIFACT")" 2>/dev/null && pwd || true)"
INCOMING_DIR="$(cd "$APP_ROOT/incoming" 2>/dev/null && pwd || true)"

if [[ -n "$ARTIFACT_DIR" && "$ARTIFACT_DIR" == "$INCOMING_DIR" ]]; then
  log "Cleaning up incoming"
  if rm -f -- "$ARTIFACT" "${ARTIFACT}.sha256"; then
    echo "    removed $(basename "$ARTIFACT") and its checksum"
  else
    # Housekeeping only: the release is already live, so this must not fail the
    # deploy.
    echo "    WARNING: could not remove $(basename "$ARTIFACT")"
  fi
fi

df -Ph "$RELEASES_DIR" 2>/dev/null | awk 'NR==2 {printf "    disk: %s used of %s (%s), %s free\n", $3, $2, $5, $4}' || true

log "Deployed ${COMMIT} successfully"
