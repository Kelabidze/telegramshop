#!/usr/bin/env bash
#
# Synchronises /etc/caddy/Caddyfile with the version committed in this repo.
#
# Usage:
#   bash sync-caddy.sh [apply]     # render, validate, install, reload
#   bash sync-caddy.sh restore     # put the pre-deploy config back
#
# Overridable: DOMAIN, APP_ROOT, CADDY_SRC, STAGING_DIR, LIVE_CONFIG
#
# Why this file exists at all
# ---------------------------
# `deploy/Caddyfile` used to reach the server only through setup-server.sh,
# which runs once at provisioning time. Every later edit stayed in git: the
# `handle /uploads/*` block was committed, never installed, and banner images
# fell through to the SPA fallback — a 200 with index.html where a JPEG was
# expected. The config is part of the deployable state, so a deploy has to
# install it.
#
# Called from two places, deliberately one implementation:
#   - setup-server.sh, as root, during provisioning
#   - deploy.sh, as the unprivileged deploy user, on every deploy
# A second copy of the render/validate/install sequence is exactly how the two
# would drift, and one of them would be the one with the bug.
#
# Order of operations: render to a staging file, validate THAT, and only then
# touch the live config. setup-server.sh used to redirect awk straight into
# /etc/caddy/Caddyfile and validate afterwards, which destroyed a working config
# whenever the new one was broken — Caddy kept serving from memory, so the damage
# only surfaced at the next reload or reboot.

set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/shop}"

# Source of truth: the checkout, which the deploy pins to the commit being
# deployed. Taken from APP_ROOT rather than from $(dirname "$0") so the path is
# identical whether this runs from the clone or from somewhere else.
CADDY_SRC="${CADDY_SRC:-$APP_ROOT/repo/deploy/Caddyfile}"

# Staging lives in a directory the deploy user owns, which is what keeps the
# sudo grants free of wildcards: every privileged command below takes a fixed,
# literal path. Deliberately NOT under shared/ — that directory is a Caddy
# `root`, and a config file next to the uploads it serves is one typo away from
# being downloadable.
STAGING_DIR="${STAGING_DIR:-$APP_ROOT/caddy}"
LIVE_CONFIG="${LIVE_CONFIG:-/etc/caddy/Caddyfile}"

STAGED="$STAGING_DIR/Caddyfile.staged"
ROLLBACK="$STAGING_DIR/Caddyfile.rollback"

# Enough history to see what changed recently without the directory growing
# without bound; the real history is in git.
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"

MODE="${1:-apply}"

