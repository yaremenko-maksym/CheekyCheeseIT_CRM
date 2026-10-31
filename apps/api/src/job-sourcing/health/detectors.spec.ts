/**
 * Source-fetch-strategy U4 AC 1 — one unit test per detector: a seeded run history that
 * triggers it and one that does not. Pure; no database.
 */
import { describe, expect, it } from 'vitest'
import {
  detectAccessChange,
  detectBoardGone,
  detectDeadlineNear,
  detectEmptyResponse,
  detectFormatDrift,
  detectSilence,
  detectSlowdownGrowth,
  detectStaleFeed,
  detectVolumeDrop,
  runDetectors,
} from './detectors'
import type { HealthSnapshot, RunFact } from './types'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-01-15T12:00:00.000Z') // a Thursday (2026-01-01 is a Thursday)

function run(overrides: Partial<RunFact> & { startedAt: Date }): RunFact {
  return {
    runId: `run-${overrides.startedAt.toISOString()}-${Math.random().toString(36).slice(2, 8)}`,
    endedAt: new Date(overrides.startedAt.getTime() + 2_000),
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
    ...overrides,
  }
}

function snap(runs: readonly RunFact[], extra: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    now: NOW,
    runs,
    isEmployerBoard: false,
    freshnessMaxAgeMs: null,
    policyDeadline: null,
    ...extra,
  }
}

/** One run per day for `days` days back from NOW, newest first. */
function daily(days: number, overridesFor: (dayIndex: number) => Partial<RunFact> = () => ({})) {
  return Array.from({ length: days }, (_, i) =>
    run({ startedAt: new Date(NOW.getTime() - i * DAY_MS), ...overridesFor(i) }),
  )
}

describe('detectVolumeDrop', () => {
  it('fires when 24h received is below 30% of the same-weekday 14-day median', () => {
    // 14 days of 100/day; today (a Thursday) dropped to 10. Past Thursdays: 100, 100.
    const runs = daily(14, (i) => ({ received: i === 0 ? 10 : 100 }))
    expect(detectVolumeDrop(snap(runs))).toContain('VOLUME_DROP')
  })

  it('does not fire when today is in line with the same-weekday baseline', () => {
    const runs = daily(14, () => ({ received: 100 }))
    expect(detectVolumeDrop(snap(runs))).toEqual([])
  })

  it('does not fire without 7 days of history', () => {
    const runs = daily(4, (i) => ({ received: i === 0 ? 1 : 100 }))
    expect(detectVolumeDrop(snap(runs))).toEqual([])
  })
})

describe('detectSilence', () => {
  it('fires when no new items for 4x the median gap while still receiving', () => {
    // New items every ~1 day, but the last one was 10 days ago; still receiving since.
    const newItemRuns = [10, 11, 12, 13].map((d) =>
      run({ startedAt: new Date(NOW.getTime() - d * DAY_MS), created: 3, received: 50 }),
    )
    const recentReceiving = [1, 2, 3].map((d) =>
      run({ startedAt: new Date(NOW.getTime() - d * DAY_MS), created: 0, received: 40 }),
    )
    expect(detectSilence(snap([...recentReceiving, ...newItemRuns]))).toContain('NO_NEW_ITEMS')
  })

  it('does not fire when new items are recent', () => {
    const runs = [2, 3, 4].map((d) =>
      run({ startedAt: new Date(NOW.getTime() - d * DAY_MS), created: 3, received: 50 }),
    )
    expect(detectSilence(snap(runs))).toEqual([])
  })
})

describe('detectEmptyResponse', () => {
  it('fires on two consecutive empty (non-304) runs when the median is above 0', () => {
    const runs = [
      run({ startedAt: new Date(NOW.getTime() - 1 * DAY_MS), received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - 2 * DAY_MS), received: 0 }),
      ...daily(5).map((r) => ({ ...r, startedAt: new Date(r.startedAt.getTime() - 3 * DAY_MS) })),
    ]
    expect(detectEmptyResponse(snap(runs))).toContain('EMPTY_RESPONSE')
  })

  it('does not fire when only the most recent run is empty', () => {
    const runs = [
      run({ startedAt: new Date(NOW.getTime() - 1 * DAY_MS), received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - 2 * DAY_MS), received: 50 }),
      run({ startedAt: new Date(NOW.getTime() - 3 * DAY_MS), received: 50 }),
    ]
    expect(detectEmptyResponse(snap(runs))).toEqual([])
  })

  it('does not count 304 runs toward EMPTY_RESPONSE (AC 4)', () => {
    // The two most recent runs are 304 with received 0; the real history is non-empty.
    const runs = [
      run({ startedAt: new Date(NOW.getTime() - 1 * DAY_MS), received: 0, lastHttpStatus: 304 }),
      run({ startedAt: new Date(NOW.getTime() - 2 * DAY_MS), received: 0, lastHttpStatus: 304 }),
      run({ startedAt: new Date(NOW.getTime() - 3 * DAY_MS), received: 50 }),
      run({ startedAt: new Date(NOW.getTime() - 4 * DAY_MS), received: 50 }),
    ]
    expect(detectEmptyResponse(snap(runs))).toEqual([])
  })
})

