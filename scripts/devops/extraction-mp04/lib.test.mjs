// node --test scripts/devops/extraction-mp04/
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildFixtures } from './fixtures.mjs'
import {
  abortReason,
  estimateShares,
  evaluate,
  fieldCorrect,
  percentile,
  probeStats,
  scoreMp03,
  summary,
  THRESHOLDS,
} from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))

test('percentile: nearest rank, null on no samples', () => {
  assert.equal(percentile([], 95), null)
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3)
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      95,
    ),
    95,
  )
})

test('abortReason: 5xx, low host RAM, rolling p95 over 2 x baseline', () => {
  const ok = Array.from({ length: 20 }, () => ({ ms: 100, status: 200 }))
  assert.equal(abortReason({ baselineP95: 100, recent: ok, hostAvailableBytes: 2e9 }), null)
  assert.match(
    abortReason({
      baselineP95: 100,
      recent: [...ok, { ms: 90, status: 503 }],
      hostAvailableBytes: null,
    }),
    /503/,
  )
  assert.match(
    abortReason({ baselineP95: 100, recent: ok, hostAvailableBytes: 700 * 1048576 }),
    /800 MiB/,
  )
  const slow = Array.from({ length: 20 }, () => ({ ms: 201, status: 200 }))
  assert.match(
    abortReason({ baselineP95: 100, recent: slow, hostAvailableBytes: null }),
    /rolling p95/,
  )
  // fewer samples than the window: no rolling verdict yet
  assert.equal(
    abortReason({ baselineP95: 100, recent: slow.slice(0, 5), hostAvailableBytes: null }),
    null,
  )
})

function passing() {
  const probe = probeStats(Array.from({ length: 100 }, () => ({ ms: 100, status: 200 })))
  return {
    limits: {
      memory: THRESHOLDS.runtimeMemoryBytes,
      memorySwap: THRESHOLDS.runtimeMemoryBytes,
      nanoCpus: 2e9,
      pidsLimit: 128,
    },
    oomKills: 0,
    restarts: 0,
    crm: { baseline: probe, loaded: probe },
    recordWallP95Ms: 100_000,
    requestTimeoutMs: 120_000,
    coldLoadMs: 30_000,
    cpuIdleAfterAbortMs: 2_000,
    estimate: { uk: { share: 1 }, en: { share: 0.96 } },
    emptyAnswerRate: 0,
    mp03: { schemaValidRate: 0.95, inventedUrls: [], fieldAccuracy: 0.85 },
    licence: { verdict: 'acceptable', url: 'https://huggingface.co/x/y/blob/abcdef1/LICENSE' },
    repoCommit: 'abcdef1',
  }
}

test('evaluate: a full pass, and each frozen limit fails just past it', () => {
  assert.equal(evaluate(passing()).pass, true)
  const breaks = [
    (m) => (m.limits.memorySwap = m.limits.memory + 1),
    (m) => (m.oomKills = 1),
    (m) => (m.restarts = 1),
    (m) => (m.crm.loaded = { ...m.crm.loaded, p95: 151 }),
    (m) => (m.crm.loaded = { ...m.crm.loaded, p99: 151 }),
    (m) => (m.crm.loaded = { ...m.crm.loaded, status5xx: 1 }),
    (m) => (m.recordWallP95Ms = 240_001),
    (m) => (m.requestTimeoutMs = 300_000),
    (m) => (m.coldLoadMs = 180_001),
    (m) => (m.cpuIdleAfterAbortMs = 10_001),
    (m) => (m.estimate.uk.share = 0.94),
    (m) => (m.emptyAnswerRate = 0.06),
    (m) => (m.mp03.schemaValidRate = 0.89),
    (m) => (m.mp03.inventedUrls = [{ id: 'x', url: 'https://a.example/' }]),
    (m) => (m.mp03.fieldAccuracy = 0.79),
    (m) => (m.licence.url = 'https://huggingface.co/x/y/blob/main/LICENSE'),
    (m) => (m.licence.verdict = 'unread'),
    (m) => (m.aborted = 'probe answered 502'),
  ]
  for (const [i, brk] of breaks.entries()) {
    const m = passing()
    brk(m)
    assert.equal(evaluate(m).pass, false, `break #${i} should fail`)
  }
})

test('evaluate: an unmeasured value fails its row', () => {
  for (const k of ['coldLoadMs', 'cpuIdleAfterAbortMs', 'recordWallP95Ms', 'emptyAnswerRate']) {
    const m = passing()
    m[k] = null
    const r = evaluate(m)
    assert.equal(r.pass, false, k)
    assert.ok(
      r.rows.some((x) => !x.pass && x.value === 'not measured'),
      k,
    )
  }
})

