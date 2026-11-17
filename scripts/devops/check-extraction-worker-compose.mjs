#!/usr/bin/env node
// check-extraction-worker-compose.mjs - static guard: a merged change cannot start the extraction
// worker on production, and the extraction project keeps its isolation
// (ADR docs/architecture/2026-11-03-extraction-model-router.md §2.4, §8.6; hosted-only since the
// Amendment 2026-11-08, egress network since the owner decision of 2026-11-17).
//
// Usage: node check-extraction-worker-compose.mjs \
//          --extraction <file> --deploy <prod.yml> --deploy <ghcr.yml> --names <path> [--names <path>]
//
//   --extraction  the separate project's compose file: resolved, then checked for exactly one
//                 service (the worker), no ports, no network_mode, its hardening and limits, and
//                 its two networks: the internal entry and its own egress, the worker alone on it.
//                 It is resolved a second time with the pin unset, and that must refuse.
//   --deploy      the composed deploy configuration, every profile on: its services must be exactly
//                 DEPLOY_SERVICES, with no extraction network and no external network.
//   --names       a deploy path (script, workflow) that must name neither the file nor the project.
//                 The network name crm-extraction-entry is allowed: that is the deploy's soft attach.
//
// Compose runs in a temp dir with empty env files, so the real (gitignored) ones are never read.
// Never prints env values. Exit: 0 clean, 1 finding, 2 could not look.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const WORKER = 'extraction-worker'
const PROJECT = 'crm-extraction'
const ENTRY = 'entry'
const ENTRY_NAME = 'crm-extraction-entry'
const EGRESS = 'egress'
// No fixed name: compose scopes it to the project, so no main-stack network can be this one.
const EGRESS_NAME = `${PROJECT}_${EGRESS}`
// A new service here starts on the next deploy, on the CRM's RAM. Adding one is a reviewed edit.
const DEPLOY_SERVICES = ['api', 'nginx', 'postgres']
const WORKER_MEM_BYTES = 512 * 1024 * 1024
const PINS = { EXTRACTION_WORKER_IMAGE_TAG: 'guard' }
// Drops anything the caller's shell exported: the unset-pin run must really be unset.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('EXTRACTION_')),
)

const { values: args } = parseArgs({
  options: {
    extraction: { type: 'string' },
    deploy: { type: 'string', multiple: true },
    names: { type: 'string', multiple: true },
  },
})
if (!args.extraction || !args.deploy?.length || !args.names?.length) {
  console.error('usage: --extraction <file> --deploy <file>... --names <path>...')
  process.exit(2)
}

