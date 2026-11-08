// Pure parts of the MP-04 / MP-03 harness: statistics, the frozen pass table, the abort rule,
// MP-03 scoring and the report. No I/O here, so lib.test.mjs checks all of it without a runtime.

/**
 * The frozen thresholds (task r5-5.4c-7, ADR 2026-11-03 §8.3/§8.4). Master's, not ours: a run that
 * misses one fails; the harness never relaxes a value.
 */
export const THRESHOLDS = Object.freeze({
  runtimeMemoryBytes: 3584 * 1024 * 1024,
  runtimeNanoCpus: 2_000_000_000,
  runtimePidsLimit: 128,
  recordWallP95Ms: 240_000,
  requestTimeoutBelowMs: 300_000,
  coldLoadMs: 180_000,
  cpuIdleAfterAbortMs: 10_000,
  tokenEstimateShare: 0.95,
  emptyAnswerRate: 0.05,
  schemaValidRate: 0.9,
  inventedUrls: 0,
  fieldAccuracy: 0.8,
})

/** The abort rule: any one of these stops the run, and a stopped run fails. */
export const ABORT = Object.freeze({
  rollingP95Factor: 2,
  rollingWindow: 20,
  hostAvailableMinBytes: 800 * 1024 * 1024,
})

/** Nearest-rank percentile; null on no samples, so "not measured" never reads as zero. */
export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/**
 * One probe sample, `{ ms, status }` (status 0 = no response). A failed probe counts at its timeout,
 * so a stalled CRM raises the percentiles instead of vanishing from them.
 */
export function probeStats(samples) {
  const ms = samples.map((s) => s.ms)
  return {
    count: samples.length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    status5xx: samples.filter((s) => s.status >= 500).length,
    noResponse: samples.filter((s) => s.status === 0).length,
  }
}

/** A probe that got no answer (timeout, refused, lost connection) is a failure, like a 5xx. */
const failedProbe = (s) => s.status === 0 || s.status >= 500

/** Returns the reason to stop, or null. `recent` are the probe samples so far under load. */
export function abortReason({ baselineP95, recent, hostAvailableBytes }) {
  const bad = recent.find(failedProbe)
  if (bad) return bad.status === 0 ? 'probe got no answer' : `probe answered ${bad.status}`
  if (hostAvailableBytes !== null && hostAvailableBytes < ABORT.hostAvailableMinBytes) {
    return `host available RAM ${Math.round(hostAvailableBytes / 1048576)} MiB < 800 MiB`
  }
  const window = recent.slice(-ABORT.rollingWindow)
  if (baselineP95 !== null && window.length >= ABORT.rollingWindow) {
    const p95 = percentile(
      window.map((s) => s.ms),
      95,
    )
    if (p95 > ABORT.rollingP95Factor * baselineP95) {
      return `rolling p95 ${p95} ms > 2 x baseline ${baselineP95} ms`
    }
  }
  return null
}

/**
 * The abort rule in action: `check()` runs on every probe sample and every host-memory tick. The
 * first reason stops the runtime container and ends the run, once; later checks return it again.
 */
export function abortWatch({ baselineP95, samples, hostAvailable, stopRuntime, endRun }) {
  let reason = null
  return {
    get reason() {
      return reason
    },
    check() {
      if (reason) return reason
      reason = abortReason({ baselineP95, recent: samples, hostAvailableBytes: hostAvailable() })
      if (reason) {
        stopRuntime()
        endRun()
      }
      return reason
    },
  }
}

/** The RAM part of the rule alone, for the cold load and the baseline: no probe runs under load yet. */
export const ramWatch = ({ hostAvailable, stopRuntime, endRun }) =>
  abortWatch({ baselineP95: null, samples: [], hostAvailable, stopRuntime, endRun })

const fold = (s) =>
  String(s)
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:!]+$/, '')
    .trim()

/**
 * Whether one extracted field matches the ground truth. Strings may carry extra words around the
 * expected value, but not a paragraph: a description pasted into `location` is wrong.
 */