test('summary: none passes, and passes by name', () => {
  assert.match(
    summary([
      { candidate: 'a', pass: false, rows: [{ name: 'x', pass: false, value: 1, limit: '0' }] },
    ]),
    /none passes/,
  )
  assert.match(summary([{ candidate: 'a', pass: true, rows: [] }]), /passes: a/)
})

test('fieldCorrect and scoreMp03', () => {
  assert.equal(fieldCorrect('location', 'Kyiv, Ukraine', 'kyiv, ukraine.'), true)
  assert.equal(fieldCorrect('location', 'Kyiv', `Kyiv ${'x'.repeat(40)}`), false)
  assert.equal(fieldCorrect('salary', null, null), true)
  assert.equal(fieldCorrect('remote', false, null), false)
  assert.equal(
    fieldCorrect('applyUrl', 'https://a.example/apply/1', 'https://a.example/apply/1/'),
    true,
  )
  const fx = buildFixtures()[0]
  const perfect = {
    ...Object.fromEntries(Object.entries(fx.expected).filter(([k]) => k !== 'descriptionIncludes')),
    description: fx.expected.descriptionIncludes.join('. '),
  }
  const s = scoreMp03([
    { fixture: fx, record: perfect, schemaValid: true },
    { fixture: fx, record: { ...perfect, applyUrl: 'https://evil.example/x' }, schemaValid: true },
    { fixture: fx, record: null, schemaValid: false },
  ])
  assert.equal(s.schemaValidRate, 2 / 3)
  assert.deepEqual(s.inventedUrls, [{ id: fx.id, url: 'https://evil.example/x' }])
  assert.ok(s.fieldAccuracy < 2 / 3)
})

test('estimateShares: per language, only answered requests with reported tokens', () => {
  const r = estimateShares([
    { lang: 'uk', estimate: 100, promptTokens: 90 },
    { lang: 'uk', estimate: 100, promptTokens: 110 },
    { lang: 'en', estimate: 50, promptTokens: 40 },
    { lang: 'en', estimate: 50 },
  ])
  assert.deepEqual(r.uk, { requests: 2, share: 0.5, worstShortfall: 10 })
  assert.deepEqual(r.en, { requests: 1, share: 1, worstShortfall: 0 })
})

test('fixtures: 50, 25 per language, the layouts, ground truth on the page', () => {
  const all = buildFixtures()
  assert.equal(all.length, 50)
  assert.equal(new Set(all.map((f) => f.id)).size, 50)
  for (const lang of ['uk', 'en']) {
    const mine = all.filter((f) => f.lang === lang)
    assert.equal(mine.length, 25)
    assert.ok(mine.filter((f) => f.layout === 'sidebar').length >= 5)
    assert.ok(mine.filter((f) => f.layout === 'prefilled').length >= 5)
  }
  for (const f of all) {
    assert.ok(f.url.includes('.example/'), f.id)
    for (const [k, v] of Object.entries(f.expected)) {
      if (k === 'remote' || v === null || k === 'postingUrl') continue
      for (const s of k === 'descriptionIncludes' ? v : [v])
        assert.ok(f.text.includes(s), `${f.id}: ${k} not on the page`)
    }
    if (f.layout === 'prefilled')
      assert.deepEqual(
        Object.keys(f.expected).sort(),
        f.missing.map((m) => (m === 'description' ? 'descriptionIncludes' : m)).sort(),
      )
    if (f.layout === 'sidebar') {
      const tail = f.text.slice(f.text.lastIndexOf('\n\n'))
      for (const k of ['company', 'location', 'salary'])
        assert.ok(!tail.includes(f.expected[k]), `${f.id}: neighbour shares ${k}`)
    }
  }
})

test('mp04.mjs: no exit 0 without a report', () => {
  const cli = join(here, 'mp04.mjs')
  const bare = spawnSync(process.execPath, [cli], { encoding: 'utf8' })
  assert.equal(bare.status, 2)

  const out = mkdtempSync(join(tmpdir(), 'mp04-'))
  const cand = join(out, 'cand.json')
  writeFileSync(cand, JSON.stringify({ name: 'broken', routerConfig: {} }))
  const r = spawnSync(
    process.execPath,
    [
      cli,
      '--candidate',
      cand,
      '--api-dist',
      join(out, 'nope'),
      '--runtime-url',
      'http://127.0.0.1:9',
      '--crm-url',
      'http://127.0.0.1:9/',
      '--out-dir',
      out,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(r.status, 2)
  assert.ok(existsSync(join(out, 'report.json')), 'a failed run still writes a report')
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'))
  assert.equal(report.nonePasses, true)
  assert.ok(report.candidates[0].error)
})
