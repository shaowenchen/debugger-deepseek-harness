#!/usr/bin/env bash
# Start one ephemeral DeepSeek Harness session: dsh-web container, password
# gateway, and an ngrok tunnel — then keep it alive until the job's timeout.
#
# Why the shape is what it is (verified against dsh 0.1.2-rc.1):
#
#   `dsh web` authenticates with a launch token that it prints in its own log,
#   and the cookie it mints is bound to the request authority. Behind a tunnel
#   the browser's authority is the public host, so that cookie can never be
#   used from outside — and dsh has no password concept at all. The gateway in
#   scripts/gateway.mjs owns both ends: it holds dsh's cookie over loopback (a
#   fixed authority) and gives the browser its own password-backed session.
#
# Networking: the container shares the runner's network namespace, so the
# gateway reaches dsh on 127.0.0.1 and everything binds loopback only. Nothing
# is exposed except through the tunnel.
set -euo pipefail

: "${DSH_IMAGE:=shaowenchen/deepseek-harness-web:latest}"
: "${DSH_CONTAINER:=dsh-session}"
: "${DSH_PORT:=13080}"
: "${DSH_WORKSPACE_DIR:=default}"
: "${DSH_HOME_DIR:=$PWD/.dsh-session-home}"
: "${DSH_SESSION_HOURS:=6}"
: "${DSH_TIMEOUT_MINUTES:=60}"
: "${NGROK_TOKEN:=}"
: "${NGROK_DOMAIN:=}"
: "${DSH_PASSWORD:=}"
: "${DSH_TOKEN:=}"
: "${DSH_BASE_URL:=}"
: "${DSH_MODEL:=}"
: "${DSH_TRUSTED_HOST:=127.0.0.1}"
: "${DSH_EXTRA_ARGS:=}"
: "${DSH_EXTRA_DOCKER_ARGS:=}"
: "${DSH_S3_BUCKET:=}"
: "${DSH_S3_PATH:=}"
: "${DSH_S3_ENDPOINT:=}"
: "${DSH_S3_ACCESS_KEY:=}"
: "${DSH_S3_SECRET_KEY:=}"
: "${DSH_S3_REGION:=}"
: "${DSH_S3_PATH_STYLE:=}"
: "${DSH_LOG_LEVEL:=}"
: "${GITHUB_WORKSPACE_DIR:=${GITHUB_WORKSPACE:-$PWD}}"

GATEWAY_PORT=3080
NGROK_API_PORT=4040
RUNTIME_DIR="$PWD/.dsh-session"
URL_FILE="$RUNTIME_DIR/url.json"
GATEWAY_LOG="$RUNTIME_DIR/gateway.log"