export function fieldCorrect(field, expected, actual) {
  if (field === 'remote') return actual === expected
  if (field === 'descriptionIncludes') {
    return (
      typeof actual === 'string' && expected.every((phrase) => fold(actual).includes(fold(phrase)))
    )
  }
  if (expected === null) return actual === null || actual === undefined
  if (typeof actual !== 'string') return false
  if (field === 'postingUrl' || field === 'applyUrl') {
    return actual.replace(/\/+$/, '') === expected.replace(/\/+$/, '')
  }
  const a = fold(actual)
  const e = fold(expected)
  return a === e || (a.includes(e) && a.length <= 2 * e.length + 20)
}

/** The URLs of a record that are neither the record's own URL nor written on its page. */
export function inventedUrls(fixture, record) {
  return [record?.postingUrl, record?.applyUrl].filter(
    (u) => typeof u === 'string' && u !== fixture.url && !fixture.text.includes(u),
  )
}

/**
 * MP-03 over the per-record results, per language: the frozen rows hold for uk and for en
 * separately. `results[i]`: `{ fixture, record | null, schemaValid }`; a record that did not come
 * back scores every expected field as wrong. A language with no records scores null (fails).
 */
export function scoreMp03(results) {
  return {
    records: results.length,
    uk: scoreSet(results.filter((r) => r.fixture.lang === 'uk')),
    en: scoreSet(results.filter((r) => r.fixture.lang === 'en')),
  }
}

function scoreSet(results) {
  let scored = 0
  let correct = 0
  const invented = []
  const byField = {}
  for (const { fixture, record } of results) {
    for (const [field, expected] of Object.entries(fixture.expected)) {
      const actual = field === 'descriptionIncludes' ? record?.description : record?.[field]
      const ok = record != null && fieldCorrect(field, expected, actual)
      scored += 1
      correct += ok ? 1 : 0
      byField[field] ??= { scored: 0, correct: 0 }
      byField[field].scored += 1
      byField[field].correct += ok ? 1 : 0
    }
    for (const url of inventedUrls(fixture, record)) invented.push({ id: fixture.id, url })
  }
  const n = results.length
  return {
    records: n,
    schemaValidRate: n === 0 ? null : results.filter((r) => r.schemaValid).length / n,
    fieldAccuracy: scored === 0 ? null : correct / scored,
    byField,
    inventedUrls: invented,
  }
}

/** Share of requests whose estimate is at least the runtime's reported prompt tokens, per language. */
export function estimateShares(requests) {
  const out = {}
  for (const lang of ['uk', 'en']) {
    const rows = requests.filter((r) => r.lang === lang && Number.isInteger(r.promptTokens))
    out[lang] = {
      requests: rows.length,
      share:
        rows.length === 0
          ? null
          : rows.filter((r) => r.estimate >= r.promptTokens).length / rows.length,
      worstShortfall: rows.reduce((m, r) => Math.max(m, r.promptTokens - r.estimate), 0),
    }
  }
  return out
}

function row(name, value, limit, pass) {
  return {
    name,
    value: value ?? 'not measured',
    limit,
    pass: value !== null && value !== undefined && pass,
  }
}

