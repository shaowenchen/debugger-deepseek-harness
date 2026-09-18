#!/usr/bin/env node
/**
 * Checks the gateway's public-URL discovery in isolation.
 *
 * This is the one piece of the tunnel wiring that CI otherwise never runs: the
 * end-to-end job starts the gateway with DSHGW_PUBLIC_URL set, so it takes the
 * explicit-override path and the discovery code below it is skipped entirely.
 * A break in discovery therefore shows up only as a missing link in a real run,
 * which is the slowest possible place to find it.
 *
 * A stub tunnel API stands in for the agent, so nothing here needs a tunnel, an
 * account, or a network. It asserts three things the action depends on:
 *   - discovery prefers the https endpoint (the login cookie is Secure under
 *     TLS, so a mixed scheme would break sign-in),
 *   - an explicit DSHGW_PUBLIC_URL wins and needs no agent at all,
 *   - a tunnel kind with no discovery is reported instead of silently yielding
 *     no link.
 *
 * Usage: node tests/url-discovery.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GATEWAY = fileURLToPath(new URL('../scripts/gateway.mjs', import.meta.url))
const WORK = mkdtempSync(join(tmpdir(), 'dshgw-url-'))

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

/** Wait for a file to hold something, or give up. Returns its contents. */
async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim()
      if (text !== '') return text
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return ''
}

/**
 * Run the gateway until it has published (or given up), and return its log.
 * `extraEnv` carries the per-tunnel settings a case needs.
 */
async function runGateway({ tunnel, urlFile, port, publicUrl = '', extraEnv = {} }) {
  const env = {
    ...process.env,
    DSHGW_LISTEN_PORT: String(port),
    DSHGW_INNER_AUTHORITY: '127.0.0.1:13080',
    DSHGW_PASSWORD: 'testpass',
    DSHGW_TUNNEL: tunnel,
    DSHGW_URL_FILE: urlFile,
    ...extraEnv,
  }
  if (publicUrl !== '') env.DSHGW_PUBLIC_URL = publicUrl
  else delete env.DSHGW_PUBLIC_URL

  const child = spawn(process.execPath, [GATEWAY], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end()
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })

  // Every case reaches its verdict within a few seconds: the override publishes
  // immediately, the stub answers on the first poll, and the unknown kind gives
  // up at once. Waiting on the process would hang the third case, which neither
  // publishes a URL nor exits — so wait on the outcome the case is about.
  const settled = await Promise.race([
    (async () => { while (!existsSync(urlFile)) await new Promise((r) => setTimeout(r, 100)); return true })(),
    new Promise((resolve) => setTimeout(() => resolve(false), 6000)),
  ])
  if (!settled) await new Promise((resolve) => setTimeout(resolve, 1500))
  child.kill('SIGTERM')
  await new Promise((resolve) => child.on('exit', resolve))
  return log
}

