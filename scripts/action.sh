#!/usr/bin/env bash
# Start one ephemeral DeepSeek Harness session natively on the runner — no
# container — and expose it through a tunnel behind a password.
#
# This script is shared by both actions in this repository (ngrok/action.yml and
# cloudflare/action.yml). They differ only in which tunnel agent they install
# and point at the gateway; everything else — installing dsh, the password
# gateway, the workspace, the session lifetime — is identical, so it lives here
# once and the actions pick a tunnel through DSH_TUNNEL.
#
# dsh is installed with npm and run directly, so the version is chosen by the
# caller and nothing needs an image. The password gateway (scripts/gateway.mjs)
# still sits in front, for the reasons in README: `dsh web` authenticates with a
# launch token printed in its own log, its cookie is bound to the request
# authority (so a cookie minted for loopback can never be presented through a
# tunnel), and its /api route refuses a non-loopback Host.
#
# Because dsh is now a child process rather than a container, this script also
# owns what the image's entrypoint used to: restarting dsh when it exits (a
# plugin install ends the process) and writing the model settings dsh reads.
set -euo pipefail

# The shared scripts live here, not beside whichever action.yml invoked us: the
# actions live in their own subdirectories (ngrok/, cloudflare/) and both use
# this one scripts/ tree. Resolved from this file's own location, so it is
# correct however the actions are checked out — and, unlike $GITHUB_ACTION_PATH,
# it needs no plumbing through each action's env block, where a missing entry
# would silently send the helpers to the wrong directory.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

: "${DSH_VERSION:=0.1.2-rc.1}"
: "${DSH_PORT:=13080}"
# The one directory the session works in, and the one dsh's process runs from.
# The default is a fresh, empty directory of its own under the session home, so a
# session starts on a clean slate and cannot read or modify this repository by
# accident. An absolute path is used as given; any other value is a name resolved
# under the session home.
: "${DSH_WORKSPACE_DIR:=workspace}"
: "${DSH_HOME_DIR:=$PWD/.dsh-session-home}"
# How long the session may run, in hours, from the caller's `session_hours`
# input; empty or 0 means no self-imposed limit.
#
# One number drives both things that expire, and they have to agree: the login
# cookie's lifetime (the gateway's DSHGW_SESSION_HOURS) and this script's own
# deadline below. Letting the cookie outlive the session would hand a browser a
# session that is already over; letting it die first would sign the user out of
# a session still running.
: "${DSH_SESSION_HOURS:=0}"
: "${DSH_PASSWORD:=}"
: "${DSH_API_KEY:=}"
: "${DSH_BASE_URL:=}"
: "${DSH_MODEL:=default}"
: "${DSH_LOG_LEVEL:=}"
: "${DSH_EXTRA_ARGS:=}"
# Which tunnel agent to open. Each action sets this to its own name; there is no
# "none" value, because an action that offers no tunnel would just be this one
# with its credential left blank, which already prints a working loopback URL.
#
# The default matches the one the workflow offers, so a direct invocation of
# this script behaves like the documented default rather than contradicting it:
# cloudflare, whose quick tunnel needs no credential.
: "${DSH_TUNNEL:=cloudflare}"
: "${NGROK_TOKEN:=}"
: "${CLOUDFLARE_TOKEN:=}"

GATEWAY_PORT=3080
# The agents' local APIs. ngrok's inspection API and cloudflared's metrics
# server respectively; the gateway needs the matching one to learn the public
# URL, and each is only asked for by the tunnel that has it.
#
# Both are the *first* address the gateway tries, not the only one: each agent
# steps to the next free port when its default is taken, so the gateway scans a
# short range from here. See TUNNEL_API below.
NGROK_API_PORT=4040
CLOUDFLARED_METRICS_PORT=20241
# Set by whichever tunnel branch runs, before the gateway is started.
TUNNEL_API=""
RUNTIME_DIR="$PWD/.dsh-session"
URL_FILE="$RUNTIME_DIR/url.txt"
GATEWAY_LOG="$RUNTIME_DIR/gateway.log"
DSH_LOG="$RUNTIME_DIR/dsh.log"
# EXPORTED, and that is load-bearing: dsh resolves its home from $DSH_HOME and
# otherwise falls back to `homedir()/.dsh`. As a plain shell variable it reached
# the helpers this script invokes with an inline prefix but never reached dsh
# itself, so the settings.yaml written below landed in a directory dsh does not
# read — the session then started on the official route with the custom provider
# silently absent. Anything this script writes into the dsh home must share the
# same value dsh will resolve, which means exporting it before dsh starts.
export DSH_HOME="$DSH_HOME_DIR/.dsh"

