#!/usr/bin/env node
/**
 * dsh-gateway — a password gate and reverse proxy in front of `dsh web`.
 *
 * Why a proxy is required at all (verified against dsh 0.1.2-rc.1):
 *
 *  1. `dsh web` prints `dsh web: http://127.0.0.1:3080/?token=<random>`. That
 *     token is the whole credential, and the link *is* the token — anyone who
 *     sees the link is logged in. There is no password anywhere in dsh.
 *  2. The cookie dsh mints from that token is bound to the request authority:
 *     its name is `dsh-auth-<sha256(authority)>` and the signed payload carries
 *     the same authority. A browser reaching dsh through a public tunnel
 *     presents the tunnel host, so the cookie name dsh computes server-side
 *     never matches the one the browser holds.
 *  3. `/api` sits behind a Host fence (DNS-rebinding defense) that accepts only
 *     loopback, deployment LAN literals, or an explicitly declared
 *     `--trusted-host`. A tunnel gives every request a public Host.
 *
 * So a transparent TCP tunnel to dsh cannot work, and the raw token link is a
 * credential leak. This process owns both ends of the connection instead:
 *
 *     browser  ──https(tunnel)──▶  gateway  ──http(loopback)──▶  dsh
 *              gateway's own cookie        dsh's own cookie,
 *              (password login)            held only in this process
 *
 * It strips every `dsh-auth-*` cookie out of browser traffic, keeps dsh's
 * cookie here, and re-mints it from the launch token it reads off the
 * container log whenever dsh restarts and the old cookie stops verifying
 * (dsh exits and is restarted by its entrypoint after a plugin install, and
 * each new process mints a new launch token). The browser only ever holds this
 * gateway's own signed session cookie, so the link in the job log is safe to
 * share with anyone who also has the password.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { createInterface } from 'node:readline'

// ── configuration ───────────────────────────────────────────────────────────

const LISTEN_PORT = Number(process.env.DSHGW_LISTEN_PORT ?? '3080')
const INNER_AUTHORITY = process.env.DSHGW_INNER_AUTHORITY ?? '127.0.0.1:13080'
const INNER_HOST = INNER_AUTHORITY.slice(0, INNER_AUTHORITY.lastIndexOf(':')) || '127.0.0.1'
const INNER_PORT = Number(INNER_AUTHORITY.slice(INNER_AUTHORITY.lastIndexOf(':') + 1))
const PASSWORD = process.env.DSHGW_PASSWORD ?? ''
/**
 * How long the session may run, in hours; exactly "0" means the caller asked
 * for no limit.
 *
 * Anything that is not a non-negative number falls back to the default rather
 * than to "unlimited": the permissive reading of a typo is a cookie that never
 * expires, which is the one outcome a mistake must not produce. `Number('soon')`
 * is `NaN`, and `NaN >= 0` is false, so the guard below catches it.
 *
 * The default differs from action.sh's `DSH_SESSION_HOURS=0` on purpose. That
 * script always passes this variable explicitly, so the default here applies
 * only when the gateway is started on its own — by the end-to-end test, or by
 * hand. In that case nothing has told the gateway how long the session is, and
 * a bounded cookie is the safer answer for the process that holds the signing
 * key; 12 hours is long enough to outlive any real session and short enough not
 * to be permanent.
 */
const SESSION_HOURS_PARSED = Number(process.env.DSHGW_SESSION_HOURS ?? '12')
const SESSION_HOURS = Number.isFinite(SESSION_HOURS_PARSED) && SESSION_HOURS_PARSED >= 0
  ? SESSION_HOURS_PARSED
  : 12
// Which tunnel agent is in front, and the local API (if any) that can be asked
// for the public URL. Discovery itself is a dispatch keyed by this name, so an
// unsupported value is reported rather than silently leaving the session with
// no link.
const TUNNEL = process.env.DSHGW_TUNNEL ?? 'ngrok'
const TUNNEL_API = process.env.DSHGW_TUNNEL_API ?? 'http://127.0.0.1:4040'
// The agent's own log, which is where a cloudflared quick tunnel announces its
// hostname. Empty means "not available", and the cloudflare discovery then
// simply finds nothing rather than failing.
const TUNNEL_LOG = process.env.DSHGW_TUNNEL_LOG ?? ''
const PUBLIC_URL_OVERRIDE = process.env.DSHGW_PUBLIC_URL ?? ''
const URL_FILE = process.env.DSHGW_URL_FILE ?? ''

