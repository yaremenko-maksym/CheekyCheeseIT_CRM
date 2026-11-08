// node --test scripts/devops/extraction-mp04/lib.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildFixtures } from './fixtures.mjs'
import {
  abortReason,
  abortWatch,
  estimateShares,
  evaluate,
  fieldCorrect,
  percentile,
  probeStats,
  ramWatch,
  scoreMp03,
  summary,
  THRESHOLDS,
} from './lib.mjs'
import { startTap } from './tap.mjs'

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
  // a probe with no answer (timeout, refused, lost connection) stops the run like a 5xx
  assert.match(
    abortReason({
      baselineP95: 100,
      recent: [...ok, { ms: 5000, status: 0 }],
      hostAvailableBytes: null,
    }),
    /no answer/,
  )
})

test('abortWatch: the first reason stops the runtime and ends the run, once', () => {
  for (const [label, samples, host] of [
    ['5xx', [{ ms: 90, status: 502 }], 2e9],
    ['no answer', [{ ms: 5000, status: 0 }], 2e9],
    ['low host RAM', [{ ms: 90, status: 200 }], 700 * 1048576],
  ]) {
    const calls = { stop: 0, end: 0 }
    const w = abortWatch({
      baselineP95: 100,
      samples,
      hostAvailable: () => host,
      stopRuntime: () => (calls.stop += 1),
      endRun: () => (calls.end += 1),
    })
    assert.ok(w.check(), label)
    w.check()
    assert.deepEqual(calls, { stop: 1, end: 1 }, label)
    assert.ok(w.reason, label)
  }
  const calls = { stop: 0, end: 0 }
  const quiet = abortWatch({
    baselineP95: 100,
    samples: [{ ms: 90, status: 200 }],
    hostAvailable: () => 2e9,
    stopRuntime: () => (calls.stop += 1),
    endRun: () => (calls.end += 1),
  })
  assert.equal(quiet.check(), null)
  assert.deepEqual(calls, { stop: 0, end: 0 })
})

test('ramWatch: low host RAM alone stops and ends once; enough RAM or none measured does not', () => {
  for (const [host, fires] of [
    [700 * 1048576, true],
    [900 * 1048576, false],
    [null, false],
  ]) {
    const calls = { stop: 0, end: 0 }
    const w = ramWatch({
      hostAvailable: () => host,
      stopRuntime: () => (calls.stop += 1),
      endRun: () => (calls.end += 1),
    })
    w.check()
    w.check()
    const n = fires ? 1 : 0
    assert.deepEqual(calls, { stop: n, end: n }, String(host))
    assert.equal(Boolean(w.reason), fires, String(host))
  }
})

test('tap: a target off the runtime origin gets 400 and is never forwarded', async () => {
  let hits = 0
  const upstream = http.createServer((req, res) => {
    hits += 1
    res.end('{}')
  })
  await new Promise((ok) => upstream.listen(0, '127.0.0.1', ok))
  const current = { tag: {}, inFlight: 0 }
  const tap = await startTap(`http://127.0.0.1:${upstream.address().port}`, current)
  // http.request sends `path` verbatim, which fetch cannot do
  const send = (path) =>
    new Promise((ok, no) => {
      const r = http.request({ host: '127.0.0.1', port: tap.port, method: 'POST', path }, (res) => {
        res.resume()
        res.on('end', () => ok(res.statusCode))
      })
      r.on('error', no)
      r.end('{}')
    })
  try {
    for (const path of [
      '//evil.example/x',
      'http://evil.example/x',
      '/\\evil.example/x',
      `http://127.0.0.1:${upstream.address().port}@evil.example/x`,
    ]) {
      assert.equal(await send(path), 400, path)
    }
    assert.equal(hits, 0)
    assert.equal(tap.requests.length, 0)
    assert.equal(await send('/v1/models'), 200, 'a plain path still goes through')
    assert.equal(hits, 1)
  } finally {
    tap.server.closeAllConnections()
    tap.server.close()
    upstream.closeAllConnections()
    upstream.close()
  }
})

