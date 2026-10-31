/**
 * Source-fetch-strategy U4 CR-M-3 / SPEC-M-2 — the run-bracketing provenance and the evidence
 * JSON, unit-tested (not integration-only). Pure; no database.
 */
import { describe, expect, it } from 'vitest'
import { buildEvidence, firstBadRunId, lastGoodRunId, type PassRun } from './run-provenance'

const T0 = new Date('2026-02-01T12:00:00.000Z')

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
    expect(buildEvidence(runs, ['VOLUME_DROP'], 0)).toMatchObject({
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
    const observed = buildEvidence(runs, [], 0).observed as { newestItemPublishedAt: string | null }
    expect(observed.newestItemPublishedAt).toBe(when.toISOString())
  })

  it('is all-null and baseline-null for an empty run list (no latest to read)', () => {
    expect(buildEvidence([], [], 0)).toMatchObject({
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
    expect(buildEvidence(runs, [], 1).baseline).toEqual({ receivedMedian: 70 })
  })

  it('stays small enough for the 8192-char evidence CHECK', () => {
    const runs = Array.from({ length: 50 }, (_, i) => run({ runId: `r${i}`, received: i }))
    expect(
      JSON.stringify(buildEvidence(runs, ['VOLUME_DROP', 'SLOW'], 2)).length,
    ).toBeLessThanOrEqual(8192)
  })
})