if (PASSWORD === '') {
  console.error('dsh-gateway: DSHGW_PASSWORD is required')
  process.exit(2)
}
if (!Number.isInteger(INNER_PORT) || INNER_PORT <= 0 || INNER_PORT > 65535) {
  console.error(`dsh-gateway: DSHGW_INNER_AUTHORITY "${INNER_AUTHORITY}" has no usable port`)
  process.exit(2)
}

/** Paths this gateway answers itself; never proxied, never password-gated. */
const LOGIN_PATH = '/__dshgw/login'
const LOGOUT_PATH = '/__dshgw/logout'
const HEALTH_PATH = '/__dshgw/health'

// ── session state ───────────────────────────────────────────────────────────

/** Signing key for the gateway's own cookie; per-process, so a restart logs everyone out. */
const SECRET = randomBytes(32)
/**
 * The gateway cookie's lifetime, matching the session's.
 *
 * `null` means the cookie carries no expiry of its own — the caller chose an
 * unlimited session, so the cookie must not sign everyone out on a timer the
 * session does not have. It is still bounded in practice: the job ends the
 * session, and the process holding the signing key goes with it.
 */
const SESSION_MS = SESSION_HOURS > 0 ? SESSION_HOURS * 60 * 60 * 1000 : null
const COOKIE_NAME = 'dshgw'

/**
 * dsh's own browser cookie (`dsh-auth-...=v1....`), held here and never sent to
 * a browser. It is authority-bound to INNER_AUTHORITY, which is fixed for the
 * lifetime of this process, so one cookie serves every logged-in browser.
 */
let innerCookie = null

/** Current `dsh web` launch token, re-read from the log on every dsh restart. */
let dshToken = process.env.DSHGW_TOKEN ?? ''

/** Public origin once discovered, for the log line and URL file. */
let publicUrl = ''

function log(message) {
  process.stdout.write(`[gateway] ${message}\n`)
}

// ── cookie helpers ──────────────────────────────────────────────────────────

function b64url(input) {
  return Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function sign(body) {
  return b64url(createHmac('sha256', SECRET).update(body).digest())
}

/**
 * Mint one gateway session value: `v1.<payload>.<hmac>`, expiring after
 * SESSION_MS — or, when that is null, carrying no `exp` at all so verification
 * does not expire it.
 */
function mintSession() {
  const payload = SESSION_MS === null ? {} : { exp: Date.now() + SESSION_MS }
  const body = b64url(JSON.stringify(payload))
  return `v1.${body}.${sign(body)}`
}

/**
 * Verify a gateway session value in constant time; returns false for anything
 * malformed or expired.
 *
 * A payload with no `exp` is accepted only when this process is not enforcing
 * one — an absent expiry must not become a way to outlive a bounded session.
 * The signature still has to verify, so the payload cannot be forged either
 * way.
 */
function verifySession(value) {
  const parts = value.split('.')
  const [version, body, mac] = parts
  if (parts.length !== 3 || version !== 'v1' || !body || !mac) return false
  const expected = sign(body)
  const actualBytes = Buffer.from(mac, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  if (actualBytes.byteLength !== expectedBytes.byteLength) return false
  if (!timingSafeEqual(actualBytes, expectedBytes)) return false
  try {
    const payload = JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
    if (SESSION_MS === null) return typeof payload.exp !== 'number' ? true : payload.exp > Date.now()
    return typeof payload.exp === 'number' && payload.exp > Date.now()
  } catch {
    return false
  }
}

function parseCookies(header) {
  const jar = new Map()
  if (typeof header !== 'string') return jar
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    jar.set(segment.slice(0, at).trim(), segment.slice(at + 1).trim())
  }
  return jar
}

/** Whether this request carries a valid gateway session cookie. */
function isAuthenticated(req) {
  const value = parseCookies(req.headers.cookie).get(COOKIE_NAME)
  return value !== undefined && verifySession(value)
}

/** Behind the tunnel the edge terminates TLS, so `Secure` follows the forwarded scheme. */
function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto']
  return (typeof proto === 'string' ? proto.split(',')[0].trim() : '') === 'https'
}

