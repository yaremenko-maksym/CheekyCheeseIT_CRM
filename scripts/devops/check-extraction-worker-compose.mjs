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
//                 Two names are allowed: crm-extraction-entry (the deploy's soft attach) and
//                 crm-extraction-worker (the worker's alias, the host of the API's worker URL).
//
// Compose runs in a temp dir with empty env files, so the real (gitignored) ones are never read.
// Never prints env values. Exit: 0 clean, 1 finding, 2 could not look.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const WORKER = 'extraction-worker'
const PROJECT = 'crm-extraction'
const ENTRY = 'entry'
const ENTRY_NAME = 'crm-extraction-entry'
const EGRESS = 'egress'
// No fixed name: compose scopes it to the project, so no main-stack network can be this one.
const EGRESS_NAME = `${PROJECT}_${EGRESS}`
// Pinned so the later host egress firewall can target it (owner decision 2026-11-17, D4).
const EGRESS_SUBNET = '10.250.17.0/28'
// The one plain-HTTP host the API's transport accepts (packages/inference/src/http/bounded-request.ts).
const WORKER_ALIAS = 'crm-extraction-worker'
const WORKER_ENV_FILE = '.env.extraction-worker'
const STATE_TARGET = '/var/lib/extraction-worker'
// A new service here starts on the next deploy, on the CRM's RAM. Adding one is a reviewed edit.
const DEPLOY_SERVICES = ['api', 'nginx', 'postgres']
const WORKER_MEM_BYTES = 512 * 1024 * 1024
const PINS = { EXTRACTION_WORKER_IMAGE_TAG: 'guard' }
// An allow-list, not a deny-list: each key a compose release adds (devices, sysctls, volumes_from,
// secrets, configs, runtime, ...) is refused until it is reviewed. Exactly what the shipped file uses.
const WORKER_KEYS = [
  'cap_drop',
  'command',
  'cpus',
  'env_file',
  'environment',
  'healthcheck',
  'image',
  'logging',
  'mem_limit',
  'memswap_limit',
  'networks',
  'pids_limit',
  'read_only',
  'restart',
  'security_opt',
  'tmpfs',
  'user',
  'volumes',
]
// No top-level configs or secrets: a `file:` source is a host path read into the worker.
const TOP_KEYS = ['name', 'networks', 'services', 'volumes']
const STATE_VOLUME = 'worker_state'
// Network keys the shipped file sets (compose fills `name` and `ipam`). Anything else (driver_opts,
// attachable, labels, ...) is refused until reviewed; `driver` and `enable_ipv6` also get value checks.
const NET_KEYS = ['driver', 'enable_ipv6', 'internal', 'ipam', 'name']
// Logs stay on the host's own driver: gelf or syslog would ship the worker's output off-host,
// around any later subnet firewall. Options: exactly what the shipped file sets.
const LOG_DRIVER = 'json-file'
const LOG_OPTION_KEYS = ['max-file', 'max-size']
// The pinned image repository (everything before the tag). The tag is the owner's pin.
const WORKER_IMAGE_REPO = 'ghcr.io/yaremenko-maksym/cheekycheeseit-crm-api'
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

const setKeys = (obj) =>
  Object.entries(obj ?? {})
    .filter(([, v]) => v !== null)
    .map(([k]) => k)

