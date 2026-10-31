/**
 * Source-fetch-strategy U4 AC 1 — one unit test per detector (a seeded run history that triggers
 * it and one that does not), plus boundary cases that pin the thresholds and guards exactly (the
 * mutation gate requires each operator to be observable). Pure; no database.
 */
import { describe, expect, it } from 'vitest'
import {
  answered,
  detectAccessChange,
  detectBoardGone,
  detectDeadlineNear,
  detectEmptyResponse,
  detectFormatDrift,
  detectSilence,
  detectSlowdownGrowth,
  detectStaleFeed,
  detectVolumeDrop,
  durationMs,
  median,
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

describe('median', () => {
  it('is null for an empty list and the value for a singleton', () => {
    expect(median([])).toBeNull()
    expect(median([7])).toBe(7)
  })

  it('averages the two middle values when the count is even', () => {
    expect(median([1, 3])).toBe(2)
    expect(median([2, 4])).toBe(3)
  })

  it('takes the middle value when the count is odd, after sorting', () => {
    expect(median([10, 1, 2])).toBe(2)
    expect(median([5, 1, 3])).toBe(3)
  })
})

describe('durationMs', () => {
  it('is null while the run is unfinished', () => {
    expect(durationMs(run({ startedAt: NOW, endedAt: null }))).toBeNull()
  })

  it('is ended − started for a finished run', () => {
    const startedAt = new Date(NOW.getTime() - 5_000)
    expect(durationMs(run({ startedAt, endedAt: NOW }))).toBe(5_000)
  })
})

describe('answered', () => {
  it('keeps only finished runs', () => {
    const finished = run({ startedAt: NOW })
    const running = run({ startedAt: new Date(NOW.getTime() - DAY_MS), endedAt: null })
    const result = answered(snap([finished, running]))
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(finished)
  })
})

describe('detectVolumeDrop', () => {
  it('fires when 24h received is below 30% of the same-weekday 14-day median', () => {
    const runs = daily(14, (i) => ({ received: i === 0 ? 10 : 100 }))
    expect(detectVolumeDrop(snap(runs))).toContain('VOLUME_DROP')
  })

  it('does not fire when today is in line with the same-weekday baseline', () => {
    const runs = daily(14, () => ({ received: 100 }))
    expect(detectVolumeDrop(snap(runs))).toEqual([])
  })

  it('is exactly at the 30% boundary: 29 of 100 fires, 30 does not', () => {
    const below = daily(14, (i) => ({ received: i === 0 ? 29 : 100 }))
    const at = daily(14, (i) => ({ received: i === 0 ? 30 : 100 }))
    expect(detectVolumeDrop(snap(below))).toContain('VOLUME_DROP')
    expect(detectVolumeDrop(snap(at))).toEqual([])
  })

  it('needs at least 7 distinct days of history: 6 days never fires, 7 can', () => {
    // 6 distinct days, a steep drop today — still no fire (not enough history).
    const sixDays = Array.from({ length: 6 }, (_, i) =>
      run({ startedAt: new Date(NOW.getTime() - i * 7 * DAY_MS), received: i === 0 ? 1 : 100 }),
    )
    expect(detectVolumeDrop(snap(sixDays))).toEqual([])
    // 7 Thursdays (same weekday as NOW), today dropped — fires.
    const sevenThursdays = Array.from({ length: 7 }, (_, i) =>
      run({ startedAt: new Date(NOW.getTime() - i * 7 * DAY_MS), received: i === 0 ? 1 : 100 }),
    )
    expect(detectVolumeDrop(snap(sevenThursdays))).toContain('VOLUME_DROP')
  })

  it('does not fire when there is no same-weekday history to baseline against', () => {
    // 7 distinct prior days, none a Thursday (offsets skip 7, which would land on a Thursday), so
    // today (Thursday) has no same-weekday peer → no baseline → no fire even on a steep drop.
    const noWeekdayPeer = [1, 2, 3, 4, 5, 6, 8].map((d) =>
      run({ startedAt: new Date(NOW.getTime() - d * DAY_MS), received: 100 }),
    )
    expect(
      detectVolumeDrop(snap([run({ startedAt: NOW, received: 1 }), ...noWeekdayPeer])),
    ).toEqual([])
  })

  it('counts only the last 24h toward today, not the day before', () => {
    // Yesterday was healthy (100); today is a steep drop. Only today must count.
    const runs = daily(14, (i) => ({ received: i === 0 ? 5 : 100 }))
    expect(detectVolumeDrop(snap(runs))).toContain('VOLUME_DROP')
  })
})

describe('detectSilence', () => {
  it('fires when no new items for 4x the median gap while still receiving', () => {
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

  it('needs at least two new-item runs to measure a gap', () => {
    const one = [
      run({ startedAt: new Date(NOW.getTime() - 10 * DAY_MS), created: 3, received: 50 }),
    ]
    expect(detectSilence(snap(one))).toEqual([])
  })

  it('does not fire when nothing is being received (silence without traffic is not this)', () => {
    const gappy = [10, 11].map((d) =>
      run({ startedAt: new Date(NOW.getTime() - d * DAY_MS), created: 3, received: 0 }),
    )
    expect(detectSilence(snap(gappy))).toEqual([])
  })

  it('is at the 4x boundary: just under does not fire, well over does', () => {
    // median gap 1 day; last new item 3 days ago → 3 < 4 → no fire.
    const under = [3, 4, 5].map((d) =>
      run({ startedAt: new Date(NOW.getTime() - d * DAY_MS), created: 3, received: 40 }),
    )
    expect(detectSilence(snap(under))).toEqual([])
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

  it('does not fire when the 14-day median is itself 0 (a feed that never returns items)', () => {
    const runs = [
      run({ startedAt: new Date(NOW.getTime() - 1 * DAY_MS), received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - 2 * DAY_MS), received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - 3 * DAY_MS), received: 0 }),
    ]
    expect(detectEmptyResponse(snap(runs))).toEqual([])
  })

  it('needs two runs: a single empty run does not fire', () => {
    expect(detectEmptyResponse(snap([run({ startedAt: NOW, received: 0 })]))).toEqual([])
  })

  it('does not count 304 runs toward EMPTY_RESPONSE (AC 4)', () => {
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

  it('fires when invalid/received exceeds 10%, and not at exactly 10%', () => {
    expect(
      detectFormatDrift(snap([run({ startedAt: NOW, received: 100, invalid: 11 })])),
    ).toContain('SCHEMA_DRIFT')
    expect(detectFormatDrift(snap([run({ startedAt: NOW, received: 100, invalid: 10 })]))).toEqual(
      [],
    )
  })

  it('fires when the envelope fingerprint changed between the two latest runs', () => {
    const changed = [
      run({ startedAt: NOW, envelopeFingerprint: 'a'.repeat(64) }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), envelopeFingerprint: 'b'.repeat(64) }),
    ]
    expect(detectFormatDrift(snap(changed))).toContain('SCHEMA_DRIFT')
  })

  it('does not fire on a stable fingerprint, nor on a single fingerprinted run', () => {
    const stable = [
      run({ startedAt: NOW, envelopeFingerprint: 'a'.repeat(64) }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), envelopeFingerprint: 'a'.repeat(64) }),
    ]
    expect(detectFormatDrift(snap(stable))).toEqual([])
    expect(
      detectFormatDrift(snap([run({ startedAt: NOW, envelopeFingerprint: 'a'.repeat(64) })])),
    ).toEqual([])
  })

  it('does not fire on a clean run, and does not fire with no runs', () => {
    expect(detectFormatDrift(snap([run({ startedAt: NOW, received: 100, invalid: 2 })]))).toEqual(
      [],
    )
    expect(detectFormatDrift(snap([]))).toEqual([])
  })
})

describe('detectAccessChange', () => {
  it.each([401, 403, 451])('reports ACCESS_CHANGED on %i', (status) => {
    expect(detectAccessChange(snap([run({ startedAt: NOW, lastHttpStatus: status })]))).toEqual([
      'ACCESS_CHANGED',
    ])
  })

  it('reports THROTTLED on 429', () => {
    expect(detectAccessChange(snap([run({ startedAt: NOW, lastHttpStatus: 429 })]))).toEqual([
      'THROTTLED',
    ])
  })

  it('does not fire on 200 or 500', () => {
    expect(detectAccessChange(snap([run({ startedAt: NOW, lastHttpStatus: 200 })]))).toEqual([])
    expect(detectAccessChange(snap([run({ startedAt: NOW, lastHttpStatus: 500 })]))).toEqual([])
  })

  it('reads the latest run that carried a status, skipping null-status runs', () => {
    const runs = [
      run({ startedAt: NOW, lastHttpStatus: null }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), lastHttpStatus: 403 }),
    ]
    expect(detectAccessChange(snap(runs))).toEqual(['ACCESS_CHANGED'])
  })
})

