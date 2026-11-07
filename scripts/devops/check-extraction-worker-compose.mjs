#!/usr/bin/env node
// check-extraction-worker-compose.mjs - static guard: a merged change cannot start the local model
// on production, and the extraction project keeps its isolation
// (ADR docs/architecture/2026-11-03-extraction-model-router.md §2.4, §8.3, §8.6).
//
// Usage: node check-extraction-worker-compose.mjs \
//          --extraction <file> --deploy <prod.yml> --deploy <ghcr.yml> --names <path> [--names <path>]
//
//   --extraction  the separate project's compose file: resolved, then checked for no ports, no
//                 network_mode, network membership, runtime hardening and limits, pinned digests.
//                 It is resolved a second time with the pins unset, and that must refuse.
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
const RUNTIME = 'crm-model-runtime'
const FETCH = 'weights-fetch'
const PROJECT = 'crm-extraction'
const ENTRY = 'entry'
const ENTRY_NAME = 'crm-extraction-entry'
const RUNTIME_NET = 'runtime'
// A new service here starts on the next deploy, on the CRM's RAM. Adding one is a reviewed edit.
const DEPLOY_SERVICES = ['api', 'nginx', 'postgres', 'redis']
const RUNTIME_MEM_BYTES = 3584 * 1024 * 1024
const WORKER_MEM_BYTES = 512 * 1024 * 1024
const PINS = {
  EXTRACTION_RUNTIME_IMAGE_SHA256: 'a'.repeat(64),
  EXTRACTION_MODEL_FILE: 'guard.gguf',
  EXTRACTION_MODEL_SHA256: 'b'.repeat(64),
  EXTRACTION_RUNTIME_CONTEXT_TOKENS: '8192',
  EXTRACTION_WORKER_IMAGE_TAG: 'guard',
}
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
if (extraction.name !== PROJECT) errors.push(`the project must be named ${PROJECT} (found: ${extraction.name})`)

function checkHardened(name, svc, memBytes) {
  if ((svc.ports ?? []).length > 0) errors.push(`${name} must not publish ports (SR-L-4)`)
  if ((svc.expose ?? []).length > 0) errors.push(`${name} must not declare expose`)
  if (svc.network_mode) errors.push(`${name} must not set network_mode (${svc.network_mode})`)
  if (svc.privileged) errors.push(`${name} must not be privileged`)
  if (!(svc.security_opt ?? []).some((o) => /^no-new-privileges(:true)?$/.test(o))) {
    errors.push(`${name} must set no-new-privileges`)
  }
  if (!(svc.cap_drop ?? []).includes('ALL')) errors.push(`${name} must drop all capabilities`)
  if ((svc.cap_add ?? []).length > 0) errors.push(`${name} must not add capabilities`)
  if (Number(svc.mem_limit) !== memBytes) errors.push(`${name} mem_limit must be ${memBytes} bytes`)
  if (Number(svc.memswap_limit) !== memBytes) errors.push(`${name} memswap_limit must equal mem_limit`)
}

const worker = services[WORKER]
if (!worker) {
  errors.push(`service ${WORKER} is missing`)
} else {
  checkHardened(WORKER, worker, WORKER_MEM_BYTES)
  if (Number(worker.cpus) !== 0.5) errors.push(`${WORKER} cpus must be 0.5`)
  if (netsOf(worker).join() !== [ENTRY, RUNTIME_NET].join()) {
    errors.push(`${WORKER} must be on ${ENTRY} and ${RUNTIME_NET} only (found: ${netsOf(worker).join(', ') || 'none'})`)
  }
  if ((worker.profiles ?? []).length > 0) errors.push(`${WORKER} must not hide behind a profile in its own project`)
}

const runtime = services[RUNTIME]
if (!runtime) {
  errors.push(`service ${RUNTIME} is missing`)
} else {
  checkHardened(RUNTIME, runtime, RUNTIME_MEM_BYTES)
  if (Number(runtime.cpus) !== 2) errors.push(`${RUNTIME} cpus must be 2`)
  if (Number(runtime.pids_limit) !== 128) errors.push(`${RUNTIME} pids_limit must be 128`)
  if (netsOf(runtime).join() !== RUNTIME_NET) {
    errors.push(`${RUNTIME} must be on ${RUNTIME_NET} only (found: ${netsOf(runtime).join(', ') || 'none'})`)
  }
  if (!/@sha256:[0-9a-f]{64}$/.test(runtime.image ?? '')) errors.push(`${RUNTIME} image must be pinned by sha256`)
  const user = String(runtime.user ?? '').split(':')[0]
  if (user === '' || user === '0' || user === 'root') errors.push(`${RUNTIME} must run non-root`)
  const start = [...(runtime.entrypoint ?? []), ...(runtime.command ?? [])].join(' ')
  for (const flag of ['sha256sum -c', '--log-disable', '--ctx-size', '--threads 2', '--parallel 1']) {
    if (!start.includes(flag)) errors.push(`${RUNTIME} start command must carry "${flag}"`)
  }
  if ((runtime.volumes ?? []).some((v) => v.target === '/models' && v.read_only !== true)) {
    errors.push(`${RUNTIME} must mount the weights read-only`)
  }
}

for (const key of [ENTRY, RUNTIME_NET]) {
  if (extraction.networks?.[key]?.internal !== true) errors.push(`network ${key} must be internal: true`)
}
if (extraction.networks?.[ENTRY]?.name !== ENTRY_NAME) errors.push(`network ${ENTRY} must keep the name ${ENTRY_NAME}`)
for (const [key, net] of Object.entries(extraction.networks ?? {})) {
  if (net.external) errors.push(`network ${key} must not be external: the project owns its networks`)
}

const MAY_JOIN = { [ENTRY]: [WORKER], [RUNTIME_NET]: [WORKER, RUNTIME] }
for (const [name, svc] of Object.entries(services)) {
  for (const [net, allowed] of Object.entries(MAY_JOIN)) {
    if (netsOf(svc).includes(net) && !allowed.includes(name)) errors.push(`service ${name} must not join ${net}`)
  }
  if (typeof svc.network_mode === 'string' && svc.network_mode.startsWith('service:')) {
    errors.push(`service ${name} must not share another service's network namespace`)
  }
  if (name !== WORKER && name !== RUNTIME) {
    if (name !== FETCH) errors.push(`unexpected service ${name} in the extraction project`)
    if (!(svc.profiles ?? []).length) errors.push(`service ${name} must stay behind a profile`)
    if ((svc.ports ?? []).length > 0) errors.push(`service ${name} must not publish ports`)
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
if (deployed.length === 0) errors.push('the composed deploy configuration has no services: nothing was checked')
for (const name of deployed) {
  if (!DEPLOY_SERVICES.includes(name)) {
    errors.push(`the deploy configuration gained service ${name}: a merged service starts on the next deploy (ADR §8.6)`)
  }
}
for (const [key, net] of Object.entries(deploy.networks ?? {})) {
  if (net.external) errors.push(`the deploy configuration must not use external network ${key}: a missing one fails its up`)
  if (String(net.name ?? key).includes('extraction')) errors.push(`the deploy configuration must not declare network ${key}`)
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