// `configArgs` go after `config`; `post` sees the parsed config and the temp dir before its removal.
function composeConfig(files, extraEnv, extraArgs = [], { configArgs = [], post = (j) => j } = {}) {
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
    cmd.push(...extraArgs, 'config', ...configArgs, '--format', 'json')
    const json = JSON.parse(
      execFileSync('docker', cmd, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...CLEAN_ENV, POSTGRES_PASSWORD: 'guard-placeholder', ...extraEnv },
      }),
    )
    return post(json, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let extraction
let deploy
// The normal resolution inlines env_file into environment and drops it, and adds an empty
// `entrypoint`; this one keeps the keys as written, so it is the one the allow-list reads.
let raw
let nameAsWritten
try {
  extraction = composeConfig([args.extraction], PINS, ['--profile', '*'])
  raw = composeConfig([args.extraction], PINS, ['--profile', '*'], {
    configArgs: ['--no-interpolate'],
    post: (json, dir) => ({
      json,
      envFiles: (json.services?.[WORKER]?.env_file ?? []).map((f) =>
        relative(dir, typeof f === 'string' ? f : f.path),
      ),
    }),
  })
  // A separate call: the shared raw call keeps its inputs, the name is read with --no-normalize.
  nameAsWritten = composeConfig([args.extraction], PINS, ['--profile', '*'], {
    configArgs: ['--no-interpolate', '--no-normalize'],
    post: (json) => json.name,
  })
  // The production project name (the /opt/crm directory), so network names resolve as on the host.
  deploy = composeConfig(args.deploy, {}, ['--project-name', 'crm', '--profile', '*'])
} catch (err) {
  console.error(`ERROR: could not resolve the compose files: ${String(err.message).split('\n')[0]}`)
  process.exit(2)
}

const errors = []
const services = extraction.services ?? {}
const netsOf = (svc) => Object.keys(svc?.networks ?? {}).sort()
// The file as written. The resolved config hides what the host env decides at `up` and drops some
// keys (ipam.options), so keys, attachments and network definitions are read here.
const rawWorker = raw.json.services?.[WORKER] ?? {}
const rawNets = raw.json.networks ?? {}

// ── The separate project ────────────────────────────────────────────────────
if (extraction.name !== PROJECT)
  errors.push(`the project must be named ${PROJECT} (found: ${extraction.name})`)
// A null is a key some compose release fills in, not one the file sets.
for (const key of setKeys(raw.json).filter((k) => !TOP_KEYS.includes(k)))
  errors.push(`the extraction project must not declare top-level ${key}`)

// A `$` left in the raw config is a value the host env decides at `up`, after the guard has looked
// (`driver: ${X:-json-file}`). The one exception: the owner's image tag pin after the repository.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const IMAGE_PIN = new RegExp(
  `^${escapeRe(WORKER_IMAGE_REPO)}:\\$\\{EXTRACTION_WORKER_IMAGE_TAG(?::?[-?][^$}]*)?\\}(?:@sha256:[0-9a-f]{64})?$`,
)
const withDollar = (v, path) => {
  if (typeof v === 'string') return v.includes('$') ? [path] : []
  if (!v || typeof v !== 'object') return []
  return Object.entries(v).flatMap(([k, x]) => [
    ...(k.includes('$') ? [`${path}.${k}`] : []),
    ...withDollar(x, `${path}.${k}`),
  ])
}
const { image: rawImage, ...rawWorkerRest } = rawWorker
for (const path of [
  ...withDollar(rawWorkerRest, WORKER),
  ...(withDollar(rawImage, '').length > 0 && !IMAGE_PIN.test(rawImage) ? [`${WORKER}.image`] : []),
  ...withDollar(rawNets, 'networks'),
  ...withDollar(raw.json.volumes, 'volumes'),
])
  errors.push(
    `${path} must hold no variable: the host env would decide it at up (only the image tag pin may)`,
  )
// The name as written, with no normalisation: compose lowercases it and drops `$ { } :`, so
// `${__:-crm-extraction}` would read as crm-extraction. A missing key reads as undefined and fails.
if (nameAsWritten !== PROJECT)
  errors.push(
    `name must hold no variable: the top-level name must read ${PROJECT} as written (found: ${nameAsWritten})`,
  )
// An environment entry with no value takes its value from the host at `up`, whatever its key:
// a map key with null (`KEY:`), or a list item with no `=` (`- KEY`). The raw config keeps both forms.
const rawEnv = rawWorker.environment ?? {}
const valueless = Array.isArray(rawEnv)
  ? rawEnv.filter((e) => typeof e !== 'string' || !e.includes('='))
  : Object.entries(rawEnv)
      .filter(([, v]) => v === null || v === undefined)
      .map(([k]) => k)
for (const key of valueless)
  errors.push(`${WORKER}.environment.${key} must carry a value: the host env would decide it at up`)