function sessionCookie(value, req, maxAgeSeconds) {
  // No Max-Age when the session has no limit: the attribute is a timer, and
  // omitting it makes this a session cookie that lasts until the browser closes
  // — which is the closest a cookie can get to "no expiry of its own". `null`
  // must not be stringified here, or the header would read `Max-Age=null`.
  const attrs = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (maxAgeSeconds !== null) attrs.push(`Max-Age=${String(maxAgeSeconds)}`)
  if (isSecureRequest(req)) attrs.push('Secure')
  return attrs.join('; ')
}

// ── password check and brute-force damping ──────────────────────────────────

const PASSWORD_DIGEST = createHash('sha256').update(PASSWORD).digest()

/** Compare digests so the comparison is constant-time regardless of password length. */
function passwordMatches(candidate) {
  return timingSafeEqual(createHash('sha256').update(candidate).digest(), PASSWORD_DIGEST)
}

/** Per-client failure state; a public link invites guessing, so failures back off. */
const failures = new Map()
const MAX_BACKOFF_MS = 5000

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  const first = (typeof forwarded === 'string' ? forwarded.split(',')[0] : '').trim()
  return first || req.socket.remoteAddress || 'unknown'
}

function backoffMs(ip) {
  const entry = failures.get(ip)
  if (entry === undefined || entry.count === 0) return 0
  return Math.min(MAX_BACKOFF_MS, 250 * 2 ** Math.min(entry.count - 1, 5))
}

function noteFailure(ip) {
  const entry = failures.get(ip) ?? { count: 0 }
  entry.count += 1
  entry.at = Date.now()
  failures.set(ip, entry)
}

function clearFailures(ip) {
  failures.delete(ip)
}

// ── the login page ──────────────────────────────────────────────────────────

/** Escape a value for a quoted HTML attribute and for text content. */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * The gate page. Fully self-contained — no external asset is referenced,
 * because every other path is either gated (and would 401 an image request) or
 * belongs to the harness. Auto light/dark via `prefers-color-scheme`.
 */
