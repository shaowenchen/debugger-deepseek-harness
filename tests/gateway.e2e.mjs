#!/usr/bin/env node
/**
 * End-to-end checks for scripts/gateway.mjs against a real `dsh web`.
 *
 * Not a mock: it expects a dsh process already listening on INNER_PORT with
 * its log in DSH_LOG, and asserts the properties the action depends on —
 * notably that no `dsh-auth-*` cookie ever reaches a browser, and that bytes
 * served through the gateway are identical to bytes served by dsh directly.
 *
 * Usage (the gateway must be running with DSHGW_PASSWORD=testpass):
 *   DSH_LOG=/tmp/dsh/boot.log INNER_PORT=3099 node tests/gateway.e2e.mjs
 *
 * Bring the pieces up with:
 *   DSH_HOME=/tmp/dsh dsh --profile web --no-open --port 3099 > /tmp/dsh/boot.log 2>&1 &
 *   DSHGW_INNER_AUTHORITY=127.0.0.1:3099 DSHGW_PASSWORD=testpass \
 *   DSHGW_PUBLIC_URL=https://example.invalid \
 *     node scripts/gateway.mjs < /tmp/dsh/boot.log &
 */

import { readFileSync } from 'node:fs'

const GATEWAY = `http://127.0.0.1:${process.env.GATEWAY_PORT ?? '3080'}`
const DSH = `http://127.0.0.1:${process.env.INNER_PORT ?? '3099'}`
const DSH_LOG = process.env.DSH_LOG ?? '/tmp/dsh/boot.log'
const PASSWORD = process.env.DSHGW_PASSWORD ?? 'testpass'
/**
 * A path under dsh's fenced `/api` prefix. The fence runs before the handler,
 * so the status it returns is what distinguishes the two failures: 403 means
 * the Host/Origin check refused, 401 means the fence passed and only the dsh
 * cookie was missing. Any other status also proves the fence passed.
 */