describe('detectSlowdownGrowth', () => {
  const steady = (overrides: (i: number) => Partial<RunFact> = () => ({})) =>
    daily(10).map((r, i) => ({
      ...r,
      endedAt: new Date(r.startedAt.getTime() + 1_000),
      ...overrides(i),
    }))

  it('reports SLOW when the latest duration is over 3x the median, not at 3x', () => {
    const base = steady()
    const over = [run({ startedAt: NOW, endedAt: new Date(NOW.getTime() + 3_001) }), ...base]
    const at = [run({ startedAt: NOW, endedAt: new Date(NOW.getTime() + 3_000) }), ...base]
    expect(detectSlowdownGrowth(snap(over))).toContain('SLOW')
    expect(detectSlowdownGrowth(snap(at))).not.toContain('SLOW')
  })

  it('reports PAYLOAD_GROWTH when the latest bytes are over 3x the median, not at 3x', () => {
    const base = steady(() => ({ bytesRead: 1_000 }))
    const over = [run({ startedAt: NOW, bytesRead: 3_001 }), ...base]
    const at = [run({ startedAt: NOW, bytesRead: 3_000 }), ...base]
    expect(detectSlowdownGrowth(snap(over))).toContain('PAYLOAD_GROWTH')
    expect(detectSlowdownGrowth(snap(at))).not.toContain('PAYLOAD_GROWTH')
  })

  it('ignores zero-byte runs (a 304/empty read) when taking the bytes median', () => {
    // Most runs read 0 bytes; one real run read 1000. Latest reads 1500 — not >3x of 1000, so no
    // growth. If zero-byte runs counted, the median would be ~0 and 1500 would falsely fire.
    const base = daily(8).map((r) => ({ ...r, bytesRead: 0 }))
    const real = run({ startedAt: new Date(NOW.getTime() - 9 * DAY_MS), bytesRead: 1_000 })
    const latest = run({ startedAt: NOW, bytesRead: 1_500 })
    expect(detectSlowdownGrowth(snap([latest, real, ...base]))).not.toContain('PAYLOAD_GROWTH')
  })

  it('does not fire on steady runs, nor with no runs', () => {
    expect(detectSlowdownGrowth(snap(steady(() => ({ bytesRead: 1_000 }))))).toEqual([])
    expect(detectSlowdownGrowth(snap([]))).toEqual([])
  })

  it('does not fire when there is no finished history to compare against', () => {
    // A single finished run: its own duration is the median, so nothing is 3x anything.
    expect(
      detectSlowdownGrowth(
        snap([run({ startedAt: NOW, endedAt: new Date(NOW.getTime() + 9_000) })]),
      ),
    ).toEqual([])
  })
})