function loginPage({ next, error }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>DeepSeek Harness — sign in</title>
<link rel="icon" href="data:,">
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#16181d; --muted:#6b7280; --line:#e3e6ea; --accent:#2f6feb; --danger:#c0392b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1116; --card:#171a21; --fg:#e8eaee; --muted:#9aa2ad; --line:#262b34; --accent:#5b8cf7; --danger:#ff6b5e; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
         background:var(--bg); color:var(--fg);
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif; }
  .card { width:100%; max-width:380px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px 26px; }
  .mark { width:34px; height:34px; border-radius:9px; background:var(--accent); display:flex; align-items:center; justify-content:center; margin-bottom:16px; }
  .mark svg { width:18px; height:18px; fill:none; stroke:#fff; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  h1 { margin:0 0 4px; font-size:19px; font-weight:600; letter-spacing:-.01em; }
  p.sub { margin:0 0 20px; color:var(--muted); font-size:13px; }
  label { display:block; font-size:12px; font-weight:600; color:var(--muted); margin-bottom:6px; letter-spacing:.02em; text-transform:uppercase; }
  input[type=password] { width:100%; padding:11px 12px; font-size:15px; color:var(--fg); background:transparent;
                         border:1px solid var(--line); border-radius:9px; outline:none; }
  input[type=password]:focus { border-color:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
  button { width:100%; margin-top:16px; padding:11px 12px; font-size:15px; font-weight:600; color:#fff;
           background:var(--accent); border:0; border-radius:9px; cursor:pointer; }
  button:hover { filter:brightness(1.07); }
  .error { margin:0 0 16px; padding:9px 11px; font-size:13px; color:var(--danger);
           border:1px solid color-mix(in srgb, var(--danger) 35%, transparent); border-radius:8px;
           background:color-mix(in srgb, var(--danger) 10%, transparent); }
</style>
</head>
<body>
  <form class="card" method="post" action="${LOGIN_PATH}">
    <div class="mark"><svg viewBox="0 0 24 24"><rect x="4" y="10.5" width="16" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg></div>
    <h1>DeepSeek Harness</h1>
    <p class="sub">This session is protected by a password.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <button type="submit">Sign in</button>
  </form>
</body>
</html>
`
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
  })
  res.end(body)
}

function sendText(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

/** Only same-origin absolute paths are accepted as a post-login destination. */
function safeNext(raw) {
  if (typeof raw !== 'string') return '/'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

// ── login and logout ────────────────────────────────────────────────────────

const MAX_FORM_BYTES = 4096

function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_FORM_BYTES) {
        reject(new Error('form too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })
}

async function handleLogin(req, res, url) {
  const ip = clientIp(req)
  if (req.method === 'GET' || req.method === 'HEAD') {
    sendHtml(res, 200, loginPage({ next: safeNext(url.searchParams.get('next')), error: '' }))
    return
  }
  if (req.method !== 'POST') {
    sendText(res, 405, 'method not allowed\n')
    return
  }
  const pause = backoffMs(ip)
  if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause))
  let form
  try {
    form = await readForm(req)
  } catch {
    sendText(res, 413, 'form too large\n')
    return
  }
  const next = safeNext(form.get('next'))
  if (!passwordMatches(form.get('password') ?? '')) {
    noteFailure(ip)
    log(`login FAILED from ${ip}`)
    sendHtml(res, 401, loginPage({ next, error: 'Incorrect password. Try again.' }))
    return
  }
  clearFailures(ip)
  log(`login OK from ${ip}`)
  res.writeHead(303, {
    'location': next,
    'set-cookie': sessionCookie(mintSession(), req, SESSION_MS === null ? null : Math.floor(SESSION_MS / 1000)),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end()
}

function handleLogout(req, res) {
  res.writeHead(303, {
    'location': '/',
    'set-cookie': sessionCookie('', req, 0),
    'cache-control': 'no-store',
  })
  res.end()
}

// ── proxying to dsh ─────────────────────────────────────────────────────────

/** Headers a proxy must not forward in either direction (RFC 9110 hop-by-hop, plus framing). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/**
 * Rewrite browser headers into upstream headers. Host, Origin and Cookie are
 * all replaced, and the reason is the same fence in each case:
 *
 * dsh's `/api` guard (`isTrustedApiRequest`) demands that the Host be loopback
 * AND, when an Origin is present, that `new URL(origin).host` equal the Host
 * exactly. Behind the tunnel the browser sends `Origin: https://<name>.ngrok.app`
 * while we rewrite Host to 127.0.0.1:13080, so the two disagree and every RPC —
 * including `/api/directoryPicker/list` — is answered 403. Rewriting Origin to
 * the inner authority restores the agreement the fence is checking for. A
 * browser at the public URL is same-origin with every request it makes, so the
 * browser's own cross-origin protection is not what keeps this honest: the
 * password gate below is, since it refuses every path but the login page until
 * a session cookie verifies.
 *
 * `sec-fetch-site` is dropped for the same reason: a proxied navigation can
 * arrive labelled `cross-site`, which the fence refuses outright.
 *
 * Host is also why the Cookie is replaced wholesale with dsh's own — dsh names
 * its cookie after a hash of the authority, so only a cookie minted for
 * 127.0.0.1:13080 can be presented to it. No `dsh-auth-*` value from a browser
 * may reach dsh, and none dsh sets may reach a browser.
 */
function upstreamHeaders(req, { upgrade = false } = {}) {
  const out = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (lower === 'host' || lower === 'cookie') continue
    if (lower === 'origin' || lower === 'sec-fetch-site') continue
    if (lower.startsWith('x-forwarded-')) continue
    // An upgrade keeps `connection`/`upgrade`; everything else hop-by-hop goes.
    if (HOP_BY_HOP.has(lower) && !(upgrade && (lower === 'connection' || lower === 'upgrade'))) continue
    if (value === undefined) continue
    out[lower] = value
  }
  out.host = INNER_AUTHORITY
  // Same-authority Origin, so dsh's fence sees the agreement it requires. Sent
  // in both schemes' spellings only as one value: the fence compares hosts, not
  // schemes, so the scheme here is cosmetic.
  out.origin = `http://${INNER_AUTHORITY}`
  out['x-forwarded-for'] = clientIp(req)
  out['x-forwarded-proto'] = isSecureRequest(req) ? 'https' : 'http'
  out['x-forwarded-host'] = typeof req.headers.host === 'string' ? req.headers.host : INNER_AUTHORITY
  if (innerCookie !== null) out.cookie = innerCookie
  return out
}

/** Capture dsh's browser cookie into this process and drop it from the browser-bound headers. */
function absorbResponseCookies(headers) {
  const raw = headers['set-cookie']
  if (raw === undefined) return undefined
  const list = Array.isArray(raw) ? raw : [raw]
  const forwarded = []
  for (const entry of list) {
    if (entry.startsWith('dsh-auth-')) {
      const pair = entry.split(';')[0]
      innerCookie = pair
      continue
    }
    forwarded.push(entry)
  }
  return forwarded.length > 0 ? forwarded : undefined
}

function responseHeaders(upstreamResponse) {
  const out = {}
  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (value === undefined) continue
    if (lower === 'set-cookie') continue
    out[lower] = value
  }
  const cookies = absorbResponseCookies(upstreamResponse.headers)
  if (cookies !== undefined) out['set-cookie'] = cookies
  return out
}

