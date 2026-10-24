import { describe, expect, it } from 'vitest'
import { RANK_DEFAULTS, compareRanked, rankScore, scopedMatchCount, type RankInput } from './rank'

const DAY = 86_400_000
const NOW = new Date('2026-10-20T12:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY)

/** A fully-known posting published `ageDays` ago with `matchCount` scoped matches. */
function input(over: Partial<RankInput> & { ageDays?: number } = {}): RankInput {
  const { ageDays = 0, ...rest } = over
  return {
    evaluationTime: NOW,
    trustedPublishedAt: daysAgo(ageDays),
    firstSeenAt: daysAgo(ageDays),
    firstSeenKind: 'NORMAL',
    matchCount: 0,
    unknownSeniority: false,
    unknownStack: false,
    unknownRemote: false,
    ...rest,
  }
}

// Every expected value below was computed by hand from the plan formula
//   score = clamp(round(100*e^(-age/7) + 10*min(matches,10) - penalties), 0, 1000)
// with e^-1 = 0.367879, e^-2 = 0.135335, e^(-1/7) = 0.866878, e^(-3.5) = 0.030197.
describe('rankScore: hand-computed examples', () => {
  it('uses the plan defaults', () => {
    expect(RANK_DEFAULTS).toEqual({
      freshnessWeight: 100,
      decayDays: 7,
      matchWeight: 10,
      matchCap: 10,
      penalties: { unknownSeniority: 15, unknownStack: 20, unknownRemote: 10 },
      platformWeight: 1,
    })
  })

  it('brand new, no matches = 100', () => {
    expect(rankScore(input()).score).toBe(100)
  })

  it('7 days old = round(36.79) = 37', () => {
    expect(rankScore(input({ ageDays: 7 })).score).toBe(37)
  })

  it('14 days old = round(13.53) = 14', () => {
    expect(rankScore(input({ ageDays: 14 })).score).toBe(14)
  })

  it('1 day old = round(86.69) = 87', () => {
    expect(rankScore(input({ ageDays: 1 })).score).toBe(87)
  })

  it('3.5 days old with 3 matches = round(60.65 + 30) = 91', () => {
    // 100 * e^(-0.5) = 60.653
    expect(rankScore(input({ ageDays: 3.5, matchCount: 3 })).score).toBe(91)
  })

  it('7 days old, 4 matches, unknown stack = round(36.79 + 40 - 20) = 57', () => {
    expect(rankScore(input({ ageDays: 7, matchCount: 4, unknownStack: true })).score).toBe(57)
  })

  it('all three penalties on a fresh posting = 100 - 45 = 55', () => {
    const s = rankScore(
      input({ unknownSeniority: true, unknownStack: true, unknownRemote: true }),
    ).score
    expect(s).toBe(55)
  })

  it('each penalty alone subtracts exactly its own weight', () => {
    expect(rankScore(input({ unknownSeniority: true })).score).toBe(85)
    expect(rankScore(input({ unknownStack: true })).score).toBe(80)
    expect(rankScore(input({ unknownRemote: true })).score).toBe(90)
  })
})

describe('rankScore: cap, rounding, clamp, monotonicity', () => {
  it('the match term caps at 10 matches: 10 and 25 matches both give 200', () => {
    expect(rankScore(input({ matchCount: 10 })).score).toBe(200)
    expect(rankScore(input({ matchCount: 11 })).score).toBe(200)
    expect(rankScore(input({ matchCount: 25 })).score).toBe(200)
    expect(rankScore(input({ matchCount: 9 })).score).toBe(190)
  })

  it('rounds half up at .5 and down below it', () => {
    // freshness 0 (initial sweep) isolates a custom config's fractional result
    const cfg = { ...RANK_DEFAULTS, matchWeight: 0.5 }
    const sweep = (n: number) =>
      rankScore(
        input({ firstSeenKind: 'INITIAL_SWEEP', trustedPublishedAt: null, matchCount: n }),
        cfg,
      ).score
    expect(sweep(1)).toBe(1) // 0.5 -> 1
    expect(sweep(2)).toBe(1) // 1.0
    expect(sweep(3)).toBe(2) // 1.5 -> 2
  })

  it('clamps at 0: heavy penalties on an old posting never go negative (and never -0)', () => {
    const r = rankScore(
      input({ ageDays: 60, unknownSeniority: true, unknownStack: true, unknownRemote: true }),
    )
    expect(r.score).toBe(0)
    expect(Object.is(r.score, 0)).toBe(true)
  })

  it('clamps at 1000 for an inflated custom config', () => {
    const cfg = { ...RANK_DEFAULTS, freshnessWeight: 5000 }
    expect(rankScore(input(), cfg).score).toBe(1000)
  })

  it('is monotonic: older never scores higher, more matches never score lower', () => {
    let prev = Infinity
    for (let d = 0; d <= 40; d += 0.5) {
      const s = rankScore(input({ ageDays: d, matchCount: 2 })).score
      expect(s).toBeLessThanOrEqual(prev)
      prev = s
    }
    let prevM = -1
    for (let m = 0; m <= 14; m++) {
      const s = rankScore(input({ ageDays: 5, matchCount: m })).score
      expect(s).toBeGreaterThanOrEqual(prevM)
      prevM = s
    }
  })

  it('ignores negative, fractional and non-finite match counts safely', () => {
    expect(rankScore(input({ matchCount: -3 })).score).toBe(100)
    expect(rankScore(input({ matchCount: Number.NaN })).score).toBe(100)
    expect(rankScore(input({ matchCount: 2.9 })).score).toBe(120)
  })

  it('platform weight scales the positive terms only; weight 1 is the identity', () => {
    const cfg = { ...RANK_DEFAULTS, platformWeight: 0.5 }
    // (100 + 20) * 0.5 - 15 = 45
    expect(rankScore(input({ matchCount: 2, unknownSeniority: true }), cfg).score).toBe(45)
    expect(rankScore(input({ matchCount: 2, unknownSeniority: true })).score).toBe(105)
  })

  it('eligibility gates are not penalties: an eligibility field on the input changes nothing', () => {
    const plain = input({ matchCount: 3, ageDays: 2 })
    for (const extra of [
      { eligibility: 'EXCLUDED' },
      { eligibility: 'GATED', gate: 'REGION' },
      { restricted: true, excluded: true },
    ]) {
      expect(rankScore({ ...plain, ...extra } as RankInput)).toEqual(rankScore(plain))
    }
  })

  it('the penalty table is exactly the three unknowns', () => {
    expect(Object.keys(RANK_DEFAULTS.penalties).sort()).toEqual([
      'unknownRemote',
      'unknownSeniority',
      'unknownStack',
    ])
  })
})

describe('rankScore: dates', () => {
  it('uses the trusted published date when present', () => {
    const r = rankScore(input({ trustedPublishedAt: daysAgo(7), firstSeenAt: daysAgo(0) }))
    expect(r.score).toBe(37)
    expect(r.warnings).toEqual([])
  })

  it('falls back to first-seen when there is no trusted date, without a warning', () => {
    const r = rankScore(input({ trustedPublishedAt: null, firstSeenAt: daysAgo(7) }))
    expect(r.score).toBe(37)
    expect(r.warnings).toEqual([])
  })

  it('a future published date uses first-seen and warns', () => {
    const r = rankScore(
      input({ trustedPublishedAt: new Date(NOW.getTime() + 3 * DAY), firstSeenAt: daysAgo(7) }),
    )
    expect(r.score).toBe(37)
    expect(r.warnings).toEqual(['FUTURE_DATE'])
  })

  it('a published date equal to evaluation time is not "future"', () => {
    const r = rankScore(input({ trustedPublishedAt: NOW, firstSeenAt: daysAgo(7) }))
    expect(r.score).toBe(100)
    expect(r.warnings).toEqual([])
  })

  it('1 ms in the future IS future', () => {
    const r = rankScore(
      input({ trustedPublishedAt: new Date(NOW.getTime() + 1), firstSeenAt: daysAgo(7) }),
    )
    expect(r.warnings).toEqual(['FUTURE_DATE'])
    expect(r.score).toBe(37)
  })

  it('an invalid published date is treated as absent', () => {
    const r = rankScore(input({ trustedPublishedAt: new Date('nope'), firstSeenAt: daysAgo(7) }))
    expect(r.score).toBe(37)
  })

  it('a first-seen date after evaluation time clamps age to 0', () => {
    const r = rankScore(
      input({ trustedPublishedAt: null, firstSeenAt: new Date(NOW.getTime() + 2 * DAY) }),
    )
    expect(r.score).toBe(100)
  })

  it('an update date is not an input: the score ignores any updatedAt', () => {
    const plain = input({ ageDays: 7 })
    const later = new Date(NOW.getTime() - 1000)
    const earlier = new Date(NOW.getTime() - 60 * DAY)
    expect(rankScore({ ...plain, updatedAt: later } as RankInput)).toEqual(rankScore(plain))
    expect(rankScore({ ...plain, updatedAt: earlier } as RankInput)).toEqual(rankScore(plain))
  })

  it('INITIAL_SWEEP with no trusted date: freshness 0 and an unknown-date warning', () => {
    const r = rankScore(
      input({ firstSeenKind: 'INITIAL_SWEEP', trustedPublishedAt: null, matchCount: 3 }),
    )
    expect(r.score).toBe(30)
    expect(r.warnings).toEqual(['UNKNOWN_DATE'])
  })

  it('INITIAL_SWEEP still trusts a real published date', () => {
    const r = rankScore(input({ firstSeenKind: 'INITIAL_SWEEP', ageDays: 7 }))
    expect(r.score).toBe(37)
    expect(r.warnings).toEqual([])
  })

  it('INITIAL_SWEEP with a future published date: freshness 0 and both warnings', () => {
    const r = rankScore(
      input({
        firstSeenKind: 'INITIAL_SWEEP',
        trustedPublishedAt: new Date(NOW.getTime() + DAY),
      }),
    )
    expect(r.score).toBe(0)
    expect(r.warnings).toEqual(['FUTURE_DATE', 'UNKNOWN_DATE'])
  })
})

describe('rankScore: invalid dates never produce NaN (CR-M-1)', () => {
  const bad = new Date('nope')
  it('invalid evaluation time: freshness 0, unknown-date warning, matches still count', () => {
    const r = rankScore(input({ evaluationTime: bad, matchCount: 3 }))
    expect(r).toEqual({ score: 30, warnings: ['UNKNOWN_DATE'] })
  })
  it('invalid evaluation time with a published date: still no NaN, no FUTURE_DATE', () => {
    const r = rankScore(input({ evaluationTime: bad, trustedPublishedAt: daysAgo(1) }))
    expect(r).toEqual({ score: 0, warnings: ['UNKNOWN_DATE'] })
  })
  it('invalid first-seen without a published date: freshness 0 and a warning', () => {
    const r = rankScore(input({ trustedPublishedAt: null, firstSeenAt: bad, matchCount: 2 }))
    expect(r).toEqual({ score: 20, warnings: ['UNKNOWN_DATE'] })
  })
  it('invalid first-seen is harmless when the published date is usable', () => {
    const r = rankScore(input({ firstSeenAt: bad, ageDays: 7 }))
    expect(r).toEqual({ score: 37, warnings: [] })
  })
  it('the score is always a finite integer in [0, 1000]', () => {
    for (const evaluationTime of [NOW, bad]) {
      for (const firstSeenAt of [daysAgo(3), bad]) {
        for (const trustedPublishedAt of [null, daysAgo(2), bad]) {
          const s = rankScore(
            input({ evaluationTime, firstSeenAt, trustedPublishedAt, matchCount: 4 }),
          ).score
          expect(Number.isInteger(s) && s >= 0 && s <= 1000).toBe(true)
        }
      }
    }
  })
  it('compareRanked stays a total order with invalid dates (they sort as oldest)', () => {
    const row = (seen: Date, id: string) => ({ score: 5, firstSeenAt: seen, opportunityId: id })
    const rows = [row(bad, 'b'), row(new Date('2026-10-01T00:00:00Z'), 'a'), row(bad, 'a')]
    const sorted = [...rows]
      .sort(compareRanked)
      .map((r) => `${Number.isNaN(r.firstSeenAt.getTime()) ? 'bad' : 'ok'}${r.opportunityId}`)
    expect(sorted).toEqual(['oka', 'badb', 'bada'])
    expect(compareRanked(row(bad, 'a'), row(bad, 'a'))).toBe(0)
    expect(Number.isNaN(compareRanked(row(bad, 'a'), row(new Date(0), 'a')))).toBe(false)
  })
})

describe('scopedMatchCount', () => {
  const counts = { authorizedTeam: 3, studio: 8 }
  it('HR uses the authorized team count', () => {
    expect(scopedMatchCount('HR', counts)).toBe(3)
  })
  it('ADMIN uses the studio count', () => {
    expect(scopedMatchCount('ADMIN', counts)).toBe(8)
  })
  it('any other role fails closed to 0, whatever the counts', () => {
    for (const role of ['SENIOR', 'JUNIOR', 'ACCOUNTANT', '', 'hr', 'admin']) {
      expect(scopedMatchCount(role, counts), role).toBe(0)
    }
  })
  it('feeds the score: same posting ranks differently per scope', () => {
    const hr = rankScore(input({ matchCount: scopedMatchCount('HR', counts) })).score
    const admin = rankScore(input({ matchCount: scopedMatchCount('ADMIN', counts) })).score
    expect([hr, admin]).toEqual([130, 180])
  })
})

describe('compareRanked: (score, firstSeenAt, opportunityId) descending', () => {
  const row = (score: number, seen: string, id: string) => ({
    score,
    firstSeenAt: new Date(seen),
    opportunityId: id,
  })
  it('orders by score, then first-seen, then id, all descending', () => {
    const rows = [
      row(50, '2026-10-01T00:00:00Z', 'a'),
      row(90, '2026-10-01T00:00:00Z', 'a'),
      row(50, '2026-10-02T00:00:00Z', 'a'),
      row(50, '2026-10-02T00:00:00Z', 'b'),
    ]
    const sorted = [...rows]
      .sort(compareRanked)
      .map((r) => `${r.score}${r.firstSeenAt.getUTCDate()}${r.opportunityId}`)
    expect(sorted).toEqual(['901a', '502b', '502a', '501a'])
  })
  it('is 0 only for identical keys', () => {
    expect(
      compareRanked(row(1, '2026-10-01T00:00:00Z', 'a'), row(1, '2026-10-01T00:00:00Z', 'a')),
    ).toBe(0)
  })

  it('breaks a full tie by id, descending, in both argument orders', () => {
    const lo = row(1, '2026-10-01T00:00:00Z', 'a')
    const hi = row(1, '2026-10-01T00:00:00Z', 'b')
    expect(compareRanked(lo, hi)).toBe(1)
    expect(compareRanked(hi, lo)).toBe(-1)
  })
})
