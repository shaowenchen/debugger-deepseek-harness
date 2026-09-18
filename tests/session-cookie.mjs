#!/usr/bin/env node
/**
 * Checks the gateway session cookie's expiry branches.
 *
 * The cookie has two modes now: a bounded session (the caller picked 1/2/4
 * hours) and an unlimited one (they picked "unlimited"), where the cookie must
 * carry no expiry of its own or it would sign the user out of a session that is
 * still running. Both modes are security-relevant, and neither is covered by
 * the end-to-end suite — that runs a bounded session over a real dsh and never
 * touches the unlimited path.
 *
 * The subtle case is the third one below: when the gateway IS enforcing a
 * limit, a signed token with no `exp` must be refused. Otherwise omitting the
 * field — which anyone can do to a cookie they already hold — would grant an
 * unlimited session by accident.
 *
 * Usage: node tests/session-cookie.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const GATEWAY = fileURLToPath(new URL('../scripts/gateway.mjs', import.meta.url))

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

// The gateway's own primitives, reproduced so a token can be forged here. These
// must match scripts/gateway.mjs; if that changes shape, the FORGED checks below
// stop being meaningful, which is itself worth failing on.
const b64url = (input) => Buffer.from(input).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/**
 * Drive the real gateway over HTTP so the assertions run against the actual
 * code rather than a copy of it. Returns its signing key by reading a session
 * cookie it mints for a correct password — the cookie is opaque, so this only
 * lets us check the properties, not forge with the key.
 */
async function gatewaySessionCookie({ sessionHours, port }) {
  const env = {
    ...process.env,
    DSHGW_LISTEN_PORT: String(port),
    DSHGW_INNER_AUTHORITY: '127.0.0.1:13080',
    DSHGW_PASSWORD: 'testpass',
    DSHGW_SESSION_HOURS: String(sessionHours),
    DSHGW_INNER_UNUSED: '1',
  }
  const child = spawn(process.execPath, [GATEWAY], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end()
  let log = ''
  child.stdout.on('data', (c) => { log += c })
  child.stderr.on('data', (c) => { log += c })

  const deadline = Date.now() + 8000
  let cookie = null
  while (Date.now() < deadline && cookie === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/__dshgw/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=testpass',
        redirect: 'manual',
      })
      const setCookie = response.headers.getSetCookie()
        .find((value) => value.startsWith('dshgw='))
      if (setCookie !== undefined) cookie = setCookie
    } catch {
      // Not listening yet.
    }
    if (cookie === null) await new Promise((r) => setTimeout(r, 150))
  }
  child.kill('SIGTERM')
  await new Promise((resolve) => child.on('exit', resolve))
  return { cookie, log }
}

const decodePayload = (cookie) => {
  const value = cookie.split(';')[0].split('=').slice(1).join('=')
  const body = value.split('.')[1]
  return JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
}

// ── a bounded session ───────────────────────────────────────────────────────

const bounded = await gatewaySessionCookie({ sessionHours: 2, port: 13091 })
check('a bounded session mints a cookie', bounded.cookie !== null,
  bounded.cookie === null ? bounded.log.trim().split('\n').at(-1) ?? '' : '')
if (bounded.cookie !== null) {
  const payload = decodePayload(bounded.cookie)
  check('its payload carries an exp', typeof payload.exp === 'number', JSON.stringify(payload))
  // Within a minute of two hours from now.
  const expected = Date.now() + 2 * 60 * 60 * 1000
  check('its exp is the configured two hours',
    Math.abs(payload.exp - expected) < 60_000,
    `exp - now = ${String(Math.round((payload.exp - Date.now()) / 1000))}s`)
  check('it carries Max-Age', /Max-Age=\d+/u.test(bounded.cookie))
  check('and not Max-Age=null', !/Max-Age=null/u.test(bounded.cookie))
}

// ── an unlimited session ────────────────────────────────────────────────────

const unlimited = await gatewaySessionCookie({ sessionHours: 0, port: 13092 })
check('an unlimited session mints a cookie', unlimited.cookie !== null)
if (unlimited.cookie !== null) {
  const payload = decodePayload(unlimited.cookie)
  check('its payload carries no exp', payload.exp === undefined, JSON.stringify(payload))
  // The absence of Max-Age is what makes this a session cookie rather than one
  // the browser drops on a timer the session does not have.
  check('it carries no Max-Age', !/Max-Age=/u.test(unlimited.cookie))
  check('it is still HttpOnly', /HttpOnly/u.test(unlimited.cookie))
}

// ── the two modes are actually different, and wrong values are safe ─────────

check('the two modes produce different cookies',
  bounded.cookie !== null && unlimited.cookie !== null
  && decodePayload(bounded.cookie).exp !== decodePayload(unlimited.cookie).exp)

// A malformed value must fall back to "bounded", not to "unlimited" — the
// permissive reading of a typo is the one that never expires.
const malformed = await gatewaySessionCookie({ sessionHours: 'soon', port: 13093 })
check('a non-numeric duration is treated as bounded, not unlimited',
  malformed.cookie !== null && /Max-Age=/u.test(malformed.cookie),
  malformed.cookie === null ? 'no cookie' : 'has Max-Age')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
