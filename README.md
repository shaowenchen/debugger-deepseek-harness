# debugger-deepseek-harness

Start an ephemeral **DeepSeek Harness** (`dsh`) web session from GitHub Actions,
hand yourself a temporary link, and sign in with a password.

It combines two projects:

- **[debugger-action](https://github.com/shaowenchen/debugger-action)** — the
  "give me a disposable box to poke at from a workflow run" idea, and its ngrok
  tunnel setup.
- **[deepseek-harness-web](https://github.com/shaowenchen/deepseek-harness-web)** —
  the packaged `dsh` web image, whose pinned dsh version is this action's
  default and whose model-routing conventions it follows.

What you get: a run that prints something like

```
https://1a2b-3c4d.ngrok-free.app     password: 9f3c1a7e20b845dd1c9e
```

Open the link, type the password, and you are in the harness — in your browser,
from anywhere.

## Quick start

## Secrets

Create these under **Settings → Secrets and variables → Actions → Secrets**.

| Secret | Required | What it is |
|---|---|---|
| `API_KEY` | yes | Your model API key |
| `PASSWORD` | yes | The password you sign in with |
| `NGROK_TOKEN` | for a link | An [ngrok authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) |
| `BASE_URL` | no | Model API endpoint; empty = official DeepSeek |
| `MODEL` | no | Model id(s), comma-separated; the first is the default |

Only `MODEL` has a matching field on the Run-workflow form, so a model can be
tried without editing secrets. The rest are secrets end to end, because a
workflow input is plain text any reader of the run can see.

## Quick start

Add `API_KEY`, `PASSWORD`, and `NGROK_TOKEN`. Then: **Actions → DeepSeek
Harness → Run workflow**. Open the link from the run's **Summary**, type your
password, and start working — the session opens on a ready workspace, so there
is nothing to set up first.

The session ends when you hit **Cancel workflow**, or when the job's
`timeout-minutes` fires — there is no "duration" knob to set, because the job
timeout already is one. Nothing survives the end of the run; the runner is
discarded with the job.

## Model routing

Two values decide which model answers. Both are written into
`$DSH_HOME/settings.yaml`, the file `dsh` reads at startup — `dsh` has no
command-line flag for a model, so this file is the only place the choice can
live:

| | Where it comes from | Notes |
|---|---|---|
| **Base URL** | the `BASE_URL` secret | Empty = the official DeepSeek endpoint |
| **Model** | `MODEL` secret, overridable by the `model` field for one run | Comma-separated for several; the first is the default |
| **API key** | the `API_KEY` secret, and nothing else | Never an input — workflow inputs are plain text in the run |

Leave `BASE_URL` unset to use the official DeepSeek endpoint, where `API_KEY` is
your DeepSeek key and `MODEL` selects among the endpoint's own models. Set it to
point at any OpenAI-compatible gateway, where `MODEL` names the ids that gateway
serves.

`MODEL` and the `model` field are independent of `BASE_URL`, and both default to
`default`. On the official endpoint `default` means *no explicit choice*: `dsh`
keeps its own default model rather than this action pinning one. On a custom
gateway it is an ordinary model id — the gateway is yours, so a model actually
named `default` works like any other.

### Describing a custom gateway's models

An entry may carry optional metadata, separated by `|`:

```
model: 'deepseek-v4-flash|DeepSeek V4 Flash (via Gateway)|128000|4096,fast-model'
```

That is `id|name|contextWindow|maxTokens`, and the last three are optional —
`fast-model` above is registered with the route's defaults. Declaring a capacity
matters because a gateway is not a catalog `dsh` knows: without it, every model
inherits the same defaults (262144 context, 32768 output), which may be far more
than your gateway really accepts.

The field names are `dsh`'s own (`maxTokens`, not `maxOutput`). A section or
field spelled any other way — `llm-custom` with `protocol`/`baseUrl`, say — is
read as an empty configuration, and the session then fails its first turn with
`NO_ADAPTER`, not at startup. If you see that, check the spelling.

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
      # No actions/checkout: the session gets its own scratch workspace, so
      # there is no need to fetch this repository first.
      - uses: shaowenchen/debugger-deepseek-harness@main
        with:
          api_key: ${{ secrets.API_KEY }}
          password: ${{ secrets.PASSWORD }}
          ngrok_token: ${{ secrets.NGROK_TOKEN }}
          base_url: ${{ secrets.BASE_URL }}   # omit for official DeepSeek
          model: ${{ secrets.MODEL }}         # omit with base_url
```

To give the session the repository instead, check it out and point at it:

```yaml
      - uses: actions/checkout@v4
      - uses: shaowenchen/debugger-deepseek-harness@main
        with:
          workspace_dir: ${{ github.workspace }}
          # …the other inputs as above
```

The session starts in a fresh, empty `workspace/` directory of its own, so it
begins with a clean slate — nothing from this repository is in the way. Point
`workspace_dir` at another path to work somewhere else, as above.

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
dsh's log whenever `dsh` restarts. The browser only ever holds the gateway's own
signed session cookie — so the link in the job log is safe to share with anyone
who also has the password, and a `dsh` restart behind the scenes does not log
you out.

WebSocket traffic (`/api/remote.mux`, the RPC mux) is proxied too, which is why
the UI is actually live rather than just rendering.

`dsh` listens on the runner's loopback only, and the tunnel is the only way in.
It refuses `--host 0.0.0.0` on purpose; it does not need it here, because the
gateway reaches it over loopback on the same machine.

## dsh runs natively, not in a container

`dsh` is installed with `npm` on the runner and run directly, so the version is
chosen per run and no image is involved. Nothing needs mounting either: the
session gets a scratch workspace on the runner rather than a view of this
repository.

Two consequences worth knowing:

- **The version dropdown.** `0.1.2-rc.1` matches the pin in
  deepseek-harness-web's image, so a session here runs the same `dsh` as that
  image. `latest` resolves npm's `latest` tag at install time, so it never goes
  stale — CI runs the gateway end-to-end suite against **both** options, because
  the gateway depends on dsh internals (the launch token, the authority-bound
  cookie, the `/api` Host fence) that a new release could change.
- **No S3 persistence.** The image's S3 sync daemon does not exist here; a
  session is gone when the run ends. Use the image (or a resumed
  `DSH_HOME`) if you need a workspace that outlives the run.

## Inputs

| Input | Default | Description |
|---|---|---|
| `api_key` | — | Model API key (**required**) |
| `version` | `0.1.2-rc.1` | dsh version to install; `latest` or the pinned release |
| `password` | generated | Password guarding the link |
| `ngrok_token` | — | ngrok authtoken (**required** for a public link) |
| `base_url` | — | Model API endpoint; empty = official DeepSeek |
| `model` | `default` | Model id(s), comma-separated; the first is the default. An id may be `id\|name\|contextWindow\|maxTokens`. `default` keeps the endpoint's own default model |
| `workspace_dir` | empty `workspace/` | Directory to work in; a name resolves under the session home |
| `extra_args` | — | Extra flags for the `dsh` command |
| `log_level` | — | `debug` prints more detail |

## Repository layout

| Path | What it is |
|---|---|
| `action.yml` | The composite action |
| `scripts/action.sh` | Orchestration: install dsh, run it, gateway, tunnel, session lifetime |
| `scripts/gateway.mjs` | Password gate and reverse proxy (zero dependencies) |
| `scripts/settings.mjs` | Writes the model configuration (both routes) into `$DSH_HOME/settings.yaml` |
| `scripts/session-summary.sh` | Publishes the link and password to the job summary |
| `.github/workflows/dsh.yml` | The `workflow_dispatch` entry point for this repo |
| `.github/workflows/ci.yml` | Lint + the gateway end-to-end suite, on every offered dsh version |

## Notes and limits

- **Sessions are public-if-guessed.** The tunnel hostname is random but the
  session is reachable by anyone with the link *and* the password. ngrok's free
  tier also shows an interstitial warning page before the harness loads.
- **The password is printed in the log.** That is the deliverable — treat the
  run log the way you would treat the link. Set the `password` secret to control
  it, or to reuse a known value.
- **The generated password is not masked** in the log, deliberately: masking it
  would hide it from the very job summary that has to display it. The API key
  *is* masked.
- **There is no duration input.** A session lives until you cancel the run or
  the job's `timeout-minutes` fires, which is the same thing GitHub already
  measures. Set `timeout-minutes` on the job (60 by default in this repo's
  workflow).
- **One session at a time per repository** — both sessions would claim the same
  gateway port, so the workflow keys its `concurrency` group to the repository
  and a second run queues.
- **The session starts empty.** It gets a fresh `workspace/` directory of its
  own, not a copy of this repository, so it cannot read or modify the action
  that launched it. Point `workspace_dir` at an absolute path to work on code
  that is already on the runner.
- **Nothing survives the run.** The runner is discarded with the job, and there
  is no S3 sync outside the image.

## License

MIT