# Resolve the workspace to an absolute path once: a name resolves under the
# session home (the default, `workspace/`), an absolute path is used as given.
# The session home is not the repository, so the default directory is empty.
case "$DSH_WORKSPACE_DIR" in
  /?*) WS_PATH="$DSH_WORKSPACE_DIR" ;;
  *)   WS_PATH="$DSH_HOME_DIR/$DSH_WORKSPACE_DIR" ;;
esac

log() { printf '\n\033[1;34m[dsh-action]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[dsh-action]\033[0m %s\n' "$*" >&2; }
die() { printf '\n\033[1;31m[dsh-action]\033[0m %s\n' "$*" >&2; exit 1; }

mkdir -p "$RUNTIME_DIR" "$DSH_HOME_DIR"

# ── 1. inputs ───────────────────────────────────────────────────────────────

[ -n "$DSH_API_KEY" ] || die "the 'api_key' input is required (or set the API_KEY secret)"

# The password is required and never generated here. An empty one used to mean
# "make one up and print it", which quietly produced a session nobody could sign
# into if the printed value went unread — and made the run's log the only record
# of a credential. The caller is expected to pass its PASSWORD secret, so a
# missing value is a setup mistake worth stopping for, not one to paper over.
#
# It is deliberately NOT masked: masking would hide it from the job summary that
# has to show it, and it only ever travels to the gateway's environment.
[ -n "$DSH_PASSWORD" ] || die "the 'password' input is required (or set the PASSWORD secret)"

# The route is decided by base_url alone. model always has a value (it defaults
# to "default"), so it cannot be the signal for "use the official endpoint".
if [ -z "$DSH_BASE_URL" ]; then
  MODEL_TEXT="official DeepSeek"
else
  MODEL_TEXT="$DSH_MODEL @ $DSH_BASE_URL"
fi

# Credentials must never reach the log, including through a failing command.
echo "::add-mask::${DSH_API_KEY}"

# The session's own deadline, in seconds. 0 (or an unparseable value) means no
# self-imposed limit: the job's `timeout-minutes` is then the only bound, which
# is what "no limit" can mean on a runner that kills the job regardless.
#
# A non-numeric input is treated as "no limit" rather than killing the run: the
# value arrives from a workflow input, and a typo should not be fatal when the
# safe reading is available.
DEADLINE=0
if [[ "$DSH_SESSION_HOURS" =~ ^[0-9]+$ ]] && [ "$DSH_SESSION_HOURS" -gt 0 ]; then
  DEADLINE=$(( $(date +%s) + DSH_SESSION_HOURS * 3600 ))
fi
log "dsh ${DSH_VERSION}"
log "model: $MODEL_TEXT"

# ── 2. install dsh ──────────────────────────────────────────────────────────

# A private npm prefix keeps the install writable without sudo and keeps the
# runner's own global packages untouched.
#
# This is the longest silent stretch of the run (hundreds of packages, about a
# minute) and the step would otherwise show nothing at all while it happens,
# which reads as a hang. npm is quiet when its output is not a tty, so instead
# of asking it for verbose output — hundreds of http-fetch lines that would bury
# the job log — run it in the background and print a heartbeat, keeping the full
# log on disk for the failure path.
NPM_PREFIX="$RUNTIME_DIR/npm"
NPM_LOG="$RUNTIME_DIR/npm.log"
log "installing @deepseek-ai/dsh@${DSH_VERSION} (about a minute)"
npm install --global --prefix "$NPM_PREFIX" --no-audit --no-fund \
  "@deepseek-ai/dsh@${DSH_VERSION}" >"$NPM_LOG" 2>&1 &