/** The pass table for one candidate. Every row must pass; an unmeasured row fails. */
export function evaluate(m) {
  const T = THRESHOLDS
  const b = m.crm.baseline
  const l = m.crm.loaded
  const rows = [
    row(
      'runtime limits as frozen (mem = memswap, cpus, pids)',
      m.limits && JSON.stringify(m.limits),
      '3584 MiB, 3584 MiB, 2.0, 128',
      m.limits?.memory === T.runtimeMemoryBytes &&
        m.limits?.memorySwap === T.runtimeMemoryBytes &&
        m.limits?.nanoCpus === T.runtimeNanoCpus &&
        m.limits?.pidsLimit === T.runtimePidsLimit,
    ),
    row('OOM kills', m.oomKills, '0', m.oomKills === 0),
    row('runtime restarts during the run', m.restarts, '0', m.restarts === 0),
    row(
      'CRM p95 (ms)',
      l.p95,
      `<= max(1.25 x ${b.p95}, ${b.p95} + 50)`,
      b.p95 !== null && l.p95 <= Math.max(1.25 * b.p95, b.p95 + 50),
    ),
    row('CRM p99 (ms)', l.p99, `<= 1.5 x ${b.p99}`, b.p99 !== null && l.p99 <= 1.5 * b.p99),
    row(
      'CRM 5xx or no answer',
      l.count > 0 ? b.status5xx + b.noResponse + l.status5xx + l.noResponse : null,
      '0',
      b.status5xx + b.noResponse + l.status5xx + l.noResponse === 0,
    ),
    row(
      'peak runtime memory (bytes)',
      m.peakRuntimeMemBytes,
      `< ${T.runtimeMemoryBytes} (3584 MiB; at the cap is reclaim pressure)`,
      m.peakRuntimeMemBytes < T.runtimeMemoryBytes,
    ),
    row(
      'wall time per record p95 (ms)',
      m.recordWallP95Ms,
      `<= ${T.recordWallP95Ms}`,
      m.recordWallP95Ms <= T.recordWallP95Ms,
    ),
    row(
      'per-request timeout (ms)',
      m.requestTimeoutMs,
      `< ${T.requestTimeoutBelowMs}`,
      m.requestTimeoutMs < T.requestTimeoutBelowMs,
    ),
    row('cold load (ms)', m.coldLoadMs, `<= ${T.coldLoadMs}`, m.coldLoadMs <= T.coldLoadMs),
    row(
      'CPU idle after a client abort (ms)',
      m.cpuIdleAfterAbortMs,
      `<= ${T.cpuIdleAfterAbortMs}`,
      m.cpuIdleAfterAbortMs <= T.cpuIdleAfterAbortMs,
    ),
    ...['uk', 'en'].map((lang) =>
      row(
        `token estimate >= reported prompt tokens (${lang})`,
        m.estimate[lang].share,
        `>= ${T.tokenEstimateShare}`,
        m.estimate[lang].share >= T.tokenEstimateShare,
      ),
    ),
    row(
      'empty answers',
      m.emptyAnswerRate,
      `<= ${T.emptyAnswerRate}`,
      m.emptyAnswerRate <= T.emptyAnswerRate,
    ),
    ...['uk', 'en'].flatMap((lang) => {
      const s = m.mp03[lang]
      return [
        row(
          `MP-03 schema-valid (${lang})`,
          s.schemaValidRate,
          `>= ${T.schemaValidRate}`,
          s.schemaValidRate >= T.schemaValidRate,
        ),
        row(
          `MP-03 invented URLs (${lang})`,
          s.records > 0 ? s.inventedUrls.length : null,
          `${T.inventedUrls}`,
          s.inventedUrls.length === T.inventedUrls,
        ),
        row(
          `MP-03 field accuracy (${lang})`,
          s.fieldAccuracy,
          `>= ${T.fieldAccuracy}`,
          s.fieldAccuracy >= T.fieldAccuracy,
        ),
      ]
    }),
    row(
      'licence read at the pinned digest',
      m.licence ? `${m.licence.verdict} (${m.licence.url})` : null,
      'read, acceptable, URL at the pinned commit',
      m.licence?.verdict === 'acceptable' &&
        typeof m.licence.url === 'string' &&
        typeof m.repoCommit === 'string' &&
        m.repoCommit.length >= 7 &&
        m.licence.url.includes(m.repoCommit),
    ),
  ]
  if (m.aborted) rows.push(row('abort rule', m.aborted, 'not triggered', false))
  return { pass: rows.every((r) => r.pass), rows }
}

/** One screen: one line per candidate, then the failing rows of each. */
export function summary(candidates) {
  const lines = ['MP-04 / MP-03 candidates']
  for (const c of candidates) {
    lines.push(
      `${c.pass ? 'PASS' : 'FAIL'}  ${c.candidate}${c.error ? `  (harness error: ${c.error})` : ''}`,
    )
    for (const r of c.rows ?? []) {
      if (!r.pass)
        lines.push(
          `        x ${r.name}: ${typeof r.value === 'number' ? +r.value.toFixed(3) : r.value} (limit ${r.limit})`,
        )
    }
  }
  const passing = candidates.filter((c) => c.pass).map((c) => c.candidate)
  lines.push(passing.length === 0 ? 'none passes' : `passes: ${passing.join(', ')}`)
  return lines.join('\n')
}
