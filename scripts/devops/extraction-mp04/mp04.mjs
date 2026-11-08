#!/usr/bin/env node
// MP-04 (resource and latency) and MP-03 (local extraction quality) for one candidate model, on a
// disposable host with the extraction project up (ADR 2026-11-03 §8.4, task r5-5.4c-7).
//
// Pages go through `HtmlStructurer.structure` (ModelStructurer) over a router port built from the
// candidate's router config with every hosted route removed, small dose on, as in the worker.
// The harness never calls a leaf or the port itself. A loopback tap between the router and the
// runtime reads what only the runtime knows: reported prompt tokens, speed, reasoning output.
//
// Exit 0 = report written and the candidate passes; 1 = report written, it fails; 2 = harness
// error (a report is still attempted). Exit 0 without a verified report cannot happen: see finish().
//
// Usage (see docs/runbooks/extraction-worker.md, "MP-04"):
//   node mp04.mjs --candidate cand.json --api-dist <dir with dist/ and node_modules/> \
//     --runtime-url http://<runtime address>:8080 --crm-url https://<crm>/api/health --out-dir <dir>

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildFixtures } from './fixtures.mjs'
import {
  abortWatch,
  estimateShares,
  evaluate,
  percentile,
  probeStats,
  ramWatch,
  scoreMp03,
  summary,
} from './lib.mjs'
import { startTap } from './tap.mjs'

const DEFAULTS = {
  'runtime-container': 'crm-extraction-crm-model-runtime-1',
  'probe-interval-ms': '500',
  'baseline-s': '60',
  fixtures: '50',
}
const MIN_PROBE_INTERVAL_MS = 200 // the probe never exceeds 5 GETs per second
const PROBE_TIMEOUT_MS = 5_000
const COLD_LOAD_DEADLINE_MS = 600_000
const IDLE_CPU_PERCENT = 10 // of one CPU: below this the runtime is idle

let reportVerified = false
// What main() has parsed so far, so an uncaught error can still write its error report.
const parsed = { outDir: null, name: 'unknown' }
// Exit 1 means "report written, the candidate fails"; without a verified report it is always 2.
process.on('exit', () => {
  if (!reportVerified) process.exitCode = 2
})
process.on('uncaughtException', (err) => {
  process.stderr.write(`mp04: uncaught: ${err?.stack ?? err}\n`)
  if (!reportVerified && parsed.outDir) {
    try {
      finish(parsed.outDir, {
        candidate: parsed.name,
        pass: false,
        error: `uncaught: ${err?.message ?? err}`,
        rows: [],
      })
    } catch (e) {
      process.stderr.write(`mp04: no report: ${e.message}\n`)
    }
    process.exit(2)
  }
  process.exit(reportVerified ? process.exitCode : 2)
})

function args(argv) {
  const out = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined)
      throw new Error(`bad argument ${argv[i]}`)
    out[argv[i].slice(2)] = argv[i + 1]
  }
  for (const k of ['candidate', 'api-dist', 'runtime-url', 'crm-url', 'out-dir']) {
    if (!out[k]) throw new Error(`--${k} is required`)
  }
  for (const k of ['runtime-url', 'crm-url']) {
    if (!/^https?:$/.test(new URL(out[k]).protocol)) throw new Error(`--${k} must be http(s)`)
  }
  // A non-number here would run the probe unpaced or the baseline empty.
  for (const [k, min] of [
    ['probe-interval-ms', MIN_PROBE_INTERVAL_MS],
    ['baseline-s', 1],
    ['fixtures', 1],
  ]) {
    if (!/^\d+$/.test(out[k]) || Number(out[k]) < min)
      throw new Error(`--${k} must be an integer >= ${min}, got ${out[k]}`)
  }
  return out
}

function loadCandidate(path) {
  const c = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof c.name !== 'string' || !/^[\w.-]{1,64}$/.test(c.name))
    throw new Error('candidate.name: [\\w.-]{1,64}')
  if (typeof c.routerConfig !== 'object' || c.routerConfig === null)
    throw new Error('candidate.routerConfig missing')
  return c
}

const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim()
const inspect = (ct, fmt) => docker('inspect', '-f', fmt, ct)

function runtimeState(ct) {
  const [restarts, oom, started] = inspect(
    ct,
    '{{.RestartCount}} {{.State.OOMKilled}} {{.State.StartedAt}}',
  ).split(' ')
  return { restarts: Number(restarts), oomKilled: oom === 'true', started }
}

function hostAvailableBytes() {
  if (!existsSync('/proc/meminfo')) return null
  const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))
  return m ? Number(m[1]) * 1024 : null
}

const UNIT = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, KB: 1e3, MB: 1e6, GB: 1e9 }
function bytes(s) {
  const m = /([\d.]+)\s*([KMG]i?B|B)/i.exec(s)
  return m ? Number(m[1]) * UNIT[m[2].toUpperCase()] : null
}