const API_PROBE = '/api'

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}${detail === '' ? '' : ` ${detail}`}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` ${detail}`}`)
  }
}

/** Cookie pairs for a fetch `cookie:` header. */
const cookieHeader = (response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')

// ── gating ──────────────────────────────────────────────────────────────────

let response = await fetch(`${GATEWAY}/`, { headers: { accept: 'text/html' } })
check('unauthenticated GET / serves the login page',
  response.status === 200 && (await response.text()).includes('protected by a password'))
check('the login page sets no dsh cookie',
  response.headers.getSetCookie().every((c) => !c.startsWith('dsh-auth-')))

response = await fetch(`${GATEWAY}/api`, { headers: { accept: 'application/json' } })
check('unauthenticated GET /api is refused', response.status === 401)

response = await fetch(`${GATEWAY}/__dshgw/login`, {
  method: 'POST',
  body: new URLSearchParams({ password: 'definitely-wrong', next: '/' }),
  redirect: 'manual',
})
check('a wrong password is rejected', response.status === 401)

// ── session ─────────────────────────────────────────────────────────────────

response = await fetch(`${GATEWAY}/__dshgw/login`, {
  method: 'POST',
  body: new URLSearchParams({ password: PASSWORD, next: '/' }),
  redirect: 'manual',
})
const session = cookieHeader(response)
check('the right password issues a gateway session',
  response.status === 303 && session.startsWith('dshgw='))

response = await fetch(`${GATEWAY}/`, { headers: { cookie: session, accept: 'text/html' } })
const html = await response.text()
check('the authenticated index is served', response.status === 200 && html.includes('__DSH_BOOT__'))
check('no dsh cookie leaks to the browser',
  response.headers.getSetCookie().every((c) => !c.startsWith('dsh-auth-')))
check('the index carries no dsh token', !html.includes('token='))

// ── assets ──────────────────────────────────────────────────────────────────

const assets = new Set()
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  let url = match[1].replaceAll('&amp;', '&')
  if (url.startsWith('./')) url = `/${url.slice(2)}`
  if (!url.startsWith('/') || url.startsWith('//')) continue
  assets.add(url)
}
console.log(`  (${assets.size} assets referenced by the page)`)

const badStatus = []
for (const url of assets) {
  const res = await fetch(`${GATEWAY}${url}`, { headers: { cookie: session } })
  if (res.status !== 200) badStatus.push(`${res.status} ${url.slice(0, 60)}`)
}
check('every referenced asset loads', badStatus.length === 0, badStatus.slice(0, 4).join(', '))

// Byte-identity against dsh itself: proves the proxy is transparent for the
// page's own resources rather than subtly rewriting them.
const lastToken = [...readFileSync(DSH_LOG, 'utf8').matchAll(/token=([A-Za-z0-9_-]+)/g)].pop()[1]
const directLogin = await fetch(`${DSH}/?token=${lastToken}`, { redirect: 'manual' })
const directSession = cookieHeader(directLogin)
const differing = []
for (const url of assets) {
  const viaGateway = Buffer.from(await (await fetch(`${GATEWAY}${url}`, { headers: { cookie: session } })).arrayBuffer())
  const direct = Buffer.from(await (await fetch(`${DSH}${url}`, { headers: { cookie: directSession } })).arrayBuffer())
  if (!viaGateway.equals(direct)) differing.push(url.slice(0, 60))
}
check('proxied bytes are identical to direct', differing.length === 0, differing.slice(0, 3).join(', '))

// ── the /api trust fence through the tunnel ─────────────────────────────────

// The bug this guards against: dsh refuses a request whose Origin does not
// match its Host (`isTrustedApiRequest`), and behind the tunnel the browser's
// Origin is the public hostname while the gateway rewrites Host to loopback.
// Every RPC then failed 403 — the page loaded, so nothing looked broken until a
// directoryPicker call. These checks fail loudly if the gateway ever forwards a
// browser Origin again.

// Control: against dsh directly, a foreign Origin really is refused. This is
// the mechanism, not an assumption about it.
const foreignOrigin = await fetch(`${DSH}${API_PROBE}`, {
  headers: { cookie: directSession, origin: 'https://public.example' },
})
check('dsh directly refuses a mismatched Origin (the fence is real)',
  foreignOrigin.status === 403, `got ${foreignOrigin.status}`)

// And it accepts the matching one, so the gateway's rewrite is the thing that
// makes the difference rather than the fence being absent in this build.
const matchingOrigin = await fetch(`${DSH}${API_PROBE}`, {
  headers: { cookie: directSession, origin: `http://${new URL(DSH).host}` },
})
check('dsh directly accepts a matching Origin',
  matchingOrigin.status !== 403, `got ${matchingOrigin.status}`)

// The real case: a request shaped like the tunnel's — an Origin naming a public
// host that is not the inner authority. It must not be refused by the fence.
const viaGateway = await fetch(`${GATEWAY}${API_PROBE}`, {
  headers: { cookie: session, origin: 'https://public.example' },
})
check('a foreign Origin through the gateway is not refused by the fence',
  viaGateway.status !== 403, `got ${viaGateway.status}`)

// A cross-site fetch label is refused by the fence regardless of Origin, and
// the gateway must strip it for the same reason it rewrites Origin.
const crossSite = await fetch(`${GATEWAY}${API_PROBE}`, {
  headers: { cookie: session, 'sec-fetch-site': 'cross-site' },
})
check('a cross-site label through the gateway is not refused by the fence',
  crossSite.status !== 403, `got ${crossSite.status}`)

// ── websocket ───────────────────────────────────────────────────────────────

/** Open the RPC mux and report how it resolved. */
const upgrade = (headers) => new Promise((resolve) => {
  const socket = new WebSocket(`ws://127.0.0.1:${new URL(GATEWAY).port}/api/remote.mux`, { headers })
  const timer = setTimeout(() => { socket.close(); resolve('timeout') }, 5000)
  socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('open') }
  socket.onerror = () => { clearTimeout(timer); resolve('error') }
})
check('the RPC mux upgrades for a session', (await upgrade({ cookie: session })) === 'open')
// The mux carries Origin on a real browser upgrade, so it is the same fence.
check('the RPC mux upgrades despite a foreign Origin',
  (await upgrade({ cookie: session, origin: 'https://public.example' })) === 'open')
check('the RPC mux is refused without one', (await upgrade({})) !== 'open')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