describe('detectFormatDrift', () => {
  it('fires on a PARSE_DRIFT ending', () => {
    const runs = [run({ startedAt: NOW, errorCode: 'PARSE_DRIFT', outcome: 'FAILED' })]
    expect(detectFormatDrift(snap(runs))).toContain('SCHEMA_DRIFT')
  })

  it('fires when invalid/received exceeds 10%', () => {
    const runs = [run({ startedAt: NOW, received: 100, invalid: 20 })]
    expect(detectFormatDrift(snap(runs))).toContain('SCHEMA_DRIFT')
  })

  it('fires when the envelope fingerprint changed', () => {
    const runs = [
      run({ startedAt: NOW, envelopeFingerprint: 'a'.repeat(64) }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), envelopeFingerprint: 'b'.repeat(64) }),
    ]
    expect(detectFormatDrift(snap(runs))).toContain('SCHEMA_DRIFT')
  })

  it('does not fire on a clean run', () => {
    const runs = [run({ startedAt: NOW, received: 100, invalid: 2 })]
    expect(detectFormatDrift(snap(runs))).toEqual([])
  })
})

describe('detectAccessChange', () => {
  it('reports ACCESS_CHANGED on 403', () => {
    expect(detectAccessChange(snap([run({ startedAt: NOW, lastHttpStatus: 403 })]))).toContain(
      'ACCESS_CHANGED',
    )
  })

  it('reports THROTTLED on 429', () => {
    expect(detectAccessChange(snap([run({ startedAt: NOW, lastHttpStatus: 429 })]))).toContain(
      'THROTTLED',
    )
  })

  it('does not fire on 200', () => {
    expect(detectAccessChange(snap([run({ startedAt: NOW, lastHttpStatus: 200 })]))).toEqual([])
  })
})

describe('detectSlowdownGrowth', () => {
  it('reports SLOW when the latest duration is over 3x the median', () => {
    const normal = daily(10).map((r) => ({
      ...r,
      endedAt: new Date(r.startedAt.getTime() + 1_000),
    }))
    const slow = run({ startedAt: NOW, endedAt: new Date(NOW.getTime() + 10_000) })
    expect(detectSlowdownGrowth(snap([slow, ...normal]))).toContain('SLOW')
  })

  it('reports PAYLOAD_GROWTH when the latest bytes are over 3x the median', () => {
    const normal = daily(10).map((r) => ({ ...r, bytesRead: 1_000 }))
    const big = run({ startedAt: NOW, bytesRead: 10_000 })
    expect(detectSlowdownGrowth(snap([big, ...normal]))).toContain('PAYLOAD_GROWTH')
  })

  it('does not fire on steady runs', () => {
    const runs = daily(10).map((r) => ({ ...r, bytesRead: 1_000 }))
    expect(detectSlowdownGrowth(snap(runs))).toEqual([])
  })
})

describe('detectStaleFeed', () => {
  it('fires when the newest item is older than the provider allowance', () => {
    const runs = [
      run({ startedAt: NOW, newestItemPublishedAt: new Date(NOW.getTime() - 3 * DAY_MS) }),
    ]
    expect(detectStaleFeed(snap(runs, { freshnessMaxAgeMs: DAY_MS }))).toContain('STALE_FEED')
  })

  it('does not fire when the newest item is fresh', () => {
    const runs = [
      run({ startedAt: NOW, newestItemPublishedAt: new Date(NOW.getTime() - 3_600_000) }),
    ]
    expect(detectStaleFeed(snap(runs, { freshnessMaxAgeMs: DAY_MS }))).toEqual([])
  })
})

describe('detectBoardGone', () => {
  it('fires when an employer board returns zero after having had some', () => {
    const runs = [
      run({ startedAt: NOW, received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 12 }),
    ]
    expect(detectBoardGone(snap(runs, { isEmployerBoard: true }))).toContain('BOARD_GONE')
  })

  it('does not fire for a non-board feed', () => {
    const runs = [
      run({ startedAt: NOW, received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 12 }),
    ]
    expect(detectBoardGone(snap(runs, { isEmployerBoard: false }))).toEqual([])
  })
})

describe('detectDeadlineNear', () => {
  it('fires when a policy deadline is under 30 days away', () => {
    expect(
      detectDeadlineNear(snap([], { policyDeadline: new Date(NOW.getTime() + 10 * DAY_MS) })),
    ).toContain('DEADLINE_NEAR')
  })

  it('does not fire for a far-off deadline', () => {
    expect(
      detectDeadlineNear(snap([], { policyDeadline: new Date(NOW.getTime() + 60 * DAY_MS) })),
    ).toEqual([])
  })

  it('does not fire for a passed deadline (that is a BLOCKED cause, not a reason)', () => {
    expect(
      detectDeadlineNear(snap([], { policyDeadline: new Date(NOW.getTime() - DAY_MS) })),
    ).toEqual([])
  })
})

describe('runDetectors', () => {
  it('returns the distinct union of fired reasons', () => {
    const runs = [
      run({ startedAt: NOW, lastHttpStatus: 403, errorCode: 'PARSE_DRIFT', outcome: 'FAILED' }),
    ]
    const reasons = runDetectors(snap(runs))
    expect(reasons).toContain('ACCESS_CHANGED')
    expect(reasons).toContain('SCHEMA_DRIFT')
    expect(new Set(reasons).size).toBe(reasons.length)
  })
})
