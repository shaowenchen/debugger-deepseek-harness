#!/usr/bin/env bash
# Start one ephemeral DeepSeek Harness session natively on the runner — no
# container — and expose it through an ngrok tunnel behind a password.
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

: "${DSH_VERSION:=0.1.2-rc.1}"
: "${DSH_PORT:=13080}"
# The directory the session works in. The default is a fresh, empty directory of
# its own under the session home, so a session starts on a clean slate and
# cannot read or modify this repository by accident. An absolute path is used as
# given; any other value is a name resolved under the session home.
: "${DSH_WORKSPACE_DIR:=workspace}"
: "${DSH_HOME_DIR:=$PWD/.dsh-session-home}"
: "${DSH_SESSION_HOURS:=6}"
# No session-length input: the job's own timeout-minutes is the deadline.
: "${DSH_TIMEOUT_MINUTES:=360}"
: "${DSH_PASSWORD:=}"
: "${DSH_API_KEY:=}"
: "${DSH_BASE_URL:=}"
: "${DSH_MODEL:=default}"
: "${DSH_LOG_LEVEL:=}"
: "${DSH_EXTRA_ARGS:=}"
: "${NGROK_TOKEN:=}"

GATEWAY_PORT=3080
NGROK_API_PORT=4040
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

# A password is optional: empty means generate one and print it. It is
# deliberately NOT masked, because masking would hide it from the job summary
# that has to show it — it only ever travels to the gateway's environment.
if [ -z "$DSH_PASSWORD" ]; then
  DSH_PASSWORD=$(node -e 'console.log(require("node:crypto").randomBytes(10).toString("hex"))')
  log "generated a session password"
fi

# The route is decided by base_url alone. model always has a value (it defaults
# to "default"), so it cannot be the signal for "use the official endpoint".
if [ -z "$DSH_BASE_URL" ]; then
  MODEL_TEXT="official DeepSeek"
else
  MODEL_TEXT="$DSH_MODEL @ $DSH_BASE_URL"
fi

# Credentials must never reach the log, including through a failing command.
echo "::add-mask::${DSH_API_KEY}"

DEADLINE=$(( $(date +%s) + DSH_TIMEOUT_MINUTES * 60 ))
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

# ── 3. ngrok ────────────────────────────────────────────────────────────────

if [ -n "$NGROK_TOKEN" ]; then
  log "opening the ngrok tunnel (https -> 127.0.0.1:${GATEWAY_PORT})"
  ngrok config add-authtoken "$NGROK_TOKEN" >"$RUNTIME_DIR/ngrok.log" 2>&1 \
    || { sed 's/^/    /' "$RUNTIME_DIR/ngrok.log" 2>/dev/null || true
         die "ngrok rejected the authtoken; check the NGROK_TOKEN secret"; }

  # `ngrok http <port>`: the port is a positional argument. It is not an
  # `--addr` flag — passing one made the agent exit with a usage error before
  # any tunnel existed, which is why the link never appeared.
  ngrok http "$GATEWAY_PORT" >"$RUNTIME_DIR/ngrok.log" 2>&1 &
  ngrok_pid=$!
  echo $ngrok_pid > "$RUNTIME_DIR/ngrok.pid"

  # The agent's own output is mirrored into the job log, not just left in a
  # file: when a tunnel fails, its reason is the only thing that explains why,
  # and a file nobody prints hides exactly that. Tailing the file (rather than
  # piping the process) keeps ngrok.pid pointing at ngrok, so cleanup stops it.
  # `tail -f` needs the file to exist, and the shell creates it a moment later.
  for _ in $(seq 1 50); do [ -f "$RUNTIME_DIR/ngrok.log" ] && break; sleep 0.1; done
  # `-u` because the job log is not a tty: without it sed block-buffers and the
  # agent's output arrives in bursts instead of as it happens, which is the
  # opposite of what mirroring it is for.
  tail -f "$RUNTIME_DIR/ngrok.log" 2>/dev/null | sed -u 's/^/[ngrok] /' &
  echo $! > "$RUNTIME_DIR/ngroklog.pid"

  # A usage error makes the agent exit instantly, and without this check the
  # only symptom is a missing link minutes later. Confirm it survived startup.
  sleep 3
  if ! kill -0 "$ngrok_pid" 2>/dev/null; then
    sed 's/^/    /' "$RUNTIME_DIR/ngrok.log" 2>/dev/null || true
    die "the ngrok agent exited during startup; its output is above"
  fi
