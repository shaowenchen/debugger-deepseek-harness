# debugger-deepseek-harness

Start an ephemeral **DeepSeek Harness** (`dsh`) web session from GitHub Actions,
hand yourself a temporary link, and sign in with a password.

It combines two projects:

- **[debugger-action](https://github.com/shaowenchen/debugger-action)** — the
  "give me a disposable box to poke at from a workflow run" idea, and its ngrok
  tunnel setup.
- **[deepseek-harness-web](https://github.com/shaowenchen/deepseek-harness-web)** —
  the single-container `dsh` web image with model routing and optional S3
  persistence.

What you get: a run that prints something like

```
https://1a2b-3c4d.ngrok-free.app     password: 9f3c1a7e20b845dd1c9e
```

Open the link, type the password, and you are in the harness — in your browser,
from anywhere.

## Quick start

## Secrets

Every one of these is a **default**. Leave the matching field empty on the
Run-workflow form and the secret is used; fill the field in and that value wins
for that one run.

| Secret | Required | Used when the field is empty | What it is |
|---|---|---|---|
| `API_KEY` | yes | always | Your model API key |
| `PASSWORD` | yes | always | The password you sign in with |
| `NGROK_TOKEN` | for a link | always | An [ngrok authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) |
| `BASE_URL` | no | `base_url` empty | Gateway address; empty = official DeepSeek |
| `MODEL` | no | `model` empty | Model id(s), comma-separated; the first is the default |
| `NGROK_DOMAIN` | no | `ngrok_domain` empty | Reserved ngrok domain, e.g. `my-dsh.ngrok.app` |

`API_KEY` and `PASSWORD` have no input at all: they are secrets from end to end,
because a workflow input is plain text in the run payload. The other four are
offered as inputs as well because an address, a model id, and a domain name are
not credentials.

Create them under **Settings → Secrets and variables → Actions → Secrets**.

## Quick start

Add `API_KEY`, `PASSWORD`, and `NGROK_TOKEN`. Then: **Actions → DeepSeek
Harness → Run workflow**. Open the link from the run's **Summary**, type your
password, and start working — the session opens on a ready workspace, so there
is nothing to set up first.

The session ends when you hit **Cancel workflow**, or when the job's
`timeout-minutes` fires — there is no "duration" knob to set, because the job
timeout already is one. Nothing survives the end of the run unless you configure
S3 (below) — each session starts from a clean workspace.

## Model routing

Three values decide which model answers, and they map one-to-one onto what
`dsh` itself takes:

| | Where it comes from | Notes |
|---|---|---|
| **Base URL** | `BASE_URL` secret, or the `base_url` field for one run | Empty = the official DeepSeek endpoint |
| **Model** | `MODEL` secret, or the `model` field for one run | Comma-separated for several; the first is the default |
| **API key** | the `API_KEY` secret, and nothing else | Never an input — workflow inputs are plain text in the run |

To point at your own gateway, set the `BASE_URL` and `MODEL` secrets once. Leave
both unset to use the official DeepSeek endpoint, where `API_KEY` is your
DeepSeek key. Setting only one is an error the action reports before it starts
anything, rather than letting `dsh` fail later on a half-configured route.

```yaml
# one run against a different model, no secret edits:
gh workflow run dsh.yml -f model=some-other-model
```

## Using it from another repository

```yaml
name: dsh
on:
  workflow_dispatch:

jobs:
  dsh:
    runs-on: ubuntu-latest
    timeout-minutes: 60          # the session's lifetime
    steps:
      - uses: actions/checkout@v4
      - uses: shaowenchen/debugger-deepseek-harness@main
        with:
          api_key: ${{ secrets.API_KEY }}
          password: ${{ secrets.PASSWORD }}
          ngrok_token: ${{ secrets.NGROK_TOKEN }}
          base_url: ${{ secrets.BASE_URL }}   # omit for official DeepSeek
          model: ${{ secrets.MODEL }}         # omit with base_url
```

The checkout is mounted read-only at `/workspace` inside the session, so the
agent can read the code you started it for. Set `mount_repo: false` to leave it
out.

## Why there is a password gateway

`dsh` has no password concept, and its built-in link is not something you can
safely paste into a chat. Three facts about `dsh web` (verified against
`0.1.2-rc.1`) force the shape of this action:

1. It authenticates with a random **launch token** printed in its own log, and
   the URL *is* the token — anyone who sees the link is logged in.
2. The cookie it mints is bound to the request **authority**: the cookie name is
   `dsh-auth-<hash(authority)>` and the signed payload carries the same value. A
   browser arriving through a tunnel presents the tunnel's host, so the cookie
   `dsh` computes server-side never matches the one the browser holds.
3. `/api` sits behind a Host fence (a DNS-rebinding defense) that accepts only
   loopback, the deployment's own LAN addresses, or an explicitly declared
   `--trusted-host`. A tunnel gives every request a public Host.

So a plain TCP tunnel to `dsh` cannot work, and publishing the token link leaks
the credential.

This action puts a small reverse proxy (`scripts/gateway.mjs`) in front instead,
and it owns both ends of the connection:

```
browser ──https(tunnel)──▶ gateway ──http(loopback)──▶ dsh
          gateway's cookie          dsh's cookie,
          (password login)          held only in the gateway
```

The gateway strips every `dsh-auth-*` cookie out of browser traffic, keeps
`dsh`'s own cookie to itself, and re-mints it from the launch token it reads off
the container log whenever `dsh` restarts. The browser only ever holds the
gateway's own signed session cookie — so the link in the job log is safe to
share with anyone who also has the password, and a `dsh` restart behind the
scenes does not log you out.

WebSocket traffic (`/api/remote.mux`, the RPC mux) is proxied too, which is why
the UI is actually live rather than just rendering.

The container runs with `--network host`, so `dsh` listens on the runner's
loopback only. The tunnel is the only way in.

## Inputs

| Input | Default | Description |
|---|---|---|
| `api_key` | — | Model API key (**required**) |
| `password` | generated | Password guarding the link |
| `ngrok_token` | — | ngrok authtoken (**required** for a public link) |
| `ngrok_domain` | — | Reserved ngrok domain, e.g. `my-dsh.ngrok.app` |
| `base_url` | — | Custom gateway base URL; set together with `model` |
| `model` | — | Model id(s), comma-separated; the first is the default |
| `timeout_minutes` | `360` | Safety bound; the **job's** `timeout-minutes` is the real deadline |
| `image` | `shaowenchen/deepseek-harness-web:latest` | Container image |
| `port` | `13080` | Port `dsh` listens on (3080 belongs to the gateway) |
| `workspace_dir` | `default` | Workspace directory under `/root` |
| `mount_repo` | `true` | Mount the checkout read-only at `/workspace` |
| `extra_args` | — | Extra flags for the `dsh` command |
| `extra_docker_args` | — | Extra flags for `docker run` |
| `log_level` | — | `debug` prints per-file sync details |
| `s3_bucket`, `s3_path`, `s3_endpoint`, `s3_access_key`, `s3_secret_key`, `s3_region`, `s3_path_style` | — | Optional S3-compatible persistence |

### Keeping a workspace between sessions

Set the `s3_*` inputs (or the matching `S3_*` secrets) and the workspace and
chat history sync to the bucket, so the next session picks up where the last one
stopped. Sync is enabled only when `s3_bucket` is set; then `s3_endpoint`,
`s3_access_key` and `s3_secret_key` are required. See the
[deepseek-harness-web README](https://github.com/shaowenchen/deepseek-harness-web)
for what is and is not synced.

## Repository layout

| Path | What it is |
|---|---|
| `action.yml` | The composite action |
| `scripts/action.sh` | Orchestration: container, gateway, tunnel, session lifetime |
| `scripts/gateway.mjs` | Password gate and reverse proxy (zero dependencies) |
| `scripts/session-summary.sh` | Publishes the link and password to the job summary |
| `.github/workflows/dsh.yml` | The `workflow_dispatch` entry point for this repo |

## Notes and limits

- **Sessions are public-if-guessed.** The tunnel hostname is random but the
  session is reachable by anyone with the link *and* the password. ngrok's free
  tier also shows an interstitial warning page before the harness loads.
- **The password is printed in the log.** That is the deliverable — treat the
  run log the way you would treat the link. Set the `password` input to control
  it, or to reuse a known value.
- **The generated password is not masked** in the log, deliberately: masking it
  would hide it from the very job summary that has to display it. The API key
  and S3 credentials *are* masked.
- **There is no duration input.** A session lives until you cancel the run or
  the job's `timeout-minutes` fires, which is the same thing GitHub already
  measures. Set `timeout-minutes` on the job (60 by default in this repo's
  workflow) and leave `timeout_minutes` alone.
- **One session per workspace label** — the workflow keys its `concurrency`
  group on `repo_label`, so a second run for the same workspace queues rather
  than fighting the first over the same host ports.
- **The workspace is ephemeral.** Without S3, everything is gone when the run
  ends. The container's `/root` lives in `.dsh-session-home/` on the runner, and
  the runner itself is discarded with the job.

## License

MIT
