#!/usr/bin/env bash
# Resolve the session's public URL and publish it to the job summary.
#
# Reads the URL the gateway recorded (DSHGW_URL_FILE). Prints the link and the
# password to the log as well, because the job summary is easy to lose track of
# and the link is the whole deliverable.
set -euo pipefail

url_file="${DSHGW_URL_FILE:-}"
session_url=""
if [ -s "$url_file" ]; then
  session_url=$(head -n 1 "$url_file" | tr -d '[:space:]')
fi
if [ -z "$session_url" ]; then
  session_url="${DSHGW_FALLBACK_URL:-}"
fi

{
  echo "## DeepSeek Harness session"
  echo
  if [ -n "$session_url" ]; then
    echo "**Open:** <${session_url}>"
    echo
    echo 'The link alone is not enough — the page asks for the password below.'
  else
    echo "**No public URL was published.** The tunnel did not come up; check the"
    echo "\`ngrok\` and \`gateway\` steps above."
  fi
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| Password | ${DSHGW_PASSWORD_SHOWN:-<the value you passed in \`password\`>} |"
  if [ -n "${DSHGW_EXPIRES_TEXT:-}" ]; then
    echo "| Closes | ${DSHGW_EXPIRES_TEXT} |"
  fi
  if [ -n "${DSHGW_MODEL_TEXT:-}" ]; then
    echo "| Model | \`${DSHGW_MODEL_TEXT}\` |"
  fi
  echo
  echo "The workspace is \`${DSHGW_WORKSPACE:-/root/default}\` inside the container."
  echo "End the session early with **Cancel workflow**."
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ -n "$session_url" ]; then
  echo "::notice title=DeepSeek Harness is ready::${session_url}"
fi