/**
 * Forward one HTTP request to dsh. `retry` allows exactly one transparent
 * re-mint. Two upstream answers trigger it, both meaning "the cookie we hold is
 * not usable": dsh rotates its launch token on every process start (its
 * entrypoint restarts it after a plugin install), and the first request after
 * a re-mint carries the token itself, which dsh answers with the redirect that
 * mints the cookie.
 */
function proxyHttp(req, res, { retry }) {
  const url = new URL(req.url ?? '/', 'http://inner.invalid')
  const isIndex = url.pathname === '/'
  const tokenInjected = isIndex && innerCookie === null && dshToken !== ''
  let path = req.url ?? '/'
  if (tokenInjected) {
    url.searchParams.set('token', dshToken)
    path = `${url.pathname}${url.search}`
  }
  let settled = false
  const upstream = httpRequest({
    host: INNER_HOST,
    port: INNER_PORT,
    method: req.method,
    path,
    headers: upstreamHeaders(req),
    agent: false,
  }, (upstreamResponse) => {
    settled = true
    const status = upstreamResponse.statusCode ?? 502
    // The token exchange: absorb dsh's cookie here and serve the browser the
    // clean page in this same request instead of bouncing it through a 303.
    // `location: /` is what confirms dsh accepted the token, as opposed to
    // some other redirect that happens to carry a cookie.
    if (tokenInjected && status === 303 && upstreamResponse.headers.location === '/') {
      absorbResponseCookies(upstreamResponse.headers)
      if (innerCookie !== null) {
        upstreamResponse.resume()
        log('minted a dsh browser cookie from the launch token')
        proxyHttp(req, res, { retry: false })
        return
      }
    }
    if (status === 401 && retry && isIndex && (req.method === 'GET' || req.method === 'HEAD') && dshToken !== '') {
      upstreamResponse.resume()
      log('dsh rejected the held cookie; re-minting from the launch token')
      innerCookie = null
      proxyHttp(req, res, { retry: false })
      return
    }
    res.writeHead(status, responseHeaders(upstreamResponse))
    upstreamResponse.pipe(res)
  })
  upstream.setTimeout(120_000, () => upstream.destroy(new Error('upstream timeout')))
  upstream.on('error', (error) => {
    if (settled) {
      res.destroy()
      return
    }
    log(`upstream error: ${error.message}`)
    sendText(res, 502, 'dsh web is not reachable from the gateway yet; retry in a moment.\n')
  })
  if (req.method === 'GET' || req.method === 'HEAD') upstream.end()
  else req.pipe(upstream)
}
/**
 * Forward one WebSocket upgrade (`/api/remote.mux` — the harness RPC mux).
 * The 101 is relayed byte-for-byte, then both sockets are piped raw.
 */
function proxyUpgrade(req, socket, head) {
  const upstream = httpRequest({
    host: INNER_HOST,
    port: INNER_PORT,
    method: req.method,
    path: req.url ?? '/',
    headers: upstreamHeaders(req, { upgrade: true }),
    agent: false,
  })
  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${String(upstreamResponse.statusCode)} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`]
    for (let i = 0; i < upstreamResponse.rawHeaders.length; i += 2) {
      lines.push(`${upstreamResponse.rawHeaders[i]}: ${upstreamResponse.rawHeaders[i + 1]}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead !== undefined && upstreamHead.length > 0) socket.write(upstreamHead)
    if (head !== undefined && head.length > 0) upstreamSocket.write(head)
    upstreamSocket.setNoDelay(true)
    socket.setNoDelay(true)
    socket.pipe(upstreamSocket)
    upstreamSocket.pipe(socket)
    const teardown = () => { socket.destroy(); upstreamSocket.destroy() }
    socket.on('error', teardown)
    upstreamSocket.on('error', teardown)
    socket.on('close', () => upstreamSocket.destroy())
    upstreamSocket.on('close', () => socket.destroy())
  })
  // A refused upgrade answers with an ordinary response (401 when dsh's own
  // cookie is stale) — relay its status so the client can react, then close.
  upstream.on('response', (upstreamResponse) => {
    const lines = [`HTTP/1.1 ${String(upstreamResponse.statusCode)} ${upstreamResponse.statusMessage ?? 'Error'}`]
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    upstreamResponse.pipe(socket)
  })
  upstream.on('error', (error) => {
    log(`upgrade error: ${error.message}`)
    socket.destroy()
  })
  upstream.end()
}