function composeConfig(files, extraEnv, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-compose-'))
  try {
    const cmd = ['compose']
    for (const f of files) {
      const dest = join(dir, basename(f))
      copyFileSync(resolve(f), dest)
      cmd.push('-f', dest)
    }
    writeFileSync(join(dir, '.env.production'), '')
    writeFileSync(join(dir, '.env.extraction-worker'), '')
    cmd.push(...extraArgs, 'config', '--format', 'json')
    return JSON.parse(
      execFileSync('docker', cmd, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...CLEAN_ENV, POSTGRES_PASSWORD: 'guard-placeholder', ...extraEnv },
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let extraction
let deploy
try {
  extraction = composeConfig([args.extraction], PINS, ['--profile', '*'])
  // The production project name (the /opt/crm directory), so network names resolve as on the host.
  deploy = composeConfig(args.deploy, {}, ['--project-name', 'crm', '--profile', '*'])
} catch (err) {
  console.error(`ERROR: could not resolve the compose files: ${String(err.message).split('\n')[0]}`)
  process.exit(2)
}

const errors = []
const services = extraction.services ?? {}
const netsOf = (svc) => Object.keys(svc?.networks ?? {}).sort()

// ── The separate project ────────────────────────────────────────────────────
if (extraction.name !== PROJECT)
  errors.push(`the project must be named ${PROJECT} (found: ${extraction.name})`)

const worker = services[WORKER]
if (!worker) {
  errors.push(`service ${WORKER} is missing`)
} else {
  if ((worker.ports ?? []).length > 0) errors.push(`${WORKER} must not publish ports (SR-L-4)`)
  if ((worker.expose ?? []).length > 0) errors.push(`${WORKER} must not declare expose`)
  if (worker.network_mode)
    errors.push(`${WORKER} must not set network_mode (${worker.network_mode})`)
  if (worker.privileged) errors.push(`${WORKER} must not be privileged`)
  if (!(worker.security_opt ?? []).some((o) => /^no-new-privileges(:true)?$/.test(o))) {
    errors.push(`${WORKER} must set no-new-privileges`)
  }
  if (!(worker.cap_drop ?? []).includes('ALL')) errors.push(`${WORKER} must drop all capabilities`)
  if ((worker.cap_add ?? []).length > 0) errors.push(`${WORKER} must not add capabilities`)
  if (Number(worker.mem_limit) !== WORKER_MEM_BYTES)
    errors.push(`${WORKER} mem_limit must be ${WORKER_MEM_BYTES} bytes`)
  if (Number(worker.memswap_limit) !== WORKER_MEM_BYTES)
    errors.push(`${WORKER} memswap_limit must equal mem_limit`)
  if (Number(worker.cpus) !== 0.5) errors.push(`${WORKER} cpus must be 0.5`)
  if (Number(worker.pids_limit) !== 64) errors.push(`${WORKER} pids_limit must be 64`)
  if (worker.read_only !== true) errors.push(`${WORKER} must run with read_only: true`)
  if (!(worker.volumes ?? []).some((v) => v.target === '/var/lib/extraction-worker'))
    errors.push(`${WORKER} must keep its state volume at /var/lib/extraction-worker`)
  if (netsOf(worker).join() !== [EGRESS, ENTRY].join()) {
    errors.push(
      `${WORKER} must be on ${ENTRY} and ${EGRESS} only (found: ${netsOf(worker).join(', ') || 'none'})`,
    )
  }
  if ((worker.profiles ?? []).length > 0)
    errors.push(`${WORKER} must not hide behind a profile in its own project`)
}

const nets = extraction.networks ?? {}
if (nets[ENTRY]?.internal !== true) errors.push(`network ${ENTRY} must be internal: true`)
if (nets[ENTRY]?.name !== ENTRY_NAME)
  errors.push(`network ${ENTRY} must keep the name ${ENTRY_NAME}`)
if (!nets[EGRESS]) {
  errors.push(`network ${EGRESS} is missing: the hosted routes have no way out`)
} else {
  if (nets[EGRESS].internal === true)
    errors.push(`network ${EGRESS} must not be internal: the hosted routes need it`)
  // A fixed name could be a main-stack network (crm_backend): the worker would share it with postgres.
  if (nets[EGRESS].name !== EGRESS_NAME)
    errors.push(
      `network ${EGRESS} must resolve to ${EGRESS_NAME}, the project's own (found: ${nets[EGRESS].name})`,
    )
}
for (const [key, net] of Object.entries(nets)) {
  if (net.external)
    errors.push(`network ${key} must not be external: the project owns its networks`)
  if (key !== ENTRY && key !== EGRESS)
    errors.push(`unexpected network ${key} in the extraction project`)
}

for (const [name, svc] of Object.entries(services)) {
  if (name !== WORKER) errors.push(`unexpected service ${name} in the extraction project`)
  for (const net of [ENTRY, EGRESS]) {
    if (name !== WORKER && netsOf(svc).includes(net))
      errors.push(`service ${name} must not join ${net}`)
  }
  if (typeof svc.network_mode === 'string' && svc.network_mode.startsWith('service:')) {
    errors.push(`service ${name} must not share another service's network namespace`)
  }
}

// An unset pin must refuse. Fetched by resolving with every pin removed, one at a time.
for (const pin of Object.keys(PINS)) {
  const without = { ...PINS }
  delete without[pin]
  let refused = false
  try {
    composeConfig([args.extraction], without)
  } catch {
    refused = true
  }
  if (!refused) errors.push(`an unset ${pin} must make compose refuse`)
}

// ── The composed deploy configuration ───────────────────────────────────────
const deployed = Object.keys(deploy.services ?? {}).sort()
if (deployed.length === 0)
  errors.push('the composed deploy configuration has no services: nothing was checked')
for (const name of deployed) {
  if (!DEPLOY_SERVICES.includes(name)) {
    errors.push(
      `the deploy configuration gained service ${name}: a merged service starts on the next deploy (ADR §8.6)`,
    )
  }
}
for (const [key, net] of Object.entries(deploy.networks ?? {})) {
  if (net.external)
    errors.push(
      `the deploy configuration must not use external network ${key}: a missing one fails its up`,
    )
  if (String(net.name ?? key).includes('extraction'))
    errors.push(`the deploy configuration must not declare network ${key}`)
}

// ── The deploy paths must not name the file or the project ──────────────────
for (const path of args.names) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    console.error(`ERROR: could not read ${path}: ${err.message}`)
    process.exit(2)
  }
  if (text.length === 0) errors.push(`${path} is empty: nothing was checked`)
  if (/docker-compose\.extraction|crm-extraction(?!-entry)/.test(text)) {
    errors.push(`${basename(path)} names the extraction project or its file (ADR §8.6)`)
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`ERROR: ${e}`)
  process.exit(1)
}
console.log(`extraction project isolation OK (deploy services: ${deployed.join(', ')})`)