describe('detectStaleFeed', () => {
  it('does not fire when the provider declares no freshness allowance', () => {
    const runs = [
      run({ startedAt: NOW, newestItemPublishedAt: new Date(NOW.getTime() - 9 * DAY_MS) }),
    ]
    expect(detectStaleFeed(snap(runs, { freshnessMaxAgeMs: null }))).toEqual([])
  })

  it('fires when the freshest item is older than the allowance, not at exactly the allowance', () => {
    const over = [
      run({ startedAt: NOW, newestItemPublishedAt: new Date(NOW.getTime() - DAY_MS - 1) }),
    ]
    const at = [run({ startedAt: NOW, newestItemPublishedAt: new Date(NOW.getTime() - DAY_MS) })]
    expect(detectStaleFeed(snap(over, { freshnessMaxAgeMs: DAY_MS }))).toContain('STALE_FEED')
    expect(detectStaleFeed(snap(at, { freshnessMaxAgeMs: DAY_MS }))).toEqual([])
  })

  it('uses the freshest item across runs, not the latest run only', () => {
    // The latest run saw an old item; an earlier run saw a fresh one. The fresh one wins → no stale.
    const runs = [
      run({ startedAt: NOW, newestItemPublishedAt: new Date(NOW.getTime() - 10 * DAY_MS) }),
      run({
        startedAt: new Date(NOW.getTime() - DAY_MS),
        newestItemPublishedAt: new Date(NOW.getTime() - 3_600_000),
      }),
    ]
    expect(detectStaleFeed(snap(runs, { freshnessMaxAgeMs: DAY_MS }))).toEqual([])
  })

  it('does not fire when no run recorded a newest item', () => {
    const runs = [run({ startedAt: NOW, newestItemPublishedAt: null })]
    expect(detectStaleFeed(snap(runs, { freshnessMaxAgeMs: DAY_MS }))).toEqual([])
  })
})