// ── request dispatch ────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://gateway.invalid')
  if (url.pathname === HEALTH_PATH) {
    sendText(res, 200, 'ok\n')
    return
  }
  if (url.pathname === LOGOUT_PATH) {
    handleLogout(req, res)
    return
  }
  if (url.pathname === LOGIN_PATH) {
    handleLogin(req, res, url).catch((error) => {
      log(`login handler failed: ${error.message}`)
      if (!res.headersSent) sendText(res, 500, 'login failed\n')
      else res.destroy()
    })
    return
  }
  if (isAuthenticated(req)) {
    proxyHttp(req, res, { retry: true })
    return
  }
  // Unauthenticated. A browser navigating gets the gate; anything else gets a
  // bare 401 so the harness UI can tell "not signed in" from "broken".
  const accept = typeof req.headers.accept === 'string' ? req.headers.accept : ''
  if ((req.method === 'GET' || req.method === 'HEAD') && accept.includes('text/html')) {
    sendHtml(res, 200, loginPage({ next: safeNext(req.url ?? '/'), error: '' }))
    return
  }
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : 'dsh session authentication required.\n')
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://gateway.invalid')
  if (url.pathname === HEALTH_PATH) {
    socket.destroy()
    return
  }
  if (!isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
    socket.destroy()
    return
  }
  proxyUpgrade(req, socket, head)
})

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
  else socket.destroy()
})

// ── launch token harvesting ─────────────────────────────────────────────────

/**
 * Read the container log from stdin. `dsh web:` carries the launch token, and
 * the most recent one wins — the entrypoint restarts dsh after a plugin
 * install, and the new process mints a new token. Other lines are echoed so
 * the job log keeps showing dsh's own output.
 */
const logReader = createInterface({ input: process.stdin })
logReader.on('line', (line) => {
  const announcement = /dsh web:\s+(\S+)/.exec(line)
  if (announcement !== null) {
    const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(announcement[1])
    if (token !== null && token[1] !== dshToken) {
      dshToken = token[1]
      log('captured a dsh launch token')
    }
    return
  }
  if (line.trim() !== '') process.stdout.write(`[dsh] ${line}\n`)
})

// ── public URL discovery ────────────────────────────────────────────────────

/**
 * Ask ngrok's inspection API for the tunnel's public URL.
 *
 * The agent defaults to port 4040 but steps to the next free port when that one
 * is taken, so the configured base is a starting point rather than the answer.
 * Returns '' while the agent is not up yet.
 */
async function discoverNgrokUrl() {
  const base = Number(new URL(TUNNEL_API).port || '4040')
  const candidates = Array.from({ length: 5 }, (_, index) => `http://127.0.0.1:${String(base + index)}`)
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/api/tunnels`, { signal: AbortSignal.timeout(2000) })
      if (!response.ok) continue
      const body = await response.json()
      // Prefer an https endpoint: the login cookie is marked Secure when the
      // request arrives over TLS, and a mixed scheme would break it.
      const tunnels = body.tunnels ?? []
      const tunnel = tunnels.find((entry) => typeof entry.public_url === 'string'
        && entry.public_url.startsWith('https://'))
        ?? tunnels.find((entry) => typeof entry.public_url === 'string')
      if (tunnel !== undefined) {
        log(`public URL: ${tunnel.public_url} (ngrok API on port ${new URL(candidate).port})`)
        return tunnel.public_url.replace(/\/+$/u, '')
      }
    } catch {
      // The agent is not up yet — keep waiting.
    }
  }
  return ''
}

/**
 * Ask cloudflared's metrics server for a quick tunnel's hostname.
 *
 * The server lives on localhost:20241 and, when that is taken, steps through
 * 20245 before falling back to a random port — the same shape as ngrok's, so
 * the scan is the same. `/quicktunnel` answers `{"hostname":"<host>"}` with NO
 * scheme: cloudflared adds the `https://` only for its human-facing banner. The
 * scheme is therefore supplied here rather than assumed to be present.
 *
 * Only a quick tunnel populates this — a named tunnel leaves the field empty,
 * and the response is `{"hostname":""}`, which is treated as "not found".
 */
async function fetchCloudflareQuickHostname() {
  const base = Number(new URL(TUNNEL_API).port || '20241')
  const candidates = Array.from({ length: 5 }, (_, index) => `http://127.0.0.1:${String(base + index)}`)
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/quicktunnel`, { signal: AbortSignal.timeout(2000) })
      if (!response.ok) continue
      const body = await response.json()
      const hostname = typeof body.hostname === 'string' ? body.hostname.trim() : ''
      if (hostname !== '') {
        log(`public URL: https://${hostname} (cloudflared metrics on port ${new URL(candidate).port})`)
        return `https://${hostname}`
      }
    } catch {
      // Not up yet, or not a quick tunnel — keep waiting.
    }
  }
  return ''
}

