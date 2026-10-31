/**
 * Source-fetch-strategy U4 CR-M-3 / SPEC-M-2 — the run-bracketing provenance and the evidence
 * JSON, unit-tested (not integration-only). Pure; no database.
 */
import { describe, expect, it } from 'vitest'
import { buildEvidence, firstBadRunId, lastGoodRunId, type PassRun } from './run-provenance'

const T0 = new Date('2026-02-01T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function run(over: Partial<PassRun> & { runId: string }): PassRun {
  return {
    startedAt: T0,
    endedAt: new Date(T0.getTime() + 1_000),
    outcome: 'SUCCEEDED',
    received: 50,
    created: 0,
    invalid: 0,
    bytesRead: 1_000,
    lastHttpStatus: 200,
    newestItemPublishedAt: null,
    envelopeFingerprint: null,
    errorCode: null,
    adapterVersion: 'reporting-1',
    configVersion: 1,
    errorMessage: null,
    ...over,
  }
}

describe('lastGoodRunId', () => {
  it('skips a FAILED run even when it reported items, and takes the latest successful one', () => {
    // A failed run with received > 0 must NOT be "good": only a success/partial that fetched counts.
    const runs = [
      run({ runId: 'r-failed', outcome: 'FAILED', received: 99 }),
      run({ runId: 'r-good', outcome: 'SUCCEEDED', received: 40 }),
      run({ runId: 'r-older', outcome: 'SUCCEEDED', received: 10 }),
    ]
    expect(lastGoodRunId(runs)).toBe('r-good')
  })

  it('requires received above zero (a clean empty success is not a good reading)', () => {
    const runs = [
      run({ runId: 'r-empty', outcome: 'SUCCEEDED', received: 0 }),
      run({ runId: 'r-items', outcome: 'SUCCEEDED', received: 5 }),
    ]
    expect(lastGoodRunId(runs)).toBe('r-items')
  })

  it('counts a PARTIAL run that fetched items as good', () => {
    expect(lastGoodRunId([run({ runId: 'p', outcome: 'PARTIAL', received: 3 })])).toBe('p')
  })

  it('is null when nothing ever fetched items', () => {
    expect(lastGoodRunId([run({ runId: 'r', outcome: 'FAILED', received: 0 })])).toBeNull()
  })
})

describe('firstBadRunId', () => {
  it('counts a FAILED run as bad even with items and a 200 (kills the FAILED clause)', () => {
    const runs = [
      run({ runId: 'f', outcome: 'FAILED', received: 7, lastHttpStatus: 200 }),
      run({ runId: 'g', received: 30 }),
    ]
    expect(firstBadRunId(runs)).toBe('f')
  })

  it('counts a CANCELLED run as bad even with items (kills the CANCELLED clause)', () => {
    const runs = [
      run({ runId: 'c', outcome: 'CANCELLED', received: 7, lastHttpStatus: 200 }),
      run({ runId: 'g', received: 30 }),
    ]
    expect(firstBadRunId(runs)).toBe('c')
  })

  it('counts a non-304 empty success as bad', () => {
    const runs = [
      run({ runId: 'e', received: 0, lastHttpStatus: 200 }),
      run({ runId: 'g', received: 30 }),
    ]
    expect(firstBadRunId(runs)).toBe('e')
  })

  it('walks the whole head streak to its oldest bad run, stopping at the first good one', () => {
    const runs = [
      run({ runId: 'bad-new', outcome: 'FAILED', received: 0 }),
      run({ runId: 'bad-old', received: 0, lastHttpStatus: 500 }),
      run({ runId: 'good', received: 30 }),
      run({ runId: 'bad-ancient', outcome: 'FAILED', received: 0 }),
    ]
    expect(firstBadRunId(runs)).toBe('bad-old')
  })

  it('does not count a 304 as a bad reading', () => {
    expect(firstBadRunId([run({ runId: 'nm', received: 0, lastHttpStatus: 304 })])).toBeNull()
  })

  it('is null when the latest reading is good', () => {
    expect(firstBadRunId([run({ runId: 'g', received: 30 })])).toBeNull()
  })
})

