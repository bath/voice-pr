#!/usr/bin/env bash
# voice-pr bridge daemon control (macOS / launchd).
#
# The bridge (server.js, supervised by serve.js) only ever runs when something
# starts `npm run serve` in a terminal that stays open — so after a reboot or a
# closed shell the extension hits "bridge not reachable". This installs a
# LaunchAgent that runs the supervisor at login and keeps it up, so the bridge is
# just always there. The extension's in-page auto-recover stays the safety net
# for the gaps (daemon not installed yet, a dev restart, launchd's crash-loop
# give-up).
#
#   scripts/daemon.sh install     write + load the LaunchAgent (idempotent)
#   scripts/daemon.sh uninstall   unload + remove it
#   scripts/daemon.sh restart     reload the running agent (use after editing code)
#   scripts/daemon.sh status      show launchd state + probe the bridge
#   scripts/daemon.sh logs        tail the daemon's stdout/stderr
#
# Pointed at THIS checkout: launchd runs scripts/serve.js from the repo this
# script lives in. Edit server.js/lib/* → `npm run daemon:restart` to pick it up.
set -euo pipefail

LABEL="com.voice-pr.bridge"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVE="$REPO/scripts/serve.js"
TEMPLATE="$REPO/scripts/com.voice-pr.bridge.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/.voice-pr"
OUT="$LOGDIR/daemon.out.log"
ERR="$LOGDIR/daemon.err.log"
DOMAIN="gui/$(id -u)"
PORT="${PORT:-4100}"

die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$1"; }
info(){ printf '  %s\n' "$1"; }

# Build a PATH that resolves every binary the bridge shells out to. launchd hands
# jobs a bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so node (often under nvm),
# gh/ffmpeg/whisper-cli (homebrew) and docker would silently fail to spawn. We
# resolve each tool's dir on THIS machine and prepend it, then add the usual
# locations as a backstop. Missing tools are warned about, not fatal — the
# extension preflight surfaces them anyway.
build_path() {
  local dirs=() tool p
  for tool in node gh docker ffmpeg whisper-cli git; do
    if p="$(command -v "$tool" 2>/dev/null)"; then
      dirs+=("$(dirname "$p")")
    else
      printf '\033[33m! %s not found on PATH — the bridge will fail that check until it is installed\033[0m\n' "$tool" >&2
    fi
  done
  # de-dupe, preserve order, then append standard dirs
  local seen="" out="" d
  for d in "${dirs[@]}" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    case ":$seen:" in *":$d:"*) continue;; esac
    seen="$seen:$d"; out="${out:+$out:}$d"
  done
  printf '%s' "$out"
}

resolve_node() {
  local n; n="$(command -v node 2>/dev/null)" || die "node not found — install Node >=20 and retry"
  printf '%s' "$n"
}

render_plist() {
  local node path
  node="$(resolve_node)"
  path="$(build_path)"
  mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
  # sed with a delimiter that can't appear in paths; values have no | or newline.
  sed \
    -e "s|__LABEL__|$LABEL|g" \
    -e "s|__NODE__|$node|g" \
    -e "s|__SERVE__|$SERVE|g" \
    -e "s|__WORKDIR__|$REPO|g" \
    -e "s|__PATH__|$path|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__OUT__|$OUT|g" \
    -e "s|__ERR__|$ERR|g" \
    "$TEMPLATE" > "$PLIST"
}

is_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

unload() { is_loaded && launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; }

probe() {
  # Give the supervisor a moment to bind, then hit the real preflight endpoint.
  local i body
  for i in $(seq 1 10); do
    if body="$(curl -fsS "http://localhost:$PORT/api/preflight" 2>/dev/null)"; then
      printf '%s' "$body"; return 0
    fi
    sleep 0.5
  done
  return 1
}

cmd_install() {
  [ -f "$SERVE" ] || die "supervisor missing at $SERVE — run from a full checkout"
  [ -f "$TEMPLATE" ] || die "plist template missing at $TEMPLATE"
  render_plist
  ok "wrote $PLIST"
  info "node:    $(resolve_node)"
  info "serves:  $SERVE"
  info "PATH:    $(build_path)"
  unload                                   # idempotent: replace any existing agent
  launchctl bootstrap "$DOMAIN" "$PLIST"   # load + RunAtLoad starts it now
  ok "loaded into $DOMAIN"
  if body="$(probe)"; then
    ok "bridge answered on :$PORT"
    printf '  %s\n' "$body"
    printf '\n\033[32mDone.\033[0m The bridge now starts at login and restarts on crash.\n'
    printf '  Edit code → \033[1mnpm run daemon:restart\033[0m   ·   stop → \033[1mnpm run daemon:uninstall\033[0m\n'
  else
    die "loaded, but the bridge did not answer on :$PORT — check: npm run daemon:logs"
  fi
}

cmd_uninstall() {
  unload
  [ -f "$PLIST" ] && rm -f "$PLIST" && ok "removed $PLIST" || true
  ok "daemon stopped and unloaded"
  info "(run \`npm run serve\` manually for dev, or \`npm run daemon:install\` to bring it back)"
}

cmd_restart() {
  is_loaded || die "not loaded — run: npm run daemon:install"
  # Re-render first so an edited PATH/node/repo path is picked up too.
  render_plist
  launchctl kickstart -k "$DOMAIN/$LABEL"
  if probe >/dev/null; then ok "restarted — bridge answering on :$PORT"; else die "restarted, but no answer on :$PORT — see: npm run daemon:logs"; fi
}

cmd_status() {
  if is_loaded; then ok "LaunchAgent loaded ($DOMAIN/$LABEL)"; else printf '\033[33m! not loaded\033[0m — run: npm run daemon:install\n'; fi
  if body="$(curl -fsS "http://localhost:$PORT/api/preflight" 2>/dev/null)"; then
    ok "bridge reachable on :$PORT"; printf '  %s\n' "$body"
  else
    printf '\033[33m! bridge not answering on :%s\033[0m\n' "$PORT"
  fi
}

cmd_logs() {
  printf '── %s ──\n' "$ERR"; tail -n 40 "$ERR" 2>/dev/null || info "(no stderr yet)"
  printf '\n── %s ──\n' "$OUT"; tail -n 40 "$OUT" 2>/dev/null || info "(no stdout yet)"
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  *) die "usage: daemon.sh {install|uninstall|restart|status|logs}" ;;
esac