/**
 * Read the cloudflared quick tunnel's URL out of the agent's own log.
 *
 * A fallback for when the metrics server cannot be reached. cloudflared prints
 * the hostname inside a box drawn with `|` and `+`, preceded by prose about the
 * tunnel having been created. Matching the hostname rather than that prose is
 * deliberate: the wording and the box are presentation and drift between
 * releases, while the hostname is the thing being reported.
 *
 * A *named* (token) tunnel prints no hostname at all — Cloudflare already knows
 * it, and the connector is never told — so this finds nothing there and the
 * action supplies the URL instead.
 */
function readCloudflareUrlFromLog() {
  if (TUNNEL_LOG === '') return ''
  let text
  try {
    text = readFileSync(TUNNEL_LOG, 'utf8')
  } catch {
    // The agent has not written its log yet.
    return ''
  }
  const match = /https:\/\/([a-z0-9][a-z0-9-]*\.trycloudflare\.com)/u.exec(text)
  if (match === null) return ''
  log(`public URL: https://${match[1]} (from the cloudflared log)`)
  return `https://${match[1]}`
}

/**
 * Discover a Cloudflare tunnel's public URL: the metrics API when it answers,
 * and the agent's own log when it does not. Both are needed — the metrics
 * server is exact but only exists for a quick tunnel, and the log is the only
 * record that survives a port collision.
 */
async function discoverCloudflareUrl() {
  const fromMetrics = await fetchCloudflareQuickHostname()
  return fromMetrics !== '' ? fromMetrics : readCloudflareUrlFromLog()
}

/**
 * Resolve the public origin and record it. Explicit configuration wins; then
 * the running agent's local API or log, which is the only way to learn the URL
 * of a quick tunnel — its hostname is minted by Cloudflare at connect time and
 * appears nowhere else; then nothing, and the caller prints a loopback URL and
 * says the tunnel is missing.
 */
async function publishUrl() {
  if (PUBLIC_URL_OVERRIDE !== '') {
    publicUrl = PUBLIC_URL_OVERRIDE.replace(/\/+$/u, '')
  } else {
    const discover = { ngrok: discoverNgrokUrl, cloudflare: discoverCloudflareUrl }[TUNNEL]
    if (discover === undefined) {
      log(`no URL discovery for a '${TUNNEL}' tunnel`)
      return
    }
    // Bringing a tunnel up can take a while, so wait well past the point where
    // the rest of the session is already serving.
    for (let attempt = 0; attempt < 180 && publicUrl === ''; attempt += 1) {
      publicUrl = await discover()
      if (publicUrl === '') await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  if (publicUrl === '') {
    log(`no public URL: the ${TUNNEL} agent reported none`)
    return
  }
  log(`public URL: ${publicUrl}`)
  if (URL_FILE !== '') {
    try {
      // Plain text, not JSON: the only consumer is a shell script, and this
      // keeps that script free of a jq dependency it would otherwise need.
      writeFileSync(URL_FILE, `${publicUrl}\n`, { mode: 0o600 })
    } catch (error) {
      log(`could not write ${URL_FILE}: ${error.message}`)
    }
  }
}

// ── shutdown ────────────────────────────────────────────────────────────────

function shutdown() {
  log('shutting down')
  server.close(() => process.exit(0))
  server.closeAllConnections?.()
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  log(`listening on 0.0.0.0:${String(LISTEN_PORT)} -> http://${INNER_AUTHORITY}`)
  void publishUrl()
})