log() { printf '\n\033[1;34m[dsh-action]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[dsh-action]\033[0m %s\n' "$*" >&2; }
die() { printf '\n\033[1;31m[dsh-action]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. inputs ───────────────────────────────────────────────────────────────

API_KEY="${DSH_API_KEY:-}"
[ -n "$API_KEY" ] || die "the 'api_key' input is required (or set the API_KEY secret)"

# A password is optional: an empty one means "generate it" — the session is
# ephemeral, and the generated value is printed for the operator. It is
# deliberately NOT passed through ::add-mask::, because masking a value hides
# it from the very job summary that has to show it; the only place the password
# travels is the gateway's environment, which nothing echoes.
if [ -z "$DSH_PASSWORD" ]; then
  DSH_PASSWORD=$(openssl rand -hex 10)
  log "generated a session password"
fi

if [ -z "$DSH_BASE_URL" ] && [ -z "$DSH_MODEL" ]; then
  MODEL_TEXT="official DeepSeek"
elif [ -n "$DSH_BASE_URL" ] && [ -n "$DSH_MODEL" ]; then
  MODEL_TEXT="$DSH_MODEL @ $DSH_BASE_URL"
else
  # dsh-web's own contract: a custom route needs both halves.
  die "set both 'base_url' and 'model', or neither (neither = official DeepSeek)"
fi

# The API key must never reach the log, including through a docker error.
echo "::add-mask::${API_KEY}"
[ -n "$DSH_S3_SECRET_KEY" ] && echo "::add-mask::${DSH_S3_SECRET_KEY}"
[ -n "$DSH_S3_ACCESS_KEY" ] && echo "::add-mask::${DSH_S3_ACCESS_KEY}"

mkdir -p "$RUNTIME_DIR" "$DSH_HOME_DIR"

DEADLINE=$(( $(date +%s) + DSH_TIMEOUT_MINUTES * 60 ))

log "session model: $MODEL_TEXT"
log "session ends in ${DSH_TIMEOUT_MINUTES} minutes, or when you cancel the workflow"

# ── 2. ngrok ────────────────────────────────────────────────────────────────

PUBLIC_URL_OVERRIDE=""
if [ -n "$NGROK_TOKEN" ]; then
  log "opening the ngrok tunnel (https -> 127.0.0.1:${GATEWAY_PORT})"
  ngrok config add-authtoken "$NGROK_TOKEN" >"$RUNTIME_DIR/ngrok.log" 2>&1 \
    || die "ngrok rejected the authtoken; check the NGROK_TOKEN secret"
  # --log stdout keeps the agent's own output in this job log, so a tunnel
  # failure is diagnosable from the run rather than from a service we cannot see.
  if [ -n "$NGROK_DOMAIN" ]; then
    PUBLIC_URL_OVERRIDE="https://${NGROK_DOMAIN}"
    ngrok http --log stdout --log-format logfmt "--addr=127.0.0.1:${GATEWAY_PORT}" \
      "--domain=${NGROK_DOMAIN}" >"$RUNTIME_DIR/ngrok.log" 2>&1 &
  else
    ngrok http --log stdout --log-format logfmt "--addr=127.0.0.1:${GATEWAY_PORT}" \
      >"$RUNTIME_DIR/ngrok.log" 2>&1 &
  fi
  echo $! > "$RUNTIME_DIR/ngrok.pid"
else
  warn "no ngrok_token given — serving on 127.0.0.1:${GATEWAY_PORT} only, with no public link"
fi

# ── 3. the dsh-web container ────────────────────────────────────────────────

log "starting the dsh-web container from ${DSH_IMAGE}"
docker rm -f "$DSH_CONTAINER" >/dev/null 2>&1 || true

docker_args=(
  run -d --name "$DSH_CONTAINER"
  --network host
  -e "API_KEY=${API_KEY}"
  -e "WORKSPACE_DIR=${DSH_WORKSPACE_DIR}"
  -v "${DSH_HOME_DIR}:/root"
  -v "${GITHUB_WORKSPACE_DIR}:/workspace:ro"
)
[ -n "$DSH_BASE_URL" ] && docker_args+=(-e "BASE_URL=${DSH_BASE_URL}")
[ -n "$DSH_MODEL" ] && docker_args+=(-e "MODEL=${DSH_MODEL}")
[ -n "$DSH_TRUSTED_HOST" ] && docker_args+=(-e "TRUSTED_HOST=${DSH_TRUSTED_HOST}")
[ -n "$DSH_S3_BUCKET" ] && docker_args+=(-e "S3_BUCKET=${DSH_S3_BUCKET}")
[ -n "$DSH_S3_PATH" ] && docker_args+=(-e "S3_PATH=${DSH_S3_PATH}")
[ -n "$DSH_S3_ENDPOINT" ] && docker_args+=(-e "S3_ENDPOINT=${DSH_S3_ENDPOINT}")
[ -n "$DSH_S3_ACCESS_KEY" ] && docker_args+=(-e "S3_ACCESS_KEY=${DSH_S3_ACCESS_KEY}")
[ -n "$DSH_S3_SECRET_KEY" ] && docker_args+=(-e "S3_SECRET_KEY=${DSH_S3_SECRET_KEY}")
[ -n "$DSH_S3_REGION" ] && docker_args+=(-e "S3_REGION=${DSH_S3_REGION}")
[ -n "$DSH_S3_PATH_STYLE" ] && docker_args+=(-e "S3_PATH_STYLE=${DSH_S3_PATH_STYLE}")
[ -n "$DSH_LOG_LEVEL" ] && docker_args+=(-e "LOG_LEVEL=${DSH_LOG_LEVEL}")
# shellcheck disable=SC2086 -- deliberately word-split so a caller can pass several flags
[ -n "$DSH_EXTRA_DOCKER_ARGS" ] && docker_args+=($DSH_EXTRA_DOCKER_ARGS)
# shellcheck disable=SC2086
[ -n "$DSH_EXTRA_ARGS" ] && docker_args+=($DSH_EXTRA_ARGS)

docker "${docker_args[@]}" >/dev/null || die "docker run failed"

# ── 4. the password gateway ─────────────────────────────────────────────────

log "starting the password gateway on 127.0.0.1:${GATEWAY_PORT}"
DSHGW_LISTEN_PORT="$GATEWAY_PORT" \
DSHGW_INNER_AUTHORITY="127.0.0.1:${DSH_PORT}" \
DSHGW_PASSWORD="$DSH_PASSWORD" \
DSHGW_TOKEN="$DSH_TOKEN" \
DSHGW_SESSION_HOURS="$DSH_SESSION_HOURS" \
DSHGW_NGROK_API="http://127.0.0.1:${NGROK_API_PORT}" \
DSHGW_PUBLIC_URL="$PUBLIC_URL_OVERRIDE" \
DSHGW_URL_FILE="$URL_FILE" \
DSHGW_EXPIRES_AT="$DEADLINE" \
  node "$GITHUB_ACTION_PATH/scripts/gateway.mjs" \
    < <(docker logs -f "$DSH_CONTAINER" 2>&1) \
    >"$GATEWAY_LOG" 2>&1 &
echo $! > "$RUNTIME_DIR/gateway.pid"

# ── 5. wait until it answers ────────────────────────────────────────────────

log "waiting for the session to become reachable"
# Readiness is probed over HTTP, not by an open port: dsh answers 401 until a
# session exists, and any answer at all proves it is serving. A port probe
# would also be fooled by an unrelated leftover listener.
# `-w` already prints 000 when curl cannot connect, so no `|| echo` fallback is
# added here — appending one would double the digits ("000000") on failure and
# silently break every comparison.
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null; }
dsh_ready() { [ "$(http_code "http://127.0.0.1:${DSH_PORT}/")" != "000" ]; }
gateway_ready() { [ "$(http_code "http://127.0.0.1:${GATEWAY_PORT}/__dshgw/health")" = "200" ]; }
# A dead gateway must fail the job loudly rather than time out silently.
if ! kill -0 "$(cat "$RUNTIME_DIR/gateway.pid" 2>/dev/null)" 2>/dev/null; then
  sed 's/^/    /' "$GATEWAY_LOG" 2>/dev/null || true
  die "the gateway process did not start"
fi
for _ in $(seq 1 90); do
  if ! docker inspect -f '{{.State.Running}}' "$DSH_CONTAINER" 2>/dev/null | grep -q true; then
    warn "the container exited; last log lines:"
    docker logs --tail 40 "$DSH_CONTAINER" 2>&1 | sed 's/^/    /' || true
    die "the dsh-web container did not stay up"
  fi
  if dsh_ready && gateway_ready; then
    break
  fi
  sleep 2
done
dsh_ready || {
  docker logs --tail 60 "$DSH_CONTAINER" 2>&1 | sed 's/^/    /' || true
  die "dsh is not serving on port ${DSH_PORT}"
}
gateway_ready || { sed 's/^/    /' "$GATEWAY_LOG" 2>/dev/null || true; die "the gateway is not answering on port ${GATEWAY_PORT}"; }

# The gateway records the public URL once ngrok's local API reports the tunnel.
# It writes the URL as a single plain-text line, so reading it needs no tooling.
public_url=""
for _ in $(seq 1 60); do
  if [ -s "$URL_FILE" ]; then
    public_url=$(head -n 1 "$URL_FILE" | tr -d '[:space:]')
    [ -n "$public_url" ] && break
  fi
  sleep 2
done

# ── 6. publish and keep alive ───────────────────────────────────────────────

if [ -n "$public_url" ]; then
  log "session ready: ${public_url}"
else
  warn "the tunnel never reported a public URL; the session is up on 127.0.0.1:${GATEWAY_PORT}"
fi

DSHGW_PASSWORD_SHOWN="$DSH_PASSWORD" \
DSHGW_MODEL_TEXT="$MODEL_TEXT" \
DSHGW_WORKSPACE="/root/${DSH_WORKSPACE_DIR}" \
DSHGW_FALLBACK_URL="http://127.0.0.1:${GATEWAY_PORT}" \
DSHGW_URL_FILE="$URL_FILE" \
DSHGW_EXPIRES_TEXT="$(date -u -d "@${DEADLINE}" '+%Y-%m-%d %H:%M UTC' 2>/dev/null \
  || date -u -r "${DEADLINE}" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || echo '')" \
  "$GITHUB_ACTION_PATH/scripts/session-summary.sh"

echo
echo "======================================================================"
echo " DeepSeek Harness is ready"
echo
echo "   URL:      ${public_url:-http://127.0.0.1:${GATEWAY_PORT} (no tunnel)}"
echo "   Password: ${DSH_PASSWORD}"
echo "   Closes:   ${DSH_TIMEOUT_MINUTES} minutes from start"
echo
echo " The link asks for the password; neither alone gets you in."
echo " End the session early with Cancel workflow."
echo "======================================================================"
echo

# Surface the container's own log in the job for the rest of the session, so a
# crash mid-session is visible in the run instead of only on the user's screen.
docker logs -f "$DSH_CONTAINER" 2>&1 | sed 's/^/[dsh] /' &
echo $! > "$RUNTIME_DIR/logfollow.pid"

cleanup() {
  log "ending the session"
  for pidfile in gateway.pid ngrok.pid logfollow.pid; do
    [ -f "$RUNTIME_DIR/$pidfile" ] && kill "$(cat "$RUNTIME_DIR/$pidfile")" 2>/dev/null || true
  done
  docker rm -f "$DSH_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "session running; it ends at the job timeout or when the workflow is cancelled"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! docker inspect -f '{{.State.Running}}' "$DSH_CONTAINER" 2>/dev/null | grep -q true; then
    warn "the container stopped; see the [dsh] lines above"
    break
  fi
  sleep 10
done

log "session over"
