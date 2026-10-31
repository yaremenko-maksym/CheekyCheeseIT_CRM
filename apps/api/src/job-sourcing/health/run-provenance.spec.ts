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
  it('is the most recent run that fetched items without failing', () => {
    const runs = [
      run({ runId: 'r-failed', outcome: 'FAILED', received: 0 }),
      run({ runId: 'r-good', outcome: 'SUCCEEDED', received: 40 }),
      run({ runId: 'r-older', outcome: 'SUCCEEDED', received: 10 }),
    ]
    expect(lastGoodRunId(runs)).toBe('r-good')
  })

  it('is null when nothing ever fetched items', () => {
    expect(lastGoodRunId([run({ runId: 'r', outcome: 'FAILED', received: 0 })])).toBeNull()
  })
})

describe('firstBadRunId', () => {
  it('is the oldest run of the current head streak of bad readings', () => {
    const runs = [
      run({ runId: 'bad-new', outcome: 'FAILED', received: 0 }),
      run({ runId: 'bad-old', received: 0, lastHttpStatus: 500 }),
      run({ runId: 'good', received: 30 }),
    ]
    expect(firstBadRunId(runs)).toBe('bad-old')
  })

  it('does not count a 304 as a bad reading', () => {
    const runs = [run({ runId: 'nm', received: 0, lastHttpStatus: 304 })]
    expect(firstBadRunId(runs)).toBeNull()
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
    const evidence = buildEvidence(runs, ['VOLUME_DROP'], 0)
    expect(evidence).toMatchObject({
      reasons: ['VOLUME_DROP'],
      consecutiveFailures: 0,
      latestRunId: 'latest',
      observed: { received: 5, bytesRead: 2_000, httpStatus: 200 },
      baseline: { receivedMedian: 100 },
    })
  })

  it('excludes failed runs from the received baseline', () => {
    const runs = [
      run({ runId: 'latest', received: 0, outcome: 'FAILED' }),
      run({ runId: 'r2', received: 80 }),
      run({ runId: 'r3', received: 80 }),
    ]
    expect(buildEvidence(runs, [], 1).baseline).toEqual({ receivedMedian: 80 })
  })

  it('stays small enough for the 8192-char evidence CHECK', () => {
    const runs = Array.from({ length: 50 }, (_, i) => run({ runId: `r${i}`, received: i }))
    expect(
      JSON.stringify(buildEvidence(runs, ['VOLUME_DROP', 'SLOW'], 2)).length,
    ).toBeLessThanOrEqual(8192)
  })
})