/** An ngrok-shaped inspection API, or a cloudflared-shaped metrics API. */
function startStubTunnelApi(port, tunnels) {
  const server = createServer((req, res) => {
    if (req.url !== '/api/tunnels') {
      res.statusCode = 404
      res.end('{}')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ tunnels }))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/**
 * cloudflared's metrics server, answering `/quicktunnel`.
 *
 * The payload shape matters: the real server returns a BARE hostname with no
 * scheme — cloudflared adds `https://` only for its human-facing banner — so
 * the stub reproduces that, and a gateway that echoed the value through would
 * publish a URL no browser can open.
 */
function startStubMetricsApi(port, hostname) {
  const server = createServer((req, res) => {
    if (req.url !== '/quicktunnel') {
      res.statusCode = 404
      res.end('{}')
      return
    }
    res.end(JSON.stringify({ hostname }))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

// ── discovery from the agent's API ──────────────────────────────────────────

const STUB_PORT = 14040
const stub = await startStubTunnelApi(STUB_PORT, [
  // http first, so a discovery that took the first entry would pick the wrong
  // one and this check would catch it.
  { public_url: 'http://random.ngrok-free.app' },
  { public_url: 'https://random.ngrok-free.app' },
])

const discoveredFile = join(WORK, 'discovered.txt')
const discoveredLog = await runGateway({
  tunnel: 'ngrok',
  urlFile: discoveredFile,
  port: 13081,
  extraEnv: { DSHGW_TUNNEL_API: `http://127.0.0.1:${String(STUB_PORT)}` },
})
const discovered = await waitForFile(discoveredFile)
check('discovery prefers the https endpoint', discovered === 'https://random.ngrok-free.app',
  `got "${discovered}"`)
check('discovery says where it read the URL from', discoveredLog.includes('ngrok API on port'),
  discoveredLog.trim().split('\n').at(-1) ?? '')

// A trailing slash on the published URL would double up against the paths the
// gateway serves, so the recorded origin must not carry one.
check('the recorded URL has no trailing slash', !discovered.endsWith('/'))

// ── the cloudflared log, used by the fallback cases below ───────────────────

const cfLog = join(WORK, 'cloudflared.log')
writeFileSync(cfLog, [
  '2026-09-18T10:00:00Z INF Thank you for trying Cloudflare Tunnel.',
  '2026-09-18T10:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2026-09-18T10:00:04Z INF +--------------------------------------------+',
  '2026-09-18T10:00:04Z INF |  Your quick Tunnel has been created! Visit it at:  |',
  '2026-09-18T10:00:04Z INF |  https://brave-lion-fights-hard.trycloudflare.com  |',
  '2026-09-18T10:00:04Z INF +--------------------------------------------+',
  '2026-09-18T10:00:05Z INF Registered tunnel connection',
].join('\n') + '\n')

// ── discovery from cloudflared's metrics API ────────────────────────────────
//
// This is the path a quick tunnel normally takes. The API reports a bare
// hostname, so the scheme has to be added; a discovery that passed the value
// through unchanged would publish "random.trycloudflare.com", which is not a
// URL.
//
// Ports are chosen well away from the real 20241 so a cloudflared running on
// the developer's machine cannot be mistaken for the stub.
const METRICS_PORT = 24001
const metricsStub = await startStubMetricsApi(METRICS_PORT, 'wandering-fox-sings-loud.trycloudflare.com')

const metricsFile = join(WORK, 'metrics.txt')
const metricsLog = await runGateway({
  tunnel: 'cloudflare',
  urlFile: metricsFile,
  port: 13087,
  extraEnv: { DSHGW_TUNNEL_API: `http://127.0.0.1:${String(METRICS_PORT)}` },
})
const metricsUrl = await waitForFile(metricsFile)
check('a bare hostname from the metrics API becomes an https URL',
  metricsUrl === 'https://wandering-fox-sings-loud.trycloudflare.com', `got "${metricsUrl}"`)
check('and it is attributed to the metrics server', metricsLog.includes('cloudflared metrics on port'))

// An empty hostname is what a NAMED tunnel's metrics server reports (it has no
// quick-tunnel hostname to give), so it must fall through to the log rather
// than being published as "https://".
const emptyMetricsPort = METRICS_PORT + 1
const emptyStub = await startStubMetricsApi(emptyMetricsPort, '')
const emptyFile = join(WORK, 'empty-metrics.txt')
const emptyLog = await runGateway({
  tunnel: 'cloudflare',
  urlFile: emptyFile,
  port: 13088,
  extraEnv: {
    DSHGW_TUNNEL_API: `http://127.0.0.1:${String(emptyMetricsPort)}`,
    DSHGW_TUNNEL_LOG: cfLog,
  },
})
const emptyUrl = await waitForFile(emptyFile)
check('an empty metrics hostname falls through to the log',
  emptyUrl === 'https://brave-lion-fights-hard.trycloudflare.com', `got "${emptyUrl}"`)
check('and it is attributed to the log, not the metrics server',
  emptyLog.includes('from the cloudflared log'))

// ── discovery from the log alone (no metrics server) ────────────────────────
//
// The fallback for when the metrics port cannot be reached — a collision that
// the scan misses, or an older cloudflared. The box-drawing and prose around
// the hostname are presentation and must not be what the match depends on.

const cfFile = join(WORK, 'cloudflare.txt')
const cfDiscoveryLog = await runGateway({
  tunnel: 'cloudflare',
  urlFile: cfFile,
  port: 13084,
  // A port nothing listens on, so discovery has only the log to go on.
  extraEnv: { DSHGW_TUNNEL_API: 'http://127.0.0.1:24009', DSHGW_TUNNEL_LOG: cfLog },
})
const cfUrl = await waitForFile(cfFile)
check('a quick tunnel URL is read from the agent log',
  cfUrl === 'https://brave-lion-fights-hard.trycloudflare.com', `got "${cfUrl}"`)
check('and it is attributed to the cloudflared log', cfDiscoveryLog.includes('from the cloudflared log'))

// The agent's banner mentions Cloudflare's own documentation before it ever
// reports a tunnel. A discovery that took the first https URL it saw would
// publish a docs link as the session URL — so the match must be specific to the
// trycloudflare.com hostname, not to "a URL in the log".
const bannerLog = join(WORK, 'banner.log')
writeFileSync(bannerLog, [
  '2026-09-18T10:00:00Z INF Thank you for trying Cloudflare Tunnel. See',
  '2026-09-18T10:00:00Z INF https://developers.cloudflare.com/cloudflare-one/ for help.',
  '2026-09-18T10:00:04Z INF |  https://quiet-owl-runs-deep.trycloudflare.com  |',
].join('\n') + '\n')
const bannerFile = join(WORK, 'banner.txt')
await runGateway({
  tunnel: 'cloudflare',
  urlFile: bannerFile,
  port: 13086,
  extraEnv: { DSHGW_TUNNEL_LOG: bannerLog },
})
const bannerUrl = await waitForFile(bannerFile)
check('an unrelated URL in the log is not mistaken for the tunnel',
  bannerUrl === 'https://quiet-owl-runs-deep.trycloudflare.com', `got "${bannerUrl}"`)

// A named (token) tunnel prints no hostname — Cloudflare already knows it — so
// the gateway must not invent one. It should end up with nothing, and the
// action supplies the URL explicitly instead.
const namedLog = join(WORK, 'named.log')
writeFileSync(namedLog, [
  '2026-09-18T10:00:00Z INF Registered tunnel connection connIndex=0 location=AMS',
  '2026-09-18T10:00:01Z INF Each HA connection\'s protocol: quic',
].join('\n') + '\n')
const namedFile = join(WORK, 'named.txt')
await runGateway({
  tunnel: 'cloudflare',
  urlFile: namedFile,
  port: 13085,
  extraEnv: { DSHGW_TUNNEL_LOG: namedLog },
})
check('a named tunnel publishes nothing without an explicit URL', !existsSync(namedFile))

// ── an explicit URL wins, with no agent running ─────────────────────────────

const overrideFile = join(WORK, 'override.txt')
await runGateway({
  tunnel: 'ngrok',
  // A port nothing listens on: if discovery were consulted here it would wait,
  // so this also proves the override short-circuits it.
  urlFile: overrideFile,
  publicUrl: 'https://pinned.example/',
  port: 13082,
  extraEnv: { DSHGW_TUNNEL_API: 'http://127.0.0.1:14041' },
})
const override = await waitForFile(overrideFile)
check('an explicit URL wins and is normalised', override === 'https://pinned.example',
  `got "${override}"`)

// ── an unknown tunnel kind is reported, not ignored ─────────────────────────

const unknownFile = join(WORK, 'unknown.txt')
const unknownLog = await runGateway({
  tunnel: 'nonesuch',
  urlFile: unknownFile,
  port: 13083,
  extraEnv: { DSHGW_TUNNEL_API: 'http://127.0.0.1:14042' },
})
check('an unknown tunnel kind is reported', unknownLog.includes("no URL discovery for a 'nonesuch'"),
  unknownLog.includes("no URL discovery for a 'nonesuch'") ? '' : unknownLog.trim())
check('an unknown tunnel kind publishes nothing', !existsSync(unknownFile))

stub.close()
metricsStub.close()
emptyStub.close()
rmSync(WORK, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
