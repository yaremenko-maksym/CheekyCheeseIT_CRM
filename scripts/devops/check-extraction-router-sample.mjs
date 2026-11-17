#!/usr/bin/env node
// check-extraction-router-sample.mjs - the EXTRACTION_ROUTER_CONFIG line a file ships (the runbook's
// sample, the rehearsal's config) is a config the worker's router accepts with every route kept
// (ADR 2026-11-03, Amendment 2026-11-08 H.1). A stale `floorBudgetMs` or `local` route fails here.
//
// Usage: apps/api/node_modules/.bin/tsx --conditions=source scripts/devops/check-extraction-router-sample.mjs <file>
// It imports the worker's TypeScript source (no build needed): the same parse the worker runs at
// start, with throwaway keys for every route, so a dropped route means the config refused it.
// Never prints a key; the keys here are dummies anyway.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { parseWorkerEnv, hostedRoutesOf } = await import(
  join(repo, 'apps/api/src/extraction-worker/schema.ts')
)

const fail = (msg) => {
  console.error(`check-extraction-router-sample: ${msg}`)
  process.exit(1)
}

const file = process.argv[2]
if (!file) fail('usage: check-extraction-router-sample.mjs <file>')
const lines = readFileSync(file, 'utf8')
  .split('\n')
  .map((l) => /^\s*EXTRACTION_ROUTER_CONFIG=(\{.*)$/.exec(l)?.[1])
  .filter((l) => l !== undefined)
if (lines.length !== 1)
  fail(`${file}: expected exactly one EXTRACTION_ROUTER_CONFIG={...} line, found ${lines.length}`)

let sample
try {
  sample = JSON.parse(lines[0])
} catch {
  fail(`${file}: the EXTRACTION_ROUTER_CONFIG line is not JSON`)
}
const wanted = Array.isArray(sample?.routes) ? sample.routes.map((r) => r?.provider) : []
if (wanted.length === 0) fail(`${file}: the config names no route`)

const parsed = parseWorkerEnv({
  EXTRACTION_WORKER_SECRET: '0123456789abcdef'.repeat(4),
  INFERENCE_EXTRACTION_PROVIDER: 'router',
  EXTRACTION_ROUTER_CONFIG: lines[0],
  EXTRACTION_ROUTER_STATE_FILE: '/nonexistent/router-state.json',
  GEMINI_API_KEY: 'dummy-gemini-key',
  GROQ_API_KEY: 'dummy-groq-key',
  OPENROUTER_API_KEY: 'dummy-openrouter-key',
  CLOUDFLARE_AI_TOKEN: 'dummy-cloudflare-token',
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
})
if (!parsed.ok) fail(`${file}: the worker env was refused (${parsed.reason})`)
// `ok` is not acceptance: a refused config still builds a worker that answers NOT_CONFIGURED.
const { present } = hostedRoutesOf(parsed.env.routerConfig)
const missing = wanted.filter((p) => !present.includes(p))
if (present.length === 0 || missing.length > 0) {
  fail(
    `${file}: the router refused the config (routes kept: [${present.join(', ')}], wanted: [${wanted.join(', ')}])`,
  )
}
console.log(`OK ${file}: the router accepts the config, routes kept: ${present.join(', ')}`)