npm_pid=$!
elapsed=0
while kill -0 "$npm_pid" 2>/dev/null; do
  sleep 2
  elapsed=$((elapsed + 2))
  kill -0 "$npm_pid" 2>/dev/null || break
  if [ $((elapsed % 10)) -eq 0 ]; then log "  still installing... ${elapsed}s"; fi
done
if ! wait "$npm_pid"; then
  tail -n 30 "$NPM_LOG" | sed 's/^/    /' || true
  die "could not install @deepseek-ai/dsh@${DSH_VERSION}; check that the version exists"
fi
export PATH="$NPM_PREFIX/bin:$PATH"
command -v dsh >/dev/null || die "dsh was installed but is not on PATH"
log "installed: $(dsh --version 2>/dev/null || echo "$DSH_VERSION")"

# ── 3. the tunnel ───────────────────────────────────────────────────────────
#
# Which agent runs is the only real difference between the two actions, so it is
# a dispatch here rather than a second copy of this whole script. Both branches
# end in the same three things: mirror the agent's output into the job log,
# confirm it survived startup, and leave a pidfile for cleanup.

TUNNEL_LOG="$RUNTIME_DIR/tunnel.log"
tunnel_pid=""
tunnel_name="$DSH_TUNNEL"

# The agent's own output is mirrored into the job log, not just left in a file:
# when a tunnel fails, its reason is the only thing that explains why, and a
# file nobody prints hides exactly that. Tailing the file (rather than piping
# the process) keeps the pidfile pointing at the agent itself, so cleanup stops
# the agent rather than the `tail`. `-u` because the job log is not a tty:
# without it sed block-buffers and the agent's output arrives in bursts instead
# of as it happens, which is the opposite of what mirroring it is for.
mirror_tunnel_log() {
  for _ in $(seq 1 50); do [ -f "$TUNNEL_LOG" ] && break; sleep 0.1; done
  tail -f "$TUNNEL_LOG" 2>/dev/null | sed -u "s/^/[${tunnel_name}] /" &
  echo $! > "$RUNTIME_DIR/tunnellog.pid"
}

# A usage error makes an agent exit instantly, and without this check the only
# symptom is a missing link minutes later.
confirm_tunnel_alive() {
  sleep 3
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then
    sed 's/^/    /' "$TUNNEL_LOG" 2>/dev/null || true
    die "the ${tunnel_name} agent exited during startup; its output is above"
  fi
}

start_ngrok_tunnel() {
  # ngrok's inspection API, which is where its public URL is read from.
  TUNNEL_API="http://127.0.0.1:${NGROK_API_PORT}"
  if [ -z "$NGROK_TOKEN" ]; then
    warn "no ngrok_token given — serving on 127.0.0.1:${GATEWAY_PORT} only, with no public link"
    return 0
  fi

  log "opening the ngrok tunnel (https -> 127.0.0.1:${GATEWAY_PORT})"
  ngrok config add-authtoken "$NGROK_TOKEN" >"$TUNNEL_LOG" 2>&1 \
    || { sed 's/^/    /' "$TUNNEL_LOG" 2>/dev/null || true
         die "ngrok rejected the authtoken; check the NGROK_TOKEN secret"; }

  # `ngrok http <port>`: the port is a positional argument. It is not an
  # `--addr` flag — passing one made the agent exit with a usage error before
  # any tunnel existed, which is why the link never appeared.
  ngrok http "$GATEWAY_PORT" >>"$TUNNEL_LOG" 2>&1 &
  tunnel_pid=$!
  echo "$tunnel_pid" > "$RUNTIME_DIR/tunnel.pid"

  mirror_tunnel_log
  confirm_tunnel_alive
}

