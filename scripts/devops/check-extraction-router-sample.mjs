#!/usr/bin/env node
// check-extraction-router-sample.mjs - the EXTRACTION_ROUTER_CONFIG line a file ships (the runbook's
// sample, the rehearsal's config) is a config the worker's router accepts with every route kept
// (ADR 2026-11-03, Amendment 2026-11-08 H.1). A stale `floorBudgetMs` or `local` route fails here.
//
// Usage: apps/api/node_modules/.bin/tsx --conditions=source scripts/devops/check-extraction-router-sample.mjs <file> [--deploy <deploy.yml>]
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

// With `--deploy <deploy.yml>`: the API's input window that deploy.yml writes as two literals must be
// the sample's smallest route (ADR 2026-11-03 H.4), the one with the least room for the input
// (contextTokens - maxAnswerTokens). On a tie any of those routes is right: the API uses only the room.
const deployAt = process.argv.indexOf('--deploy')
if (deployAt !== -1) {
  const deploy = process.argv[deployAt + 1]
  if (!deploy) fail('usage: check-extraction-router-sample.mjs <file> --deploy <deploy.yml>')
  const text = readFileSync(deploy, 'utf8')
  const literal = (key) => {
    const found = [...text.matchAll(new RegExp(`^\\s*printf '${key}=%s\\\\n' '(\\d+)'`, 'gm'))].map(
      (m) => Number(m[1]),
    )
    if (found.length !== 1)
      fail(`${deploy}: expected exactly one printf of ${key}, found ${found.length}`)
    return found[0]
  }
  const ctx = literal('EXTRACTION_INPUT_CONTEXT_TOKENS')
  const answer = literal('EXTRACTION_INPUT_MAX_ANSWER_TOKENS')
  for (const r of sample.routes) {
    if (!Number.isInteger(r.contextTokens) || !Number.isInteger(r.maxAnswerTokens))
      fail(`${file}: route ${r.provider} has no integer contextTokens / maxAnswerTokens`)
  }
  const room = (r) => r.contextTokens - r.maxAnswerTokens
  const least = Math.min(...sample.routes.map(room))
  const smallest = sample.routes.filter((r) => room(r) === least)
  if (!smallest.some((r) => r.contextTokens === ctx && r.maxAnswerTokens === answer)) {
    const want = smallest.map((r) => `${r.provider} ${r.contextTokens}/${r.maxAnswerTokens}`)
    fail(
      `${deploy}: the input window drifted from ${file}: deploy writes ${ctx}/${answer}, the smallest route is ${want.join(' or ')}`,
    )
  }
  console.log(`OK ${deploy}: the input window ${ctx}/${answer} is the smallest route of ${file}`)
}