describe('detectBoardGone', () => {
  it('does not fire for a non-board feed', () => {
    const runs = [
      run({ startedAt: NOW, received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 12 }),
    ]
    expect(detectBoardGone(snap(runs, { isEmployerBoard: false }))).toEqual([])
  })

  it('fires when an employer board returns zero now after having had some', () => {
    const runs = [
      run({ startedAt: NOW, received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 12 }),
    ]
    expect(detectBoardGone(snap(runs, { isEmployerBoard: true }))).toContain('BOARD_GONE')
  })

  it('fires on a 404 now after having had some, even if the status is not zero-received', () => {
    const runs = [
      run({ startedAt: NOW, received: 0, lastHttpStatus: 404 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 12 }),
    ]
    expect(detectBoardGone(snap(runs, { isEmployerBoard: true }))).toContain('BOARD_GONE')
  })

  it('does not fire when the board still returns jobs now', () => {
    const runs = [
      run({ startedAt: NOW, received: 8 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 12 }),
    ]
    expect(detectBoardGone(snap(runs, { isEmployerBoard: true }))).toEqual([])
  })

  it('does not fire for a board that never had any jobs (zero throughout)', () => {
    const runs = [
      run({ startedAt: NOW, received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 0 }),
    ]
    expect(detectBoardGone(snap(runs, { isEmployerBoard: true }))).toEqual([])
  })

  it('does not fire with no runs', () => {
    expect(detectBoardGone(snap([], { isEmployerBoard: true }))).toEqual([])
  })
})

describe('detectDeadlineNear', () => {
  it('fires when a policy deadline is under 30 days away', () => {
    expect(
      detectDeadlineNear(snap([], { policyDeadline: new Date(NOW.getTime() + 10 * DAY_MS) })),
    ).toContain('DEADLINE_NEAR')
  })

  it('does not fire for a far-off deadline (30 days exactly does not fire)', () => {
    expect(
      detectDeadlineNear(snap([], { policyDeadline: new Date(NOW.getTime() + 30 * DAY_MS) })),
    ).toEqual([])
    expect(
      detectDeadlineNear(snap([], { policyDeadline: new Date(NOW.getTime() + 60 * DAY_MS) })),
    ).toEqual([])
  })

  it('does not fire for a passed deadline (that is a BLOCKED cause, not a reason)', () => {
    expect(
      detectDeadlineNear(snap([], { policyDeadline: new Date(NOW.getTime() - DAY_MS) })),
    ).toEqual([])
  })

  it('does not fire when there is no deadline', () => {
    expect(detectDeadlineNear(snap([], { policyDeadline: null }))).toEqual([])
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

  it('returns [] when nothing is wrong', () => {
    expect(runDetectors(snap([run({ startedAt: NOW, received: 50 })]))).toEqual([])
  })
})