start_cloudflare_tunnel() {
  # `--no-autoupdate` because cloudflared otherwise checks for and installs a
  # newer build of itself mid-run; a self-replacement during a live session is
  # not a surprise worth having.
  #
  # The metrics port is deliberately NOT pinned with `--metrics`. Unpinned,
  # cloudflared binds the first free port in 20241-20245 and steps past a busy
  # one; pinned, a busy port is fatal — it logs "address already in use" and
  # exits without registering a single connection. Since the gateway scans that
  # same five-port range (and this script's TUNNEL_API is only the scan's
  # starting point), leaving it unpinned costs nothing and cannot kill the
  # tunnel. If all five are taken the gateway falls back to the agent's log.
  local base=(cloudflared tunnel --no-autoupdate)
  TUNNEL_API="http://127.0.0.1:${CLOUDFLARED_METRICS_PORT}"

  if [ -n "$CLOUDFLARE_TOKEN" ]; then
    # A named tunnel. Its ingress — which local service the public hostname
    # maps to — lives in the Cloudflare dashboard, NOT here: for a
    # remotely-managed tunnel the dashboard's config is authoritative and
    # overrides anything the command line would say about it. Point the
    # tunnel's public hostname at http://localhost:${GATEWAY_PORT} there.
    log "opening the Cloudflare named tunnel -> 127.0.0.1:${GATEWAY_PORT}"
    "${base[@]}" run --token "$CLOUDFLARE_TOKEN" >"$TUNNEL_LOG" 2>&1 &
  else
    log "opening a Cloudflare quick tunnel (https -> 127.0.0.1:${GATEWAY_PORT})"
    # trycloudflare.com: no account, no login, no cert.pem. The hostname is
    # minted per connection, which is why the gateway reads it back from the
    # agent rather than being told it.
    "${base[@]}" --url "http://127.0.0.1:${GATEWAY_PORT}" >"$TUNNEL_LOG" 2>&1 &
  fi
  tunnel_pid=$!
  echo "$tunnel_pid" > "$RUNTIME_DIR/tunnel.pid"

  mirror_tunnel_log
  confirm_tunnel_alive

  # A named tunnel cannot report its own hostname: Cloudflare routes to the
  # connector without ever telling it the public name, so neither the metrics
  # API nor the log has it. There is no input to supply one either — the
  # hostname is the one already configured in the dashboard, so the session
  # still works, but its link has to be read from there rather than from this
  # log. Say that now, because the symptom otherwise is a session that looks
  # fine and a link that never appears.
  if [ -n "$CLOUDFLARE_TOKEN" ]; then
    warn "this is a named tunnel: Cloudflare does not tell the connector its own"
    warn "hostname, so the public link cannot be discovered here. Use the hostname"
    warn "you configured for this tunnel in the dashboard, and make sure it routes"
    warn "to http://localhost:${GATEWAY_PORT}. The session itself is up either way."
  fi
}

case "$DSH_TUNNEL" in
  ngrok)      start_ngrok_tunnel ;;
  cloudflare) start_cloudflare_tunnel ;;
  *)          die "unknown DSH_TUNNEL '${DSH_TUNNEL}'; expected 'ngrok' or 'cloudflare'" ;;
esac

# ── 4. model settings ───────────────────────────────────────────────────────

# Write the model selection into settings.yaml, the file dsh reads at startup.
# dsh has no model flag, so this file is the only way the caller's choice
# reaches the session — see scripts/settings.mjs for the two routes it writes.
#
# It runs on BOTH routes, not only the custom one. On the official route it
# records just the default-model selection, and only when the caller named a
# model: with none, staying silent leaves dsh its own default rather than
# pinning a model id this action would then have to track.
mkdir -p "$DSH_HOME"
DSH_API_KEY="$DSH_API_KEY" DSH_BASE_URL="$DSH_BASE_URL" DSH_MODEL="$DSH_MODEL" \
DSH_HOME="$DSH_HOME" node "$SCRIPT_DIR/settings.mjs" \
  || die "could not write the model configuration to $DSH_HOME/settings.yaml"

# The credential travels in the environment variable each route's provider
# declares: the custom block names API_KEY through apiKeyEnv, while
# llm-deepseek resolves DEEPSEEK_API_KEY by default.
if [ -n "$DSH_BASE_URL" ]; then
  export API_KEY="$DSH_API_KEY"
else
  export DEEPSEEK_API_KEY="$DSH_API_KEY"
fi

