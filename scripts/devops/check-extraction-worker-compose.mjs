#!/usr/bin/env node
// check-extraction-worker-compose.mjs - static guard for the extraction worker's isolation
// (ADR docs/architecture/2026-11-03-extraction-model-router.md §2.4, SR-L-4).
//
// Usage: node check-extraction-worker-compose.mjs <compose.yml> [<overlay.yml> ...]
//
// Resolves the files with `docker compose config --format json` (profile enabled, so the opt-in
// service is visible) and fails if the extraction-worker service is missing, publishes a port,
// uses host networking, leaves `extraction-internal`, or that network is not `internal: true`;
// or if any service other than the worker and `api` joins it. Compose runs in a temp dir with an
// empty .env.production so the real (gitignored) file is never read. Never prints env values.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const WORKER = 'extraction-worker'
const NET = 'extraction-internal'
const MAY_JOIN = new Set([WORKER, 'api'])

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: check-extraction-worker-compose.mjs <compose.yml> [overlay.yml ...]')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'extraction-compose-'))
let config
try {
  const args = ['compose']
  for (const f of files) {
    const dest = join(dir, basename(f))
    copyFileSync(resolve(f), dest)
    args.push('-f', dest)
  }
  writeFileSync(join(dir, '.env.production'), '')
  args.push('--profile', 'extraction', 'config', '--format', 'json')
  config = JSON.parse(
    execFileSync('docker', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, POSTGRES_PASSWORD: 'guard-placeholder' },
    }),
  )
} catch (err) {
  console.error(`ERROR: could not resolve the compose files: ${err.message.split('\n')[0]}`)
  process.exit(2)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const errors = []
const services = config.services ?? {}
const worker = services[WORKER]
if (!worker) {
  errors.push(`service ${WORKER} is missing`)
} else {
  if ((worker.ports ?? []).length > 0) errors.push(`${WORKER} must not publish ports (SR-L-4)`)
  if (worker.network_mode) errors.push(`${WORKER} must not set network_mode (${worker.network_mode})`)
  const nets = Object.keys(worker.networks ?? {})
  if (nets.length !== 1 || nets[0] !== NET) {
    errors.push(`${WORKER} must be on ${NET} only (found: ${nets.join(', ') || 'none'})`)
  }
  if (!(worker.profiles ?? []).includes('extraction')) {
    errors.push(`${WORKER} must stay opt-in behind the "extraction" profile`)
  }
}
if (config.networks?.[NET]?.internal !== true) errors.push(`network ${NET} must be internal: true`)
for (const [name, svc] of Object.entries(services)) {
  if (!MAY_JOIN.has(name) && Object.keys(svc.networks ?? {}).includes(NET)) {
    errors.push(`service ${name} must not join ${NET}`)
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`ERROR: ${e}`)
  process.exit(1)
}
console.log(`extraction-worker compose isolation OK (${files.map((f) => basename(f)).join(' + ')})`)