describe('buildEvidence', () => {
  it('carries the observed metrics against the received baseline, the reasons and run ids', () => {
    const runs = [
      run({ runId: 'latest', received: 5, bytesRead: 2_000, lastHttpStatus: 200 }),
      run({ runId: 'r2', received: 100 }),
      run({ runId: 'r3', received: 100 }),
    ]
    expect(buildEvidence(runs, ['VOLUME_DROP'], 0, T0)).toMatchObject({
      reasons: ['VOLUME_DROP'],
      consecutiveFailures: 0,
      latestRunId: 'latest',
      observed: { received: 5, bytesRead: 2_000, httpStatus: 200 },
      baseline: { receivedMedian: 100 },
    })
  })

  it('reports the latest run newest-item instant in the observed metrics', () => {
    const when = new Date('2026-01-30T00:00:00.000Z')
    const runs = [run({ runId: 'latest', newestItemPublishedAt: when }), run({ runId: 'r2' })]
    const observed = buildEvidence(runs, [], 0, T0).observed as {
      newestItemPublishedAt: string | null
    }
    expect(observed.newestItemPublishedAt).toBe(when.toISOString())
  })

  it('is all-null and baseline-null for an empty run list (no latest to read)', () => {
    expect(buildEvidence([], [], 0, T0)).toMatchObject({
      latestRunId: null,
      observed: { received: null, bytesRead: null, httpStatus: null, newestItemPublishedAt: null },
      baseline: { receivedMedian: null },
    })
  })

  it('includes PARTIAL runs in the received baseline, and excludes failed runs', () => {
    const runs = [
      run({ runId: 'latest', received: 0, outcome: 'FAILED' }),
      run({ runId: 'p', received: 60, outcome: 'PARTIAL' }),
      run({ runId: 's', received: 80, outcome: 'SUCCEEDED' }),
    ]
    // Baseline over the fetched (PARTIAL 60, SUCCEEDED 80) → median 70; the failed 0 is excluded.
    expect(buildEvidence(runs, [], 1, T0).baseline).toEqual({ receivedMedian: 70 })
  })

  it('stays small enough for the 8192-char evidence CHECK', () => {
    const runs = Array.from({ length: 50 }, (_, i) => run({ runId: `r${i}`, received: i }))
    expect(
      JSON.stringify(buildEvidence(runs, ['VOLUME_DROP', 'SLOW'], 2, T0)).length,
    ).toBeLessThanOrEqual(8192)
  })
})

/**
 * SPEC-M-5 — each threshold detector's evidence carries BOTH the observed value and the baseline it
 * was compared against. These mirror the comparisons in `detectSlowdownGrowth` / `detectVolumeDrop`.
 */