# ── 5. seed the workspace ───────────────────────────────────────────────────
#
# A fresh dsh boots with an EMPTY workspace registry (verified: it writes
# storages/workspace.json with `workspaceIds: []`), which puts the web UI's
# directory picker between the password and the first prompt. Seeding it means
# signing in lands inside a workspace and the first prompt can be typed at once.
#
# dsh owns this file and rewrites it freely, so a seed is only ever needed when
# the file is absent or holds no workspace.
seed_workspace() {
  local store="$DSH_HOME/storages/workspace.json"
  local ws_path="$WS_PATH"
  local ws_id

  # Parsed as JSON, not pattern-matched: dsh writes this file pretty-printed,
  # so a single-line grep for `"workspaceIds": [...]` never matches and every
  # run would re-seed, handing the UI a second empty workspace.
  if [ -f "$store" ] && node -e '
    const fs = require("node:fs")
    let d
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch { process.exit(1) }
    process.exit((d?.global?.workspaceIds ?? []).length > 0 ? 0 : 1)
  ' "$store" 2>/dev/null; then
    log "the dsh home already has a workspace; leaving it alone"
    return 0
  fi

  # dsh canonicalizes with realpath and refuses a workspace whose directory is
  # missing, so create the directory first.
  mkdir -p "$ws_path" "$DSH_HOME/storages"
  ws_id=$(node -e 'console.log(require("node:crypto").randomUUID())')
  ws_id="$ws_id" ws_path="$ws_path" node -e '
    const fs = require("node:fs")
    const now = new Date().toISOString()
    const id = process.env.ws_id
    const path = process.env.ws_path
    const doc = {
      unit: { name: "workspace", version: 2 },
      global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
      tables: { workspaces: { [id]: {
        path, title: path.split("/").filter(Boolean).pop() ?? path,
        sessionIds: [], createdAt: now, updatedAt: now,
      } } },
    }
    fs.writeFileSync(process.argv[1], JSON.stringify(doc, null, 2) + "\n")
  ' "$store" || { warn "could not seed the workspace; the UI will show its directory picker"; return 0; }
  log "seeded the workspace at ${ws_path}"
}

seed_workspace

# ── 6. enter the workspace ──────────────────────────────────────────────────
#
# The registry above decides which directory the SESSION works in. This decides
# where the PROCESS runs, and dsh reads `process.cwd()` in several load-bearing
# places: the sandbox policy's `workspaceRoot`, a session's fallback cwd when it
# names no workspace, the bash and fs tools' `workdir`, and `loadLayeredEnv`,
# which loads a `.env` from the invoking directory at boot.
#
# Leaving the process in the runner's working directory therefore left the
# repository behind all of those fallbacks even though the registry pointed at
# the empty workspace: the session *worked* in the empty directory while the
# process — and every path it could fall back to — stayed rooted in the
# checkout, where a `.env` would be loaded into dsh's own environment. Starting
# dsh from inside the workspace makes the two agree, so there is one working
# directory and it is the empty one.
#
# `cd` is safe from here because every path this script uses below is absolute:
# the home, runtime, and log paths were all resolved against the runner's
# directory before this point.
mkdir -p "$WS_PATH"
cd "$WS_PATH" || die "could not enter the workspace at ${WS_PATH}"
log "dsh will run from ${WS_PATH}"

# ── 7. run dsh, restarting it when it exits ─────────────────────────────────

# A plugin install ends the dsh process by design (the container image wraps it
# in the same loop). Without this the session would die the first time the user
# installed anything.
#
# dsh refuses --host 0.0.0.0 on purpose; it does not need it here, because the
# gateway reaches it over loopback on this same machine.
start_dsh() {
  local args=(--profile web --no-open --port "$DSH_PORT")
  if [ -n "$DSH_EXTRA_ARGS" ]; then
    read -ra extra <<< "$DSH_EXTRA_ARGS"
    args+=("${extra[@]}")
  fi
  log "starting dsh on 127.0.0.1:${DSH_PORT}"
  {
    printf 'dsh-action: starting dsh %s\n' "$DSH_VERSION"
    while true; do
      dsh "${args[@]}" 2>&1 || true
      printf 'dsh-action: dsh exited; restarting in 2s\n'
      sleep 2
    done
  } >> "$DSH_LOG" 2>&1 &
  echo $! > "$RUNTIME_DIR/dsh.pid"
}

