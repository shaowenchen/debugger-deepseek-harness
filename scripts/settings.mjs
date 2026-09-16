#!/usr/bin/env node
/**
 * Write the managed custom-provider block into $DSH_HOME/settings.yaml.
 *
 * This is the native-start replacement for the image's sync-provider.sh: with
 * no container, nothing else expresses "use this gateway and model" to dsh.
 * The shape below is what dsh's own `llm-pi-ai` provider reads — a provider
 * whose `apiKeyEnv` names the environment variable the key travels in, and an
 * `agent-default-model` naming the provider and model to start on.
 *
 * Reads DSH_HOME, DSH_BASE_URL, DSH_MODEL, DSH_API_KEY. The first model id in
 * the comma-separated DSH_MODEL becomes the default.
 *
 * The block is delimited so a re-run replaces it instead of appending a second
 * declaration; dsh rejects a whole settings.yaml that declares the same top
 * level key twice.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME
const BASE_URL = process.env.DSH_BASE_URL
const MODEL = process.env.DSH_MODEL

if (!HOME) throw new Error('settings: DSH_HOME is required')
if (!BASE_URL) throw new Error('settings: DSH_BASE_URL is required')
if (!MODEL) throw new Error('settings: DSH_MODEL is required')

const BEGIN = '# >>> dsh-action-managed'
const END = '# <<< dsh-action-managed'

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
 * reject the document, so the managed block must be the only one.
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

const ids = MODEL.split(',').map((id) => id.trim()).filter((id) => id !== '')
if (ids.length === 0) throw new Error('settings: DSH_MODEL contains no model ids')

const settingsPath = join(HOME, 'settings.yaml')
mkdirSync(HOME, { recursive: true })

let existing = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
existing = stripKeys(stripManaged(existing)).trimEnd()

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

const block = `${BEGIN}
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

const next = existing === '' ? `${block}\n` : `${existing}\n\n${block}\n`
writeFileSync(settingsPath, next)
console.log(`settings: wrote ${ids.length} model(s) to ${settingsPath}, default ${ids[0]}`)