test('tap: a runtime that fails, before or mid-answer, gets the client a 502 and in-flight 0', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' })
      res.write('{"choices":')
      setTimeout(() => res.socket.destroy(), 20)
    })
  })
  await new Promise((ok) => upstream.listen(0, '127.0.0.1', ok))
  const dropped = `http://127.0.0.1:${upstream.address().port}`
  try {
    for (const [label, target] of [
      ['dropped mid-stream', dropped],
      ['refused', 'http://127.0.0.1:9'],
    ]) {
      const current = { tag: {}, inFlight: 0 }
      const tap = await startTap(target, current)
      try {
        const r = await fetch(`http://127.0.0.1:${tap.port}/v1/chat/completions`, {
          method: 'POST',
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
          signal: AbortSignal.timeout(5_000),
        })
        assert.equal(r.status, 502, label)
        await r.arrayBuffer()
        await new Promise((ok) => setTimeout(ok, 50)) // let a late `close` try a second decrement
        assert.equal(current.inFlight, 0, label)
        assert.equal(tap.requests[0].status, 0, label)
        assert.equal(tap.requests[0].aborted, false, label)
      } finally {
        tap.server.closeAllConnections()
        tap.server.close()
      }
    }
  } finally {
    upstream.closeAllConnections()
    upstream.close()
  }
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
    peakRuntimeMemBytes: 2e9,
    crm: { baseline: probe, loaded: probe },
    recordWallP95Ms: 100_000,
    requestTimeoutMs: 120_000,
    coldLoadMs: 30_000,
    cpuIdleAfterAbortMs: 2_000,
    estimate: { uk: { share: 1 }, en: { share: 0.96 } },
    emptyAnswerRate: 0,
    mp03: {
      records: 50,
      uk: { records: 25, schemaValidRate: 0.95, inventedUrls: [], fieldAccuracy: 0.85 },
      en: { records: 25, schemaValidRate: 0.95, inventedUrls: [], fieldAccuracy: 0.85 },
    },
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
    (m) => (m.crm.loaded = { ...m.crm.loaded, noResponse: 1 }),
    (m) => (m.crm.baseline = { ...m.crm.baseline, noResponse: 1 }),
    (m) => (m.peakRuntimeMemBytes = THRESHOLDS.runtimeMemoryBytes),
    (m) => (m.recordWallP95Ms = 240_001),
    (m) => (m.requestTimeoutMs = 300_000),
    (m) => (m.coldLoadMs = 180_001),
    (m) => (m.cpuIdleAfterAbortMs = 10_001),
    (m) => (m.estimate.uk.share = 0.94),
    (m) => (m.emptyAnswerRate = 0.06),
    (m) => (m.mp03.uk.schemaValidRate = 0.89),
    (m) => (m.mp03.en.schemaValidRate = 0.89),
    (m) => (m.mp03.uk.inventedUrls = [{ id: 'x', url: 'https://a.example/' }]),
    (m) => (m.mp03.en.inventedUrls = [{ id: 'x', url: 'https://a.example/' }]),
    (m) => (m.mp03.uk.fieldAccuracy = 0.79),
    (m) => (m.mp03.en.fieldAccuracy = 0.79),
    (m) =>
      (m.mp03.en = { records: 0, schemaValidRate: null, inventedUrls: [], fieldAccuracy: null }),
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
  for (const k of [
    'coldLoadMs',
    'cpuIdleAfterAbortMs',
    'recordWallP95Ms',
    'emptyAnswerRate',
    'peakRuntimeMemBytes',
  ]) {
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

test('summary: an aborted candidate names the abort reason', () => {
  const text = summary([
    { candidate: 'a', pass: false, aborted: 'host available RAM 700 MiB < 800 MiB', rows: [] },
    { candidate: 'b', pass: false, rows: [] },
  ])
  assert.match(text, /^FAIL {2}a {2}\(aborted: host available RAM 700 MiB < 800 MiB\)$/m)
  assert.match(text, /^FAIL {2}b$/m)
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
  const perfectFor = (fx) => ({
    ...Object.fromEntries(Object.entries(fx.expected).filter(([k]) => k !== 'descriptionIncludes')),
    description: fx.expected.descriptionIncludes.join('. '),
  })
  const fx = buildFixtures().find((f) => f.lang === 'uk' && f.layout !== 'prefilled')
  const en = buildFixtures().find((f) => f.lang === 'en' && f.layout !== 'prefilled')
  const perfect = perfectFor(fx)
  const s = scoreMp03([
    { fixture: fx, record: perfect, schemaValid: true },
    { fixture: fx, record: { ...perfect, applyUrl: 'https://evil.example/x' }, schemaValid: true },
    { fixture: fx, record: null, schemaValid: false },
    { fixture: en, record: perfectFor(en), schemaValid: true },
  ])
  assert.equal(s.records, 4)
  assert.equal(s.uk.records, 3)
  assert.equal(s.uk.schemaValidRate, 2 / 3)
  assert.deepEqual(s.uk.inventedUrls, [{ id: fx.id, url: 'https://evil.example/x' }])
  assert.ok(s.uk.fieldAccuracy < 2 / 3)
  // the languages are scored apart: a perfect en does not lift a weak uk
  assert.equal(s.en.records, 1)
  assert.equal(s.en.schemaValidRate, 1)
  assert.equal(s.en.fieldAccuracy, 1)
  const m = passing()
  m.mp03 = s
  const failing = evaluate(m)
    .rows.filter((r) => !r.pass)
    .map((r) => r.name)
  assert.ok(failing.includes('MP-03 field accuracy (uk)'))
  assert.ok(!failing.includes('MP-03 field accuracy (en)'))
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

test('mp04.mjs: a non-numeric flag is refused at parse, before anything runs', () => {
  const cli = join(here, 'mp04.mjs')
  for (const [flag, value] of [
    ['--probe-interval-ms', 'fast'],
    ['--baseline-s', '-1'],
    ['--fixtures', '0'],
  ]) {
    const r = spawnSync(
      process.execPath,
      [
        cli,
        '--candidate',
        'x.json',
        '--api-dist',
        'x',
        '--runtime-url',
        'http://127.0.0.1:9',
        '--crm-url',
        'http://127.0.0.1:9/',
        '--out-dir',
        'x',
        flag,
        value,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(r.status, 2, flag)
    assert.match(r.stderr, new RegExp(flag), flag)
  }
})