start_dsh
# Wait for the log file to exist before anything tails it.
for _ in $(seq 1 20); do [ -f "$DSH_LOG" ] && break; sleep 0.5; done

# ── 8. the password gateway ─────────────────────────────────────────────────

log "starting the password gateway on 127.0.0.1:${GATEWAY_PORT}"
DSHGW_LISTEN_PORT="$GATEWAY_PORT" \
DSHGW_INNER_AUTHORITY="127.0.0.1:${DSH_PORT}" \
DSHGW_PASSWORD="$DSH_PASSWORD" \
DSHGW_SESSION_HOURS="$DSH_SESSION_HOURS" \
DSHGW_TUNNEL="$DSH_TUNNEL" \
DSHGW_TUNNEL_API="$TUNNEL_API" \
DSHGW_TUNNEL_LOG="$TUNNEL_LOG" \
DSHGW_URL_FILE="$URL_FILE" \
  node "$SCRIPT_DIR/gateway.mjs" \
    < <(tail -f -n +1 "$DSH_LOG" 2>/dev/null) \
    >"$GATEWAY_LOG" 2>&1 &
echo $! > "$RUNTIME_DIR/gateway.pid"

# Mirror the gateway's log into the job from here on. It carries three things
# the job log would otherwise never show: the gateway's own messages, its
# token/cookie exchanges, and — because the gateway echoes every dsh line it
# reads from stdin — dsh's output too. Without this the step prints nothing
# between "starting the password gateway" and the finished summary, which reads
# as a hang. It also replaces a separate `tail -f` of the dsh log further down,
# which would have shown the same lines a second time.
for _ in $(seq 1 50); do [ -f "$GATEWAY_LOG" ] && break; sleep 0.1; done
tail -f "$GATEWAY_LOG" 2>/dev/null | sed -u 's/^/[gateway] /' &
echo $! > "$RUNTIME_DIR/gatewaylog.pid"

# ── 9. wait until it answers ────────────────────────────────────────────────

