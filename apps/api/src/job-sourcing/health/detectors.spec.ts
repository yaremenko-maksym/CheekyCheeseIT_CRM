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

  it('compares only the fingerprinted runs: a null-fingerprint run between two equal ones is skipped', () => {
    // Without the `!== null` filter the leading null would read as a change against 'a'.
    const runs = [
      run({ startedAt: NOW, envelopeFingerprint: null }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), envelopeFingerprint: 'a'.repeat(64) }),
      run({ startedAt: new Date(NOW.getTime() - 2 * DAY_MS), envelopeFingerprint: 'a'.repeat(64) }),
    ]
    expect(detectFormatDrift(snap(runs))).toEqual([])
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

  it('finds the true maximum even when it sits in the middle of the run list', () => {
    // The freshest item (1 day old) is neither first nor last; with a 2-day allowance it is fresh,
    // so no stale. Picking the first, the last, or the minimum instead would all read as stale.
    const runs = [
      run({ startedAt: NOW, newestItemPublishedAt: new Date(NOW.getTime() - 5 * DAY_MS) }),
      run({
        startedAt: new Date(NOW.getTime() - DAY_MS),
        newestItemPublishedAt: new Date(NOW.getTime() - 1 * DAY_MS),
      }),
      run({
        startedAt: new Date(NOW.getTime() - 2 * DAY_MS),
        newestItemPublishedAt: new Date(NOW.getTime() - 3 * DAY_MS),
      }),
    ]
    expect(detectStaleFeed(snap(runs, { freshnessMaxAgeMs: 2 * DAY_MS }))).toEqual([])
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

  it('fires on a 404 now even when that run still reported some received (404 OR zero, not AND)', () => {
    const runs = [
      run({ startedAt: NOW, received: 3, lastHttpStatus: 404 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 12 }),
    ]
    expect(detectBoardGone(snap(runs, { isEmployerBoard: true }))).toContain('BOARD_GONE')
  })

  it('reads prior runs (not the latest) for "had some": latest-only history does not count', () => {
    // Latest 404 but with received > 0; every PRIOR run had zero → never had some → no board-gone.
    const runs = [
      run({ startedAt: NOW, received: 5, lastHttpStatus: 404 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 0 }),
    ]
    expect(detectBoardGone(snap(runs, { isEmployerBoard: true }))).toEqual([])
  })

  it('fires when some (not every) prior run had jobs', () => {
    const runs = [
      run({ startedAt: NOW, received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 7 }),
      run({ startedAt: new Date(NOW.getTime() - 2 * DAY_MS), received: 0 }),
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

describe('detector boundaries and guards', () => {
  it('volume drop counts a run from 23h ago toward today (the 24h window), excluding 25h ago', () => {
    // Baseline 100 (past Thursdays). Today: a small run now + a big run 23h ago. Both are inside
    // 24h, so the volume is high and it must NOT fire. If the 24h window shrank, the 23h run would
    // drop out and it would falsely fire.
    const pastThursdays = Array.from({ length: 10 }, (_, i) =>
      run({ startedAt: new Date(NOW.getTime() - (i + 1) * DAY_MS), received: 100 }),
    )
    const today = run({ startedAt: NOW, received: 5 })
    const bigWithin24h = run({
      startedAt: new Date(NOW.getTime() - 23 * 3_600_000),
      received: 1_000,
    })
    expect(detectVolumeDrop(snap([today, bigWithin24h, ...pastThursdays]))).toEqual([])
  })

  it('silence does not fire when the median gap between new items is zero', () => {
    // Two new-item runs at the SAME instant → gap 0 → not a measurable cadence.
    const sameInstant = new Date(NOW.getTime() - 5 * DAY_MS)
    const runs = [
      run({ startedAt: sameInstant, created: 2, received: 40 }),
      run({ startedAt: sameInstant, created: 2, received: 40 }),
    ]
    expect(detectSilence(snap(runs))).toEqual([])
  })

  it('silence fires even when one recent run received nothing (some, not every, must receive)', () => {
    const newItemRuns = [10, 11, 12].map((d) =>
      run({ startedAt: new Date(NOW.getTime() - d * DAY_MS), created: 3, received: 50 }),
    )
    const recent = [
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), created: 0, received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - 2 * DAY_MS), created: 0, received: 40 }),
    ]
    expect(detectSilence(snap([...recent, ...newItemRuns]))).toContain('NO_NEW_ITEMS')
  })

  it('slowdown does not fire when no run has a positive duration', () => {
    const instant = daily(6).map((r) => ({ ...r, endedAt: r.startedAt, bytesRead: 1_000 }))
    expect(detectSlowdownGrowth(snap(instant))).not.toContain('SLOW')
  })

  it('stale fires on the freshest of several old items, not only the latest run', () => {
    // Two runs, both older than the allowance; the newer-of-the-two still breaches it → stale.
    const runs = [
      run({ startedAt: NOW, newestItemPublishedAt: new Date(NOW.getTime() - 5 * DAY_MS) }),
      run({
        startedAt: new Date(NOW.getTime() - DAY_MS),
        newestItemPublishedAt: new Date(NOW.getTime() - 3 * DAY_MS),
      }),
    ]
    expect(detectStaleFeed(snap(runs, { freshnessMaxAgeMs: DAY_MS }))).toContain('STALE_FEED')
  })

  it('format drift does not divide by zero: a zero-received run with invalids does not fire', () => {
    // Without the `received > 0` guard this would be Infinity > 0.1 and fire falsely.
    expect(detectFormatDrift(snap([run({ startedAt: NOW, received: 0, invalid: 5 })]))).toEqual([])
  })

  it('silence is exactly at the 4x boundary: 4x does not fire, just over does', () => {
    // Median gap 1 day; last new item exactly 4 days ago → 4 is not > 4 → no fire.
    const atFourX = [4, 5, 6].map((d) =>
      run({ startedAt: new Date(NOW.getTime() - d * DAY_MS), created: 3, received: 40 }),
    )
    expect(detectSilence(snap(atFourX))).toEqual([])
    const justOver = [4.001, 5, 6].map((d) =>
      run({ startedAt: new Date(NOW.getTime() - d * DAY_MS), created: 3, received: 40 }),
    )
    expect(detectSilence(snap(justOver))).toContain('NO_NEW_ITEMS')
  })

  it('silence fires with exactly two new-item runs spaced far apart', () => {
    const runs = [
      run({ startedAt: new Date(NOW.getTime() - 10 * DAY_MS), created: 2, received: 40 }),
      run({ startedAt: new Date(NOW.getTime() - 12 * DAY_MS), created: 2, received: 40 }),
    ]
    expect(detectSilence(snap(runs))).toContain('NO_NEW_ITEMS')
  })

  it('access change does not throw when no run carried a status', () => {
    expect(detectAccessChange(snap([run({ startedAt: NOW, lastHttpStatus: null })]))).toEqual([])
  })

  it('payload growth needs a byte history: a latest with bytes but no prior byte reading does not fire', () => {
    const noByteHistory = daily(5).map((r) => ({ ...r, bytesRead: null }))
    const latest = run({ startedAt: NOW, bytesRead: 5_000 })
    expect(detectSlowdownGrowth(snap([latest, ...noByteHistory]))).not.toContain('PAYLOAD_GROWTH')
  })

  it('slowdown excludes zero-duration runs from the median (they are not a faster baseline)', () => {
    // One real 1000ms run, several instant runs, latest 2500ms. Against the real baseline (1000)
    // 2500 is not > 3x, so no SLOW. If instant runs counted, the median would collapse and it would fire.
    const instant = daily(6).map((r) => ({ ...r, endedAt: r.startedAt }))
    const real = run({
      startedAt: new Date(NOW.getTime() - 7 * DAY_MS),
      endedAt: new Date(NOW.getTime() - 7 * DAY_MS + 1_000),
    })
    const latest = run({ startedAt: NOW, endedAt: new Date(NOW.getTime() + 2_500) })
    expect(detectSlowdownGrowth(snap([latest, real, ...instant]))).not.toContain('SLOW')
  })

  it('deadline exactly now does not fire (remaining must be strictly positive)', () => {
    expect(detectDeadlineNear(snap([], { policyDeadline: new Date(NOW.getTime()) }))).toEqual([])
  })

  it('empty answer fires on the two most recent empties over a non-empty median', () => {
    const runs = [
      run({ startedAt: NOW, received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 0 }),
      run({ startedAt: new Date(NOW.getTime() - 2 * DAY_MS), received: 80 }),
      run({ startedAt: new Date(NOW.getTime() - 3 * DAY_MS), received: 80 }),
      run({ startedAt: new Date(NOW.getTime() - 4 * DAY_MS), received: 80 }),
    ]
    expect(detectEmptyResponse(snap(runs))).toContain('EMPTY_RESPONSE')
  })
})

describe('CR-M-1: failed runs are not volume, not empty answers, not board-gone', () => {
  it('EMPTY_RESPONSE ignores FAILED runs — only a clean success with received 0 counts', () => {
    // The two most recent runs FAILED with received 0; the successful history is non-empty.
    const runs = [
      run({ startedAt: new Date(NOW.getTime() - 1 * DAY_MS), received: 0, outcome: 'FAILED' }),
      run({ startedAt: new Date(NOW.getTime() - 2 * DAY_MS), received: 0, outcome: 'FAILED' }),
      run({ startedAt: new Date(NOW.getTime() - 3 * DAY_MS), received: 50 }),
      run({ startedAt: new Date(NOW.getTime() - 4 * DAY_MS), received: 50 }),
      run({ startedAt: new Date(NOW.getTime() - 5 * DAY_MS), received: 50 }),
    ]
    expect(detectEmptyResponse(snap(runs))).toEqual([])
  })

  it('EMPTY_RESPONSE still fires on two clean successes with received 0', () => {
    const runs = [
      run({ startedAt: new Date(NOW.getTime() - 1 * DAY_MS), received: 0, outcome: 'SUCCEEDED' }),
      run({ startedAt: new Date(NOW.getTime() - 2 * DAY_MS), received: 0, outcome: 'SUCCEEDED' }),
      run({ startedAt: new Date(NOW.getTime() - 3 * DAY_MS), received: 50 }),
      run({ startedAt: new Date(NOW.getTime() - 4 * DAY_MS), received: 50 }),
    ]
    expect(detectEmptyResponse(snap(runs))).toContain('EMPTY_RESPONSE')
  })

  it('BOARD_GONE does not fire on a FAILED latest run (a transient error is not a board going quiet)', () => {
    const runs = [
      run({ startedAt: NOW, received: 0, outcome: 'FAILED' }),
      run({ startedAt: new Date(NOW.getTime() - DAY_MS), received: 12 }),
    ]
    expect(detectBoardGone(snap(runs, { isEmployerBoard: true }))).toEqual([])
  })

  it('the volume baseline excludes failed runs rather than letting their zeros deflate it', () => {
    // Seven same-weekday successes (100) and seven same-weekday failed-only days (received 0).
    // With failures excluded the baseline is 100, so today's 25 is a drop; if the zeros counted the
    // baseline would be ~50 and 25 would not read as a drop.
    const history: ReturnType<typeof run>[] = []
    for (let w = 1; w <= 7; w++) {
      history.push(run({ startedAt: new Date(NOW.getTime() - w * 7 * DAY_MS), received: 100 }))
    }
    for (let w = 8; w <= 14; w++) {
      // Further-back Thursdays (same weekday as NOW) whose only run FAILED with received 0.
      history.push(
        run({
          startedAt: new Date(NOW.getTime() - w * 7 * DAY_MS),
          received: 0,
          outcome: 'FAILED',
        }),
      )
    }
    const today = run({ startedAt: NOW, received: 25 })
    expect(detectVolumeDrop(snap([today, ...history]))).toContain('VOLUME_DROP')
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