log() { printf '    %s\n' "$1"; }
fail() { printf '\nFAILED (caddy sync): %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Privileged command helper.
#
# Root (setup-server.sh) runs the command directly; the deploy user goes through
# sudo with `-n`, so a missing grant fails immediately instead of hanging on a
# password prompt nobody can answer over a non-interactive SSH session.
#
# Every call site passes fixed arguments that match /etc/sudoers.d/shop-deploy
# literally. Changing an argument here without changing the sudoers rule turns
# the deploy into a permission error, which is the intended failure mode: the
# alternative is a wildcard rule that grants far more than this needs.
# ---------------------------------------------------------------------------
as_root() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

# ---------------------------------------------------------------------------
# Which domain the site block should declare.
#
# Derived from PUBLIC_APP_URL in the secrets file, so the domain has exactly one
# source of truth on a provisioned server. A hard-coded default here would be a
# second one, and the two would disagree the first time the domain changed.
# setup-server.sh passes DOMAIN explicitly, which wins.
# ---------------------------------------------------------------------------
resolve_domain() {
  if [[ -n "${DOMAIN:-}" ]]; then
    printf '%s' "$DOMAIN"
    return 0
  fi

  local env_file="$APP_ROOT/shared/api.env" url=''
  if [[ -r "$env_file" ]]; then
    # Read with grep/sed instead of sourcing: this file holds the bot token, and
    # a stray backtick in a secret must not be executed to learn a hostname.
    url="$(sed -n 's/^[[:space:]]*PUBLIC_APP_URL[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -1)"
    url="${url%\"}"; url="${url#\"}"
    url="${url%\'}"; url="${url#\'}"
    url="${url#https://}"
    url="${url#http://}"
    url="${url%%/*}"
    url="${url%%:*}"
  fi

  [[ -n "$url" ]] || fail "could not determine the domain.
       Set PUBLIC_APP_URL in ${env_file}, or pass DOMAIN=example.com."

  printf '%s' "$url"
}

# A hostname, and nothing else. The value is interpolated into a Caddy site
# address, so anything with whitespace or a brace could open a second site block
# or smuggle in a directive. Rejecting early beats debugging a config that
# validates but serves something unintended.
validate_domain() {
  local d="$1"
  [[ "$d" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] \
    || fail "refusing to use '${d}' as a domain: expected a plain hostname."
}

# Rewrites the committed site address to $1. Same awk as setup-server.sh has
# always used, kept here as the only copy: the site address is the first line at
# column zero that ends in `{`.
render() {
  local domain="$1"
  awk -v d="$domain" '
    !done && /^[^[:space:]#].*\{[[:space:]]*$/ { print d " {"; done=1; next }
    { print }
  ' "$CADDY_SRC"
}

# ---------------------------------------------------------------------------
# Validation.
#
# Tries unprivileged first and only escalates if that fails, because the reason
# it might fail is not the config: `caddy validate` provisions the modules the
# config declares, including the file logger writing to /var/log/caddy, which is
# owned by caddy:caddy. An unprivileged run can therefore report a permission
# problem that looks exactly like "your config is broken".
#
# Both attempts failing is a genuinely invalid config, and the unprivileged
# output is what gets shown — the privileged run tends to repeat it.
#
# The upshot is that the sudo grant for validate is a fallback, not a
# requirement: on a server where the unprivileged call succeeds it is never
# used, and it can be dropped from sudoers without touching this script.
# ---------------------------------------------------------------------------
validate_config() {
  local file="$1" output=''

  if output="$(caddy validate --config "$file" 2>&1)"; then
    return 0
  fi

  if [[ $EUID -ne 0 ]] && output="$(sudo -n caddy validate --config "$file" 2>&1)"; then
    log "validated with elevated privileges (unprivileged run could not read Caddy's log directory)"
    return 0
  fi

  printf '%s\n' "$output" >&2
  return 1
}

# Installs $1 as the live config. Ownership and mode are stated explicitly:
# 644 root:root, because the Caddy unit runs as `caddy` and must be able to read
# the file it is configured by. This matches what the distribution package ships.
install_config() {
  as_root install -o root -g root -m 644 "$1" "$LIVE_CONFIG" \
    || fail "could not install ${1} to ${LIVE_CONFIG}.
       The deploy user needs this exact sudo rule (see setup-server.sh):
         install -o root -g root -m 644 ${1} ${LIVE_CONFIG}"
}

reload_caddy() {
  as_root systemctl reload caddy \
    || fail "caddy reload failed. The config on disk is valid and installed, but
       the running process still has the previous one. Check: journalctl -u caddy -n 30"
}

require_staging_dir() {
  if [[ -d "$STAGING_DIR" ]]; then
    return 0
  fi

  # Root can create it; the deploy user cannot create a directory under a root
  # owned parent, and must not silently skip the sync either.
  if [[ $EUID -eq 0 ]]; then
    local owner="${APP_USER:-shop}"
    install -d -o "$owner" -g "$owner" -m 750 "$STAGING_DIR"
    log "created ${STAGING_DIR}"
    return 0
  fi

  fail "${STAGING_DIR} does not exist.
       Provision it once as root:
         sudo install -d -o shop -g shop -m 750 ${STAGING_DIR}"
}

prune_backups() {
  local extra
  # ls -1t is newest-first; everything past the keep count goes.
  #
  # shellcheck disable=SC2012  # parsing ls is safe here: every name this loop
  # can see was written by this script as Caddyfile.bak.<date +%Y%m%d-%H%M%S>,
  # so it holds no whitespace or newline. `find -printf` would sort better but
  # is GNU-only, and sorting by mtime is the whole point.
  while read -r extra; do
    [[ -n "$extra" ]] || continue
    rm -f -- "$STAGING_DIR/$extra"
  done < <(cd "$STAGING_DIR" 2>/dev/null \
    && ls -1t Caddyfile.bak.* 2>/dev/null | tail -n "+$(( KEEP_BACKUPS + 1 ))" || true)
}

# ---------------------------------------------------------------------------
# restore: put back the config that was live before the last apply.
#
# Used by deploy.sh when a release fails its health check and gets rolled back.
# The application returning to the previous release while Caddy keeps a config
# written for the new one is a mismatch nobody would look for.
#
# Validated before installing, like everything else: a rollback that installs a
# broken config has turned one problem into two.
# ---------------------------------------------------------------------------
restore_config() {
  if [[ ! -f "$ROLLBACK" ]]; then
    log "no ${ROLLBACK}; nothing to restore (the config was never changed here)"
    return 0
  fi

  if [[ -f "$LIVE_CONFIG" ]] && cmp -s "$ROLLBACK" "$LIVE_CONFIG"; then
    log "live config already matches the rollback copy; nothing to restore"
    return 0
  fi

  validate_config "$ROLLBACK" \
    || fail "the rollback config does not validate; refusing to install it.
       ${LIVE_CONFIG} is untouched. Inspect ${ROLLBACK} by hand."

  as_root install -o root -g root -m 644 "$ROLLBACK" "$LIVE_CONFIG" \
    || fail "could not restore ${ROLLBACK} to ${LIVE_CONFIG}"

  reload_caddy
  log "restored the previous Caddy config"
}

# ---------------------------------------------------------------------------
# apply
# ---------------------------------------------------------------------------
apply_config() {
  [[ -f "$CADDY_SRC" ]] || fail "source config not found: ${CADDY_SRC}"
  command -v caddy >/dev/null 2>&1 || fail "caddy is not installed on this host"

  local domain
  domain="$(resolve_domain)"
  validate_domain "$domain"
  log "domain: ${domain}"

  require_staging_dir

  # umask so the staged file cannot be world-readable even for the moment it
  # exists: it describes the whole reverse-proxy topology.
  ( umask 027; render "$domain" > "$STAGED" )

  grep -q "^${domain} {" "$STAGED" \
    || fail "failed to set the domain in the rendered config.
       Does ${CADDY_SRC} still start its site block at column 0?"

  # Sanity check on the render, not on the author's intent: an empty or
  # truncated file can still be valid Caddy syntax.
  grep -q 'reverse_proxy' "$STAGED" \
    || fail "the rendered config has no reverse_proxy directive; refusing to install it."

  # Nothing to do is the common case. Skipping here means an ordinary deploy
  # never reloads Caddy, so a config change is a visible event in the log rather
  # than noise on every run — and a needless reload is a needless risk to a
  # process that is currently serving traffic fine.
  if [[ -f "$LIVE_CONFIG" ]] && cmp -s "$STAGED" "$LIVE_CONFIG"; then
    # The rollback copy is refreshed even though nothing is installed: it must
    # hold the config that was live before THIS deploy, and a deploy that
    # changes no config still has one.
    #
    # Without this the file kept whatever the last config-CHANGING deploy
    # displaced. A later deploy that touched no config but failed its health
    # check then rolled Caddy back one deploy too far — onto the config from
    # before the previous, successful change, which the running release had
    # never been served under.
    #
    # No timestamped backup here: nothing is being displaced, and a copy per
    # deploy of an unchanged file would push the real history out of the
    # KEEP_BACKUPS window. A failed refresh drops the stale copy rather than
    # failing a deploy that had no work to do — `restore` then reports nothing
    # to restore, which is the correct outcome when the live config already is
    # what this commit asks for.
    if ! ( umask 027; cp -f "$LIVE_CONFIG" "$ROLLBACK" ); then
      rm -f "$ROLLBACK"
      log "WARNING: could not refresh ${ROLLBACK}; removed it so that a rollback cannot install a stale config"
    fi
    log "already in sync with ${CADDY_SRC}; no validate, no reload"
    return 0
  fi

  log "config differs from ${LIVE_CONFIG}; validating"

  # Validated BEFORE the live config is touched. This is the whole point of the
  # staging file: an invalid config costs a failed deploy, never a broken server.
  validate_config "$STAGED" \
    || fail "the rendered Caddy config is invalid; ${LIVE_CONFIG} was NOT modified.
       The running site is unaffected. Fix deploy/Caddyfile and redeploy."

  log "validation passed"

  # Two copies of the outgoing config, for two different readers: `rollback` is
  # what `restore` reads back, and the timestamped one is for a human comparing
  # what changed. Kept before the install, so a manually edited config that was
  # live until now is preserved.
  if [[ -f "$LIVE_CONFIG" ]]; then
    ( umask 027
      cp -f "$LIVE_CONFIG" "$ROLLBACK"
      cp -f "$LIVE_CONFIG" "$STAGING_DIR/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)" )
    log "saved the current config for rollback"
  else
    # First install: there is nothing to roll back to, and a stale rollback file
    # from an earlier server would be worse than none.
    rm -f "$ROLLBACK"
    log "no existing ${LIVE_CONFIG}; this is a first install"
  fi

  install_config "$STAGED"
  reload_caddy
  prune_backups

  log "Caddy config synchronised and reloaded"
}

case "$MODE" in
  apply) apply_config ;;
  restore) restore_config ;;
  *) fail "unknown mode '${MODE}'; expected 'apply' or 'restore'" ;;
esac