const worker = services[WORKER]
if (!worker) {
  errors.push(`service ${WORKER} is missing`)
} else {
  for (const key of setKeys(rawWorker).filter((k) => !WORKER_KEYS.includes(k)))
    errors.push(`${WORKER} must not set ${key}: not in the reviewed key allow-list`)
  // Per-network attachment keys: ipv4_address, mac_address, driver_opts (endpoint sysctls such as
  // route_localnet), link_local_ips, interface_name, priority, gw_priority... Entry: aliases only.
  for (const [net, att] of Object.entries(rawWorker.networks ?? {})) {
    const allowed = net === ENTRY ? ['aliases'] : []
    for (const k of setKeys(att).filter((k) => !allowed.includes(k)))
      errors.push(
        `${WORKER} must set ${allowed.length > 0 ? 'only aliases' : 'nothing'} on network ${net} (found: ${k})`,
      )
  }
  if ((worker.ports ?? []).length > 0) errors.push(`${WORKER} must not publish ports (SR-L-4)`)
  if ((worker.expose ?? []).length > 0) errors.push(`${WORKER} must not declare expose`)
  if (worker.network_mode)
    errors.push(`${WORKER} must not set network_mode (${worker.network_mode})`)
  if (worker.privileged) errors.push(`${WORKER} must not be privileged`)
  const secOpts = worker.security_opt ?? []
  if (!secOpts.some((o) => /^no-new-privileges(:true)?$/.test(o))) {
    errors.push(`${WORKER} must set no-new-privileges`)
  }
  // An allow-list: seccomp/apparmor unconfined, label:disable and the like are one line away.
  for (const o of secOpts.filter((o) => !/^no-new-privileges(:true)?$/.test(o))) {
    errors.push(`${WORKER} must set no security_opt but no-new-privileges (found: ${o})`)
  }
  // Each shares a host namespace (or another container's) with the worker.
  for (const key of ['pid', 'ipc', 'uts', 'userns_mode', 'cgroup']) {
    if (worker[key]) errors.push(`${WORKER} must not set ${key} (${worker[key]})`)
  }
  if (worker.user !== 'node')
    errors.push(
      `${WORKER} must run as user node, the image's own (found: ${worker.user ?? 'unset'})`,
    )
  const hosts = worker.extra_hosts ?? []
  if ((Array.isArray(hosts) ? hosts : Object.keys(hosts)).length > 0)
    errors.push(`${WORKER} must not set extra_hosts`)
  if (raw.envFiles.join() !== WORKER_ENV_FILE)
    errors.push(
      `${WORKER} env_file must be exactly ${WORKER_ENV_FILE} (found: ${raw.envFiles.join(', ') || 'none'})`,
    )
  // Long syntax: path and required only. `format` changes how the file is parsed; any required but
  // the literal `true` (false, "false", ${OPT:-false}) lets the worker start without its file.
  for (const f of (rawWorker.env_file ?? []).filter((f) => typeof f !== 'string')) {
    for (const k of Object.keys(f).filter((k) => k !== 'path' && k !== 'required'))
      errors.push(`${WORKER} env_file must be a plain path (found: ${k}: ${f[k]})`)
    if (f.required !== undefined && f.required !== true)
      errors.push(
        `${WORKER} env_file must be a plain path (found: required: ${JSON.stringify(f.required)})`,
      )
  }
  const log = worker.logging ?? {}
  if (log.driver !== LOG_DRIVER)
    errors.push(
      `${WORKER} logging driver must be ${LOG_DRIVER} (found: ${log.driver ?? 'unset'}): other drivers ship logs off-host`,
    )
  for (const key of Object.keys(log.options ?? {}).filter((k) => !LOG_OPTION_KEYS.includes(k)))
    errors.push(`${WORKER} logging option ${key} is not in the reviewed list`)
  for (const key of Object.keys(log).filter((k) => k !== 'driver' && k !== 'options'))
    errors.push(`${WORKER} logging must set only driver and options (found: ${key})`)
  // Repository only: strip a digest, then a tag (a colon after the last slash).
  const noDigest = String(worker.image ?? '').split('@')[0]
  const tagAt = noDigest.indexOf(':', noDigest.lastIndexOf('/') + 1)
  const repo = tagAt < 0 ? noDigest : noDigest.slice(0, tagAt)
  if (repo !== WORKER_IMAGE_REPO)
    errors.push(
      `${WORKER} image repository must be ${WORKER_IMAGE_REPO} (found: ${repo || 'unset'})`,
    )
  // The guard's env files are empty, so these keys can only come from the compose file itself.
  for (const key of Object.keys(worker.environment ?? {})) {
    if (/DATABASE_URL|^POSTGRES_|^PG[A-Z]+$/.test(key))
      errors.push(`${WORKER} must hold no database setting (found: ${key})`)
  }
  // Parsed, not matched: `noexec,...,exec` is exec, the last option wins.
  const tmpfsOk = (t) => {
    const [path, opts = ''] = t.split(/:(.*)/s)
    const o = opts.split(',')
    return (
      path === '/tmp' &&
      o.includes('noexec') &&
      o.includes('nosuid') &&
      !o.some((x) => ['exec', 'suid', 'dev'].includes(x))
    )
  }
  if (!(worker.tmpfs ?? []).every(tmpfsOk))
    errors.push(
      `${WORKER} tmpfs must be /tmp only, with noexec and nosuid, and no exec, suid or dev`,
    )
  if (!(worker.tmpfs ?? []).some((t) => /^\/tmp:/.test(t)))
    errors.push(`${WORKER} must keep its /tmp tmpfs (the root filesystem is read-only)`)
  if (!(worker.cap_drop ?? []).includes('ALL')) errors.push(`${WORKER} must drop all capabilities`)
  if ((worker.cap_add ?? []).length > 0) errors.push(`${WORKER} must not add capabilities`)
  if (Number(worker.mem_limit) !== WORKER_MEM_BYTES)
    errors.push(`${WORKER} mem_limit must be ${WORKER_MEM_BYTES} bytes`)
  if (Number(worker.memswap_limit) !== WORKER_MEM_BYTES)
    errors.push(`${WORKER} memswap_limit must equal mem_limit`)
  if (Number(worker.cpus) !== 0.5) errors.push(`${WORKER} cpus must be 0.5`)
  if (Number(worker.pids_limit) !== 64) errors.push(`${WORKER} pids_limit must be 64`)
  if (worker.read_only !== true) errors.push(`${WORKER} must run with read_only: true`)
  const vols = worker.volumes ?? []
  if (!vols.some((v) => v.type === 'volume' && v.target === STATE_TARGET))
    errors.push(`${WORKER} must keep its state volume at ${STATE_TARGET}`)
  // A bind mount (the docker socket, a host dir) or a second volume is a way out of the sandbox.
  for (const v of vols) {
    if (!(v.type === 'volume' && v.source === STATE_VOLUME && v.target === STATE_TARGET))
      errors.push(
        `${WORKER} must mount only its state volume (found: ${v.type} ${v.source ?? ''} -> ${v.target})`,
      )
  }
  if (netsOf(worker).join() !== [EGRESS, ENTRY].join()) {
    errors.push(
      `${WORKER} must be on ${ENTRY} and ${EGRESS} only (found: ${netsOf(worker).join(', ') || 'none'})`,
    )
  }
  // Exactly the one alias: `includes` let `postgres` or `api` ride along and shadow the real hosts
  // for every container on the entry network.
  const entryAliases = worker.networks?.[ENTRY]?.aliases ?? []
  if (entryAliases.join() !== WORKER_ALIAS)
    errors.push(
      `${WORKER} must carry exactly the alias ${WORKER_ALIAS} on ${ENTRY} (found: ${entryAliases.join(', ') || 'none'}): the API calls it by that name`,
    )
  const egressAliases = worker.networks?.[EGRESS]?.aliases ?? []
  if (egressAliases.length > 0)
    errors.push(`${WORKER} must carry no alias on ${EGRESS} (found: ${egressAliases.join(', ')})`)
  if ((worker.profiles ?? []).length > 0)
    errors.push(`${WORKER} must not hide behind a profile in its own project`)
}