log "waiting for the session to become reachable"
# Probed over HTTP, not by an open port: an answer of any kind proves dsh is
# serving, and a bare port check would also be fooled by a leftover listener.
# `-w` already prints 000 when curl cannot connect, so no `|| echo` fallback —
# appending one would double the digits and break every comparison.
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null; }
dsh_ready() { [ "$(http_code "http://127.0.0.1:${DSH_PORT}/")" != "000" ]; }
gateway_ready() { [ "$(http_code "http://127.0.0.1:${GATEWAY_PORT}/__dshgw/health")" = "200" ]; }

if ! kill -0 "$(cat "$RUNTIME_DIR/gateway.pid" 2>/dev/null)" 2>/dev/null; then
  sed 's/^/    /' "$GATEWAY_LOG" 2>/dev/null || true
  die "the gateway process did not start"
fi
# dsh boots in a second or two and the gateway answers as soon as it is up, so
# this normally ends on the first pass. The heartbeat covers the case where it
# does not: a silent three-minute wait is indistinguishable from a hang, and
# naming which side is still missing says where to look.
for attempt in $(seq 1 90); do
  if dsh_ready && gateway_ready; then break; fi
  if [ $((attempt % 15)) -eq 0 ]; then
    dsh_state=no
    gateway_state=no
    if dsh_ready; then dsh_state=yes; fi
    if gateway_ready; then gateway_state=yes; fi
    log "  waiting... dsh_up=${dsh_state} gateway_up=${gateway_state}"
  fi
  sleep 2
done
dsh_ready || {
  tail -n 40 "$DSH_LOG" 2>/dev/null | sed 's/^/    /' || true
  die "dsh is not serving on port ${DSH_PORT}"
}
gateway_ready || { sed 's/^/    /' "$GATEWAY_LOG" 2>/dev/null || true; die "the gateway is not answering on port ${GATEWAY_PORT}"; }

# ── 10. publish, then stay alive ────────────────────────────────────────────

public_url=""
log "waiting for the tunnel to report a public URL"
# The gateway writes the URL once the ngrok API reports a tunnel; it polls for
# up to three minutes, so wait at least that long here or this loop gives up
# while the gateway is still looking and reports a tunnel that then appears.
for attempt in $(seq 1 190); do
  if [ -s "$URL_FILE" ]; then
    public_url=$(head -n 1 "$URL_FILE" | tr -d '[:space:]')
    [ -n "$public_url" ] && break
  fi
  # The gateway dying is worth reporting now rather than after three minutes.
  kill -0 "$(cat "$RUNTIME_DIR/gateway.pid" 2>/dev/null)" 2>/dev/null || break
  if [ $((attempt % 20)) -eq 0 ]; then
    log "  still waiting for the tunnel... ${attempt}s"
  fi
  sleep 1
done

if [ -n "$public_url" ]; then
  log "session ready: ${public_url}"
else
  warn "the tunnel never reported a public URL; the session is up on 127.0.0.1:${GATEWAY_PORT}"
  # The reason is in the agent's log, and it is no use unread.
  if [ -f "$TUNNEL_LOG" ]; then
    warn "${tunnel_name} said:"
    tail -n 20 "$TUNNEL_LOG" | sed 's/^/    /'
  else
    # No log at all means the agent never even started, which for both agents
    # means this action's credential input was left blank.
    warn "${tunnel_name} produced no output; was its token input set?"
  fi
  if [ -n "$tunnel_pid" ] && kill -0 "$tunnel_pid" 2>/dev/null; then
    warn "the ${tunnel_name} agent is still running, so the tunnel exists but its local API did not answer on ${TUNNEL_API}"
  else
    warn "the ${tunnel_name} agent is not running — see its output above for why"
  fi
fi

DSHGW_PASSWORD_SHOWN="$DSH_PASSWORD" \
DSHGW_MODEL_TEXT="$MODEL_TEXT" \
DSHGW_VERSION_TEXT="$DSH_VERSION" \
DSHGW_WORKSPACE="$WS_PATH" \
DSHGW_TUNNEL_NAME="$tunnel_name" \
DSHGW_FALLBACK_URL="http://127.0.0.1:${GATEWAY_PORT}" \
DSHGW_URL_FILE="$URL_FILE" \
  "$SCRIPT_DIR/session-summary.sh"

echo
echo "======================================================================"
echo " DeepSeek Harness is ready"
echo
echo "   URL:      ${public_url:-http://127.0.0.1:${GATEWAY_PORT} (no tunnel)}"
echo "   Password: ${DSH_PASSWORD}"
echo
echo " The link asks for the password; neither alone gets you in."
echo " The session stays up until you cancel the workflow or the job times out."
echo "======================================================================"
echo

# The gateway log is already being mirrored into the job (see above), and it
# carries dsh's output as well, so there is nothing to tail here.

cleanup() {
  log "ending the session"
  for pidfile in gateway.pid gatewaylog.pid tunnel.pid tunnellog.pid dsh.pid; do
    [ -f "$RUNTIME_DIR/$pidfile" ] && kill "$(cat "$RUNTIME_DIR/$pidfile")" 2>/dev/null || true
  done
  # The dsh loop's own children outlive the loop's pid; kill the process group
  # members by name as a backstop.
  pkill -f "@deepseek-ai/dsh" 2>/dev/null || true
}
trap cleanup EXIT

if [ "$DEADLINE" -gt 0 ]; then
  log "session running; it ends at the ${DSH_SESSION_HOURS}h limit, the job timeout, or when the workflow is cancelled"
else
  log "session running with no self-imposed limit; it ends at the job timeout or when the workflow is cancelled"
fi
# A DEADLINE of 0 means "no self-imposed limit": the loop then runs until the
# dsh process dies or the job is cancelled, which is the only kind of "no limit"
# a runner that kills the job anyway can offer.
while [ "$DEADLINE" -eq 0 ] || [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! kill -0 "$(cat "$RUNTIME_DIR/dsh.pid" 2>/dev/null)" 2>/dev/null; then
    warn "the dsh runner stopped; see the [dsh] lines above"
    break
  fi
  sleep 10
done

log "session over"
