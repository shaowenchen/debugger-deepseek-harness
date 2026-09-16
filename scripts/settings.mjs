#!/usr/bin/env node
/**
 * Write the model configuration into $DSH_HOME/settings.yaml — the file dsh
 * reads at startup.
 *
 * dsh has no model flag on its command line: the selection lives in the
 * `agent-default-model` settings section, whose built-in default (set by the
 * base bundle's cordis.patch.yml) is
 * `{provider: deepseek-official, model: deepseek-flash}`. Writing that section
 * here is what makes the caller's choice take effect at boot.
 *
 * Reads DSH_HOME, DSH_BASE_URL, DSH_MODEL.
 *
 * Two routes, chosen by DSH_BASE_URL:
 *
 *   - unset — dsh's official DeepSeek route. Only the default-model selection
 *     is written, naming provider `deepseek-official`; the model catalog and
 *     the credential stay dsh's own.
 *   - set — an OpenAI-compatible gateway, declared under `llm-pi-ai` with an
 *     `apiKeyEnv` naming the environment variable the key travels in. Every id
 *     in the comma-separated DSH_MODEL is registered there and the first
 *     becomes the default selection.
 *
 * On the OFFICIAL route the value `default` (or an empty value) is a sentinel
 * meaning "no explicit choice": nothing is written, leaving dsh its own default
 * model. On a CUSTOM route `default` is an ordinary model id — see
 * {@link isSentinel} for why the two routes differ.
 *
 * The block is delimited so a re-run replaces it instead of appending a second
 * declaration; dsh rejects a whole settings.yaml that declares the same top
 * level key twice.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME
const BASE_URL = (process.env.DSH_BASE_URL ?? '').trim()
const MODEL = (process.env.DSH_MODEL ?? '').trim()

if (!HOME) throw new Error('settings: DSH_HOME is required')

const BEGIN = '# >>> dsh-action-managed'
const END = '# <<< dsh-action-managed'

/** The provider route llm-deepseek registers for the official endpoint. */
const OFFICIAL_PROVIDER = 'deepseek-official'

/**
 * Whether the caller named no model. An empty value means that outright; the
 * literal `default` is the workflow form's default, so it reads the same way.
 *
 * This only means "leave it to the endpoint" on the OFFICIAL route, which has
 * its own default model to fall back on. On a custom route the id is used
 * literally: the gateway belongs to the caller, and this action cannot know
 * which ids it accepts — refusing the value would fail a session whose gateway
 * serves a model actually called `default`, and would make `base_url` depend on
 * `model` having a non-default value.
 */
const isSentinel = MODEL === '' || MODEL === 'default'

/** Single-quote a YAML scalar, doubling embedded quotes. */
const yaml = (value) => `'${String(value).replaceAll("'", "''")}'`

/** Drop the previous managed block, if any, from the existing settings text. */
function stripManaged(text) {
  const lines = text.split('\n')
  const kept = []
  let skipping = false
  for (const line of lines) {
    if (line === BEGIN) { skipping = true; continue }
    if (skipping && line === END) { skipping = false; continue }
    if (!skipping) kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Drop hand-written top-level keys the managed block owns. Two declarations of
 * one top-level key (say a second `llm-pi-ai` added through the web UI) make dsh
 * reject the document, so the managed block must be the only one. Both keys are
 * stripped on every route, so switching between them cannot leave the other
 * route's configuration behind.
 */
function stripKeys(text) {
  const lines = text.split('\n')
  const kept = []
  let skipping = false
  for (const line of lines) {
    if (skipping) {
      // A continuation is indented, blank, or a comment; anything else starts
      // the next top-level key.
      if (/^\s/.test(line) || line === '' || line.startsWith('#')) continue
      skipping = false
    }
    if (line === 'llm-pi-ai:' || line === 'agent-default-model:') { skipping = true; continue }
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * The model ids to register, in order; the first becomes the default.
 *
 * On the official route the sentinel names no model at all. On a custom route
 * it is an ordinary id, so it survives — see {@link isSentinel}.
 */
const parseIds = (text) => text.split(',').map((id) => id.trim()).filter((id) => id !== '')
const ids = BASE_URL === ''
  ? (isSentinel ? [] : parseIds(MODEL))
  : parseIds(MODEL)

const settingsPath = join(HOME, 'settings.yaml')
mkdirSync(HOME, { recursive: true })

let existing = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
existing = stripKeys(stripManaged(existing)).trimEnd()

let block = ''
let description = ''

if (BASE_URL === '') {
  // The official route needs no provider block: llm-deepseek already owns the
  // route, its catalog, and its default credential name. Only the selection is
  // written, and only when the caller made one — with no choice there is
  // nothing to say, and staying silent leaves dsh free to change its own
  // default model without this action pinning it.
  if (!isSentinel) {
    block = `${BEGIN}
agent-default-model:
  provider: ${yaml(OFFICIAL_PROVIDER)}
  model: ${yaml(ids[0])}
${END}`
    description = `official DeepSeek, default model ${ids[0]}`
  } else {
    description = 'official DeepSeek, dsh default model'
  }
} else {
  if (ids.length === 0) {
    // Only an empty value lands here now: `default` is a usable id on this
    // route (see isSentinel). A provider block with no models is not a valid
    // declaration, so an empty list cannot be written.
    throw new Error('settings: DSH_BASE_URL is set, so DSH_MODEL must name at least one model id')
  }

  // Declaring reasoningEfforts opts each model into the selectable-thinking UI.
  // The seven levels map to OpenAI-compatible wire spellings; `off` sends no
  // reasoning field, matching the provider-wide default below.
  const modelBlocks = ids.map((id) => `        - id: ${yaml(id)}
          reasoningEfforts:
            off: null
            minimal: minimal_effort
            low: low_effort
            medium: medium_effort
            high: high_effort
            xhigh: xhigh_effort
            max: max_effort
          compat:
            supportsReasoningEffort: true`).join('\n')

  block = `${BEGIN}
llm-pi-ai:
  providers:
    custom:
      displayName: Custom
      apiKeyEnv: API_KEY
      api: openai-completions
      baseURL: ${yaml(BASE_URL)}
      reasoning: off
      defaultInput: [text, image]
      models:
${modelBlocks}
agent-default-model:
  provider: custom
  model: ${yaml(ids[0])}
${END}`
  description = `${ids.length} model(s) at ${BASE_URL}, default ${ids[0]}`
}

const next = block === ''
  ? existing
  : existing === '' ? block : `${existing}\n\n${block}`

if (next.trim() === '') {
  // Nothing to configure and nothing left over. An empty settings.yaml is not
  // the same as no file: dsh reads the file it finds.
  rmSync(settingsPath, { force: true })
  console.log(`settings: ${description}; no file needed`)
} else {
  writeFileSync(settingsPath, `${next}\n`)
  console.log(`settings: ${description}; wrote ${settingsPath}`)
}