// The service side names the volume; the top-level side decides what it is. A `driver_opts` of
// `type: none, o: bind, device: /` makes it a bind mount of the host root, so nothing may be set:
// compose fills in only its own scoped name.
const topVols = extraction.volumes ?? {}
for (const key of Object.keys(topVols)) {
  if (key !== STATE_VOLUME) errors.push(`unexpected volume ${key} in the extraction project`)
}
for (const [k, v] of Object.entries(topVols[STATE_VOLUME] ?? {})) {
  if (!(k === 'name' && v === `${PROJECT}_${STATE_VOLUME}`))
    errors.push(`volume ${STATE_VOLUME} must set nothing (found: ${k})`)
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
  const subnets = (rawNets[EGRESS]?.ipam?.config ?? []).map((c) => c.subnet)
  if (subnets.join() !== EGRESS_SUBNET)
    errors.push(
      `network ${EGRESS} must pin the subnet ${EGRESS_SUBNET} (found: ${subnets.join(', ') || 'none'})`,
    )
}
// The shipped entry network has no ipam: a subnet or gateway there is unreviewed addressing.
for (const k of setKeys(rawNets[ENTRY]?.ipam))
  errors.push(`network ${ENTRY} must set no ipam, as shipped (found: ${k})`)
for (const [key, net] of Object.entries(rawNets)) {
  for (const k of setKeys(net).filter((k) => !NET_KEYS.includes(k)))
    errors.push(`network ${key} must not set ${k}: not in the reviewed key allow-list`)
  // The default bridge: macvlan/ipvlan put the worker on a host-side L2 segment.
  if (net.driver !== undefined && net.driver !== 'bridge')
    errors.push(`network ${key} must use the bridge driver (found: ${net.driver})`)
  if (net.enable_ipv6)
    errors.push(`network ${key} must not enable IPv6: the pinned subnet is IPv4 only`)
  for (const k of setKeys(net.ipam).filter((k) => k !== 'config'))
    errors.push(`network ${key} ipam must set only config (found: ${k})`)
  for (const c of net.ipam?.config ?? []) {
    for (const k of setKeys(c).filter((k) => k !== 'subnet'))
      errors.push(`network ${key} ipam config must set only subnet (found: ${k})`)
  }
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
  // Allowed: the entry network (the soft attach) and the worker's alias (the API's URL).
  if (/docker-compose\.extraction|crm-extraction(?!-entry\b|-worker\b)/.test(text)) {
    errors.push(`${basename(path)} names the extraction project or its file (ADR §8.6)`)
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`ERROR: ${e}`)
  process.exit(1)
}
console.log(`extraction project isolation OK (deploy services: ${deployed.join(', ')})`)