else
  warn "no ngrok_token given — serving on 127.0.0.1:${GATEWAY_PORT} only, with no public link"
fi

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
DSH_HOME="$DSH_HOME" node "$GITHUB_ACTION_PATH/scripts/settings.mjs" \
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

# ── 6. run dsh, restarting it when it exits ─────────────────────────────────

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

# ── 7. the password gateway ─────────────────────────────────────────────────

log "starting the password gateway on 127.0.0.1:${GATEWAY_PORT}"
DSHGW_LISTEN_PORT="$GATEWAY_PORT" \
DSHGW_INNER_AUTHORITY="127.0.0.1:${DSH_PORT}" \
DSHGW_PASSWORD="$DSH_PASSWORD" \
DSHGW_SESSION_HOURS="$DSH_SESSION_HOURS" \
DSHGW_NGROK_API="http://127.0.0.1:${NGROK_API_PORT}" \
DSHGW_URL_FILE="$URL_FILE" \
  node "$GITHUB_ACTION_PATH/scripts/gateway.mjs" \
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

# ── 8. wait until it answers ────────────────────────────────────────────────

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

# ── 9. publish, then stay alive ─────────────────────────────────────────────

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
  # The reason is in one of these two logs, and neither is much use unread.
  if [ -f "$RUNTIME_DIR/ngrok.log" ]; then
    warn "ngrok said:"
    tail -n 20 "$RUNTIME_DIR/ngrok.log" | sed 's/^/    /'
  else
    # No log at all means the agent never even started.
    warn "ngrok produced no output; is the NGROK_TOKEN secret set?"
  fi
  if kill -0 "$(cat "$RUNTIME_DIR/ngrok.pid" 2>/dev/null)" 2>/dev/null; then
    warn "the ngrok agent is still running, so the tunnel exists but its local API did not answer on ${NGROK_API_PORT}"
  else
    warn "the ngrok agent has exited — see its output above for why"
  fi
fi

DSHGW_PASSWORD_SHOWN="$DSH_PASSWORD" \
DSHGW_MODEL_TEXT="$MODEL_TEXT" \
DSHGW_VERSION_TEXT="$DSH_VERSION" \
DSHGW_WORKSPACE="$WS_PATH" \
DSHGW_FALLBACK_URL="http://127.0.0.1:${GATEWAY_PORT}" \
DSHGW_URL_FILE="$URL_FILE" \
  "$GITHUB_ACTION_PATH/scripts/session-summary.sh"

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
  for pidfile in gateway.pid gatewaylog.pid ngrok.pid ngroklog.pid dsh.pid; do
    [ -f "$RUNTIME_DIR/$pidfile" ] && kill "$(cat "$RUNTIME_DIR/$pidfile")" 2>/dev/null || true
  done
  # The dsh loop's own children outlive the loop's pid; kill the process group
  # members by name as a backstop.
  pkill -f "@deepseek-ai/dsh" 2>/dev/null || true
}
trap cleanup EXIT

log "session running; it ends at the job timeout or when the workflow is cancelled"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! kill -0 "$(cat "$RUNTIME_DIR/dsh.pid" 2>/dev/null)" 2>/dev/null; then
    warn "the dsh runner stopped; see the [dsh] lines above"
    break
  fi
  sleep 10
done

log "session over"