/** `docker stats` as a stream: memory and CPU samples of the runtime, about one per second. */
function statsSampler(ct) {
  const samples = []
  const child = spawn('docker', ['stats', '--format', '{{json .}}', ct], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const failures = []
  child.on('error', (e) => failures.push(e.message))
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    const parts = buf.split('\n')
    buf = parts.pop()
    for (const line of parts) {
      const json = /\{.*\}/.exec(line)?.[0]
      if (!json) continue
      try {
        const s = JSON.parse(json)
        samples.push({
          t: Date.now(),
          mem: bytes(s.MemUsage.split('/')[0]),
          cpu: Number.parseFloat(s.CPUPerc),
        })
      } catch (e) {
        failures.push(e.message)
      }
    }
  })
  return { samples, failures, stop: () => child.kill() }
}

async function waitHealthy(runtimeUrl, deadlineMs, signal) {
  const start = Date.now()
  while (!signal.aborted && Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(new URL('/health', runtimeUrl), { signal: AbortSignal.timeout(2_000) })
      if (r.status === 200) return Date.now() - start
    } catch {
      // not up yet
    }
    await sleep(1_000)
  }
  return null
}

/** Unauthenticated GETs at a fixed rate, one at a time; `onSample` sees each one. */
function crmProbe(url, intervalMs, onSample) {
  const samples = []
  let stopped = false
  const done = (async () => {
    while (!stopped) {
      const next = Date.now() + intervalMs
      const t0 = performance.now()
      let status = 0
      try {
        const r = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        status = r.status
        await r.arrayBuffer()
      } catch {
        // no response: counted at its timeout below
      }
      const s = { ms: status === 0 ? PROBE_TIMEOUT_MS : Math.round(performance.now() - t0), status }
      samples.push(s)
      onSample?.(s)
      await sleep(Math.max(0, next - Date.now()))
    }
  })()
  return { samples, stop: async () => ((stopped = true), done) }
}

function mergeReports(outDir) {
  const candidates = readdirSync(outDir)
    .filter((f) => f.startsWith('candidate-') && f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(outDir, f), 'utf8')))
  const report = {
    generatedAt: new Date().toISOString(),
    candidates,
    nonePasses: !candidates.some((c) => c.pass),
  }
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(outDir, 'summary.txt'), `${summary(candidates)}\n`)
  return report
}