describe('buildEvidence metrics (SPEC-M-5)', () => {
  type Metrics = {
    SLOW: { observedMs: number | null; baselineMs: number | null }
    PAYLOAD_GROWTH: { observedBytes: number | null; baselineBytes: number | null }
    VOLUME_DROP: { observed24hReceived: number; baselineSameWeekdayMedian: number | null }
  }
  const HOUR = 60 * 60 * 1000
  const metricsOf = (runs: readonly PassRun[], now: Date): Metrics =>
    buildEvidence(runs, [], 0, now).metrics as Metrics
  const THURSDAY = new Date('2026-02-05T12:00:00.000Z') // 2026-01-01 is a Thursday, +35d
  const dur = (runId: string, startedAt: Date, ms: number, over: Partial<PassRun> = {}) =>
    run({ runId, startedAt, endedAt: new Date(startedAt.getTime() + ms), ...over })

  it('SLOW: observed = latest finished duration; the baseline excludes a zero-duration run', () => {
    const runs = [
      dur('latest', T0, 9_000),
      dur('b1', new Date(T0.getTime() - DAY), 1_000),
      dur('b2', new Date(T0.getTime() - 2 * DAY), 3_000),
      dur('instant', new Date(T0.getTime() - 3 * DAY), 0), // zero duration → excluded from the median
    ]
    const m = metricsOf(runs, T0)
    // positive durations 9000/1000/3000 → median 3000; a zero-duration run would drag it to 2000.
    expect(m.SLOW).toEqual({ observedMs: 9_000, baselineMs: 3_000 })
  })

  it('SLOW: an unfinished run contributes neither observed nor baseline', () => {
    const unfinished = run({ runId: 'latest', endedAt: null })
    const m = metricsOf([unfinished, dur('done', T0, 4_000)], T0)
    // latest finished is `done` (the null-ended run is skipped), and the median is over it alone.
    expect(m.SLOW).toEqual({ observedMs: 4_000, baselineMs: 4_000 })
  })

  it('PAYLOAD_GROWTH: observed = latest bytes_read, baseline = the positive-bytes median', () => {
    const runs = [
      run({ runId: 'latest', bytesRead: 5_000 }),
      run({ runId: 'r2', bytesRead: 1_000 }),
      run({ runId: 'r3', bytesRead: 1_000 }),
    ]
    expect(metricsOf(runs, T0).PAYLOAD_GROWTH).toEqual({
      observedBytes: 5_000,
      baselineBytes: 1_000,
    })
  })

  it('PAYLOAD_GROWTH: a null and a zero byte reading are excluded from the baseline median', () => {
    const runs = [
      run({ runId: 'latest', bytesRead: 9_000 }),
      run({ runId: 'z', bytesRead: 0 }),
      run({ runId: 'n', bytesRead: null }),
      run({ runId: 'r', bytesRead: 300 }),
    ]
    // Only the positive readings (9000, 300) form the median → 4650; the 0 and null are dropped.
    expect(metricsOf(runs, T0).PAYLOAD_GROWTH.baselineBytes).toBe(4_650)
  })

  it('is all-null metrics for an empty run list', () => {
    expect(metricsOf([], T0)).toEqual({
      SLOW: { observedMs: null, baselineMs: null },
      PAYLOAD_GROWTH: { observedBytes: null, baselineBytes: null },
      VOLUME_DROP: { observed24hReceived: 0, baselineSameWeekdayMedian: null },
    })
  })

  it('VOLUME_DROP: observed = the 24h SUM over SUCCEEDED+PARTIAL; baseline excludes today and off-weekday', () => {
    const within = [
      dur('s', new Date(THURSDAY.getTime() - 1 * HOUR), 1_000, { received: 10 }),
      dur('p', new Date(THURSDAY.getTime() - 2 * HOUR), 1_000, { received: 5, outcome: 'PARTIAL' }),
    ]
    const priorThursdays = [
      dur('thuA', new Date(THURSDAY.getTime() - 7 * DAY), 1_000, { received: 100 }),
      dur('thuB', new Date(THURSDAY.getTime() - 14 * DAY), 1_000, { received: 200 }),
    ]
    // A Sunday (now − 3 days): a different weekday, must not enter the baseline.
    const offWeekday = dur('sun', new Date(THURSDAY.getTime() - 3 * DAY), 1_000, {
      received: 1_000,
    })
    const m = metricsOf([...within, ...priorThursdays, offWeekday], THURSDAY)
    // 24h sum = 10 + 5 (PARTIAL counts). Baseline = median(100, 200) = 150; including today (15) or
    // the Sunday (1000) would move it.
    expect(m.VOLUME_DROP).toEqual({ observed24hReceived: 15, baselineSameWeekdayMedian: 150 })
  })

  it('VOLUME_DROP: a run exactly 24h old is outside the window (strict `<`)', () => {
    const edge = dur('edge', new Date(THURSDAY.getTime() - DAY), 1_000, { received: 50 })
    const inside = dur('in', new Date(THURSDAY.getTime() - DAY + 1_000), 1_000, { received: 7 })
    // `now − startedAt === DAY_MS` for `edge` → excluded by the strict `<`; only `inside` counts.
    expect(metricsOf([edge, inside], THURSDAY).VOLUME_DROP.observed24hReceived).toBe(7)
  })

  it('VOLUME_DROP: a FAILED run counts toward neither the 24h sum nor the baseline', () => {
    const failedNow = dur('f', new Date(THURSDAY.getTime() - 1 * HOUR), 1_000, {
      received: 500,
      outcome: 'FAILED',
    })
    const okNow = dur('ok', new Date(THURSDAY.getTime() - 2 * HOUR), 1_000, { received: 7 })
    const priorThursday = dur('thu', new Date(THURSDAY.getTime() - 7 * DAY), 1_000, {
      received: 40,
    })
    const m = metricsOf([failedNow, okNow, priorThursday], THURSDAY)
    expect(m.VOLUME_DROP).toEqual({ observed24hReceived: 7, baselineSameWeekdayMedian: 40 })
  })

  it('VOLUME_DROP: with no prior same-weekday history the baseline is null', () => {
    const today = dur('t', new Date(THURSDAY.getTime() - 1 * HOUR), 1_000, { received: 3 })
    expect(metricsOf([today], THURSDAY).VOLUME_DROP).toEqual({
      observed24hReceived: 3,
      baselineSameWeekdayMedian: null,
    })
  })
})