/** The only place an exit status is set: after the report is on disk and reads back. */
function finish(outDir, result) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    join(outDir, `candidate-${result.candidate}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  )
  mergeReports(outDir)
  const back = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'))
  const mine = back.candidates.find((c) => c.candidate === result.candidate)
  if (!mine) throw new Error('the report does not carry this candidate')
  reportVerified = true
  process.stdout.write(
    `${readFileSync(join(outDir, 'summary.txt'), 'utf8')}report: ${resolve(outDir, 'report.json')}\n`,
  )
  process.exitCode = mine.error ? 2 : mine.pass ? 0 : 1
}

/** Every sampler, timer, probe and server `measure` opens is closed here, even when it throws. */
async function run(a, cand) {
  const closers = []
  try {
    return await measure(a, cand, closers)
  } finally {
    for (const close of closers.reverse()) {
      try {
        await close()
      } catch {
        // already closed by the normal path
      }
    }
  }
}

async function measure(a, cand, closers) {
  const req = createRequire(join(resolve(a['api-dist']), 'dist', 'main.js'))
  const dist = (p) => req(join(resolve(a['api-dist']), 'dist', p))
  const inf = req('@crm/inference')
  const { ModelStructurer } = dist('job-sourcing/structuring/model-structurer.js')
  // The per-cycle call cap is lifted: the harness measures, it does not schedule.
  const { InMemoryModelBudget } = dist('job-sourcing/structuring/model-budget.port.js')
  const { smallDoseFor } = dist('job-sourcing/structuring/small-dose-table.js')
  const { EXTRACTION_SYSTEM_PROMPT } = dist('job-sourcing/structuring/prompt-envelope.js')
  const { localOnlyRouterConfig } = dist('extraction-worker/schema.js')
  const { EXTRACTION_TABLE_VERSION } = dist('extraction-worker/link-contract.js')

  const ct = a['runtime-container']
  const m = {
    candidate: cand.name,
    repo: cand.repo,
    file: cand.file,
    sha256: cand.sha256,
    repoCommit: cand.repoCommit,
    licence: cand.licence ?? null,
  }
  m.limits = JSON.parse(
    inspect(
      ct,
      '{"memory":{{.HostConfig.Memory}},"memorySwap":{{.HostConfig.MemorySwap}},"nanoCpus":{{.HostConfig.NanoCpus}},"pidsLimit":{{.HostConfig.PidsLimit}}}',
    ),
  )
  m.runtimeImage = inspect(ct, '{{.Config.Image}}')

  // The abort rule: stop the runtime and end the run at once (the runbook restarts it by hand).
  const stop = new AbortController()
  const stopRuntime = () => {
    try {
      docker('stop', '--time', '5', ct)
      m.runtimeStoppedByAbort = true
    } catch (e) {
      m.runtimeStoppedByAbort = `docker stop failed: ${e.message}`
    }
  }
  const endRun = () => stop.abort()
  const hostMem = []
  const hostAvailable = () => hostMem.at(-1) ?? null
  // Host RAM is watched from before the restart, so the cold load and the baseline are covered.
  let watch = ramWatch({ hostAvailable, stopRuntime, endRun })
  const memTimer = setInterval(() => {
    hostMem.push(hostAvailableBytes())
    watch.check()
  }, 2_000)
  closers.push(() => clearInterval(memTimer))
  const abortedEarly = () => ({ ...m, aborted: watch.reason, pass: false, rows: [] })

  // Cold load: a restart reloads the weights from the volume (the page cache may still hold them).
  docker('restart', ct)
  m.coldLoadMs = await waitHealthy(a['runtime-url'], COLD_LOAD_DEADLINE_MS, stop.signal)
  if (stop.signal.aborted) return abortedEarly()
  if (m.coldLoadMs === null) throw new Error('the runtime did not become healthy after a restart')
  const before = runtimeState(ct)

  const stats = statsSampler(ct)
  closers.push(() => stats.stop())
  const interval = Math.max(MIN_PROBE_INTERVAL_MS, Number(a['probe-interval-ms']))

  const baseline = crmProbe(a['crm-url'], interval)
  closers.push(() => baseline.stop())
  await sleep(Number(a['baseline-s']) * 1000, null, { signal: stop.signal }).catch(() => {})
  await baseline.stop()
  if (stop.signal.aborted) return abortedEarly()
  const base = probeStats(baseline.samples)

  const current = { tag: {}, inFlight: 0 }
  const tap = await startTap(a['runtime-url'], current)
  closers.push(() => {
    tap.server.closeAllConnections()
    tap.server.close()
  })
  const raw = structuredClone(cand.routerConfig)
  const local = raw.routes?.find((r) => r.provider === 'local')
  if (!local) throw new Error('routerConfig has no local route')
  local.baseUrl = `http://127.0.0.1:${tap.port}/v1`
  const config = localOnlyRouterConfig(raw)
  m.requestTimeoutMs = local.timeoutMs
  const events = []
  const routeStatePath = join(a['out-dir'], `.route-state-${cand.name}.json`)
  rmSync(routeStatePath, { force: true })
  const routeState = await inf.createFileRouteStatePort({
    path: routeStatePath,
    now: Date.now,
    onEvent: () => {},
  })
  const port = inf.createRouterExtractionAdapter(config, {
    onEvent: (e) => events.push(e),
    routeState,
  })
  const ceilingMs = inf.routerCallCeilingMs(config) + 10_000
  const structurer = new ModelStructurer({
    port,
    budget: new InMemoryModelBudget(Number.MAX_SAFE_INTEGER),
    timeoutMs: ceilingMs,
    abandonedHoldMs: ceilingMs + 10_000,
    inputCeilingChars: inf.routerInputCeilingChars(
      { contextTokens: local.contextTokens, maxAnswerTokens: local.maxAnswerTokens },
      EXTRACTION_SYSTEM_PROMPT,
      smallDoseFor().groups,
    ),
  })
  if (events.some((e) => e.type === 'CONFIG_REFUSED'))
    throw new Error('the router refused the candidate config')

  // the RAM-only watch may have fired during the tap and router setup: keep its reason
  if (stop.signal.aborted) return abortedEarly()
  const loaded = crmProbe(a['crm-url'], interval, () => watch.check())
  // Under load the full rule replaces the RAM-only one (no reason yet, or we returned above).
  watch = abortWatch({
    baselineP95: base.p95,
    samples: loaded.samples,
    hostAvailable,
    stopRuntime,
    endRun,
  })
  closers.push(() => loaded.stop())

  const structure = (fx, signal) =>
    structurer.structure({
      aiInput: 'yes',
      policy: { onUnspecified: 'allow' },
      records: [
        { id: fx.id, url: fx.url, text: fx.text, ...(fx.missing && { missing: fx.missing }) },
      ],
      extractionVersion: EXTRACTION_TABLE_VERSION,
      signal,
    })

  const results = []
  const walls = []
  for (const fx of buildFixtures().slice(0, Number(a.fixtures))) {
    if (stop.signal.aborted) break
    current.tag = { id: fx.id, lang: fx.lang }
    const t0 = Date.now()
    const out = await structure(fx, stop.signal)
    walls.push(Date.now() - t0)
    const record = out.records?.find((r) => r.sourceId === fx.id) ?? null
    const issue = out.perRecordIssues?.find((i) => i.id === fx.id)
    results.push({
      fixture: fx,
      record,
      schemaValid: record !== null && (issue?.failure ?? null) === null,
      outcome: out.kind,
    })
  }

  // Disconnect: abort a long call while the runtime works on it, then time until the CPU is idle.
  if (!stop.signal.aborted) {
    const fx = buildFixtures()[0]
    const long = { ...fx, id: 'mp04-disconnect', text: Array(40).fill(fx.text).join('\n\n') }
    current.tag = { id: long.id, lang: fx.lang, disconnect: true }
    const ac = new AbortController()
    const call = structure(long, ac.signal)
    const t0 = Date.now()
    while (current.inFlight === 0 && Date.now() - t0 < 30_000) await sleep(100)
    await sleep(2_000)
    const busy = current.inFlight > 0
    const abortedAt = Date.now()
    ac.abort()
    await call
    let idleAt = null
    while (busy && idleAt === null && Date.now() - abortedAt < 60_000) {
      await sleep(500)
      idleAt = stats.samples.find((s) => s.t > abortedAt && s.cpu < IDLE_CPU_PERCENT)?.t ?? null
    }
    m.cpuIdleAfterAbortMs = busy && idleAt !== null ? idleAt - abortedAt : null
    m.disconnectNote = busy
      ? 'aborted while a runtime request was in flight'
      : 'no runtime request was in flight: not measured'
  }

  await loaded.stop()
  clearInterval(memTimer)
  stats.stop()
  tap.server.close()
  const after = runtimeState(ct)
  m.aborted = watch.reason ?? undefined
  if (stats.failures.length) m.statsFailures = stats.failures.slice(0, 5)

  const chat = tap.requests.filter((r) => r.estimate !== undefined && !r.disconnect)
  const answered = chat.filter((r) => !r.aborted && r.status === 200)
  const median = (k) => percentile(answered.map((r) => r[k]).filter(Number.isFinite), 50)
  m.restarts = after.restarts - before.restarts + (after.started === before.started ? 0 : 1)
  m.oomKills = after.oomKilled ? 1 : 0
  m.peakRuntimeMemBytes = stats.samples.reduce((x, s) => Math.max(x, s.mem ?? 0), 0) || null
  m.peakRuntimeCpuPercent = stats.samples.reduce((x, s) => Math.max(x, s.cpu || 0), 0) || null
  m.minHostAvailableBytes = hostMem
    .filter((x) => x !== null)
    .reduce((x, y) => Math.min(x, y), Infinity)
  if (!Number.isFinite(m.minHostAvailableBytes)) m.minHostAvailableBytes = null
  m.recordWallP50Ms = percentile(walls, 50)
  m.recordWallP95Ms = percentile(walls, 95)
  m.requests = {
    total: chat.length,
    answered: answered.length,
    non200: chat.filter((r) => r.status !== 200 && !r.aborted).length,
  }
  m.tokensPerSecond = {
    predictedMedian: median('predictedPerSecond'),
    promptMedian: median('promptPerSecond'),
  }
  m.reasoning = {
    requestsWithReasoning: answered.filter((r) => r.reasoningChars > 0).length,
    reasoningChars: answered.reduce((n, r) => n + (r.reasoningChars ?? 0), 0),
    completionTokensMedian: median('completionTokens'),
  }
  m.emptyAnswerRate =
    answered.length === 0 ? null : answered.filter((r) => r.empty).length / answered.length
  m.estimate = estimateShares(answered)
  m.crm = { baseline: base, loaded: probeStats(loaded.samples) }
  const mp03 = scoreMp03(results)
  m.mp03 = mp03
  m.outcomes = results.map((r) => ({
    id: r.fixture.id,
    outcome: r.outcome,
    schemaValid: r.schemaValid,
  }))
  m.routerCalls = events.filter((e) => e.type === 'CALL').map((e) => e.code)
  const verdict = evaluate(m)
  return { ...m, ...verdict }
}

async function main() {
  let a
  let name = 'unknown'
  try {
    a = args(process.argv.slice(2))
    parsed.outDir = a['out-dir'] ?? null
    const cand = loadCandidate(a.candidate)
    name = cand.name
    parsed.name = name
    finish(a['out-dir'], await run(a, cand))
  } catch (err) {
    process.stderr.write(`mp04: ${err.message}\n`)
    if (!a?.['out-dir']) {
      process.exitCode = 2
      return
    }
    try {
      finish(a['out-dir'], { candidate: name, pass: false, error: err.message, rows: [] })
    } catch (e) {
      process.stderr.write(`mp04: no report: ${e.message}\n`)
    }
    process.exitCode = 2
  }
}

await main()
