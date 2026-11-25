import { describe, expect, it } from 'vitest'
import {
  RANK_DEFAULTS,
  RELEVANCE_NEUTRAL_FIT,
  compareRanked,
  rankScore,
  type RankInput,
} from './rank'

const DAY = 86_400_000
const NOW = new Date('2026-10-20T12:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY)

/** A fully-known posting published `ageDays` ago; `fit` defaults to 0 so date cases read alone. */
function input(over: Partial<RankInput> & { ageDays?: number } = {}): RankInput {
  const { ageDays = 0, ...rest } = over
  return {
    evaluationTime: NOW,
    trustedPublishedAt: daysAgo(ageDays),
    firstSeenAt: daysAgo(ageDays),
    firstSeenKind: 'NORMAL',
    fit: 0,
    unknownSeniority: false,
    unknownStack: false,
    unknownRemote: false,
    ...rest,
  }
}

// Every expected value below was computed by hand from the plan formula
//   score = clamp(round((100*e^(-age/7) + 300*fit) * platformWeight - penalties), 0, 1000)
// with e^-1 = 0.367879, e^-2 = 0.135335, e^(-1/7) = 0.866878, e^(-3.5) = 0.030197.
describe('rankScore: hand-computed examples', () => {
  it('uses the plan defaults', () => {
    expect(RANK_DEFAULTS).toEqual({
      freshnessWeight: 100,
      decayDays: 7,
      relevanceWeight: 300,
      penalties: { unknownSeniority: 15, unknownStack: 20, unknownRemote: 10 },
      platformWeight: 1,
    })
  })

  it('the neutral fit is 0.5', () => {
    expect(RELEVANCE_NEUTRAL_FIT).toBe(0.5)
  })

  it('brand new, fit 0 = 100', () => {
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

  it('3.5 days old with fit 0.1 = round(60.65 + 30) = 91', () => {
    // 100 * e^(-0.5) = 60.653
    expect(rankScore(input({ ageDays: 3.5, fit: 0.1 })).score).toBe(91)
  })

  it('7 days old, fit 0.2, unknown stack = round(36.79 + 60 - 20) = 77', () => {
    expect(rankScore(input({ ageDays: 7, fit: 0.2, unknownStack: true })).score).toBe(77)
  })

  it('fresh, fit 1 = 400', () => {
    expect(rankScore(input({ fit: 1 })).score).toBe(400)
  })

  it('fresh, fit null = neutral = 100 + 150 = 250', () => {
    expect(rankScore(input({ fit: null })).score).toBe(250)
  })

  it('7 days old, fit 0.8 = round(36.79 + 240) = 277', () => {
    expect(rankScore(input({ ageDays: 7, fit: 0.8 })).score).toBe(277)
  })

  it('strong old beats weak fresh: 30 days fit 1 (301) > fresh fit 0.25 (175)', () => {
    // 100 * e^(-30/7) = 1.376
    const strongOld = rankScore(input({ ageDays: 30, fit: 1 })).score
    const weakFresh = rankScore(input({ fit: 0.25 })).score
    expect([strongOld, weakFresh]).toEqual([301, 175])
  })

  it('equal fit: the fresher posting wins', () => {
    const fresh = rankScore(input({ ageDays: 1, fit: 0.6 })).score
    const older = rankScore(input({ ageDays: 4, fit: 0.6 })).score
    expect([fresh, older]).toEqual([267, 236])
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
  it('the fit clamps to [0, 1]: 1.5 gives 400, -0.2 gives 100', () => {
    expect(rankScore(input({ fit: 1.5 })).score).toBe(400)
    expect(rankScore(input({ fit: -0.2 })).score).toBe(100)
    expect(rankScore(input({ fit: 0.99 })).score).toBe(397)
    expect(rankScore(input({ fit: 0.01 })).score).toBe(103)
  })

  it('a non-finite fit ranks at neutral 250, never NaN', () => {
    for (const fit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(rankScore(input({ fit })).score, String(fit)).toBe(250)
    }
  })

  it('rounds half up at .5 and down below it', () => {
    // freshness 0 (initial sweep) isolates a custom config's fractional result
    const cfg = { ...RANK_DEFAULTS, relevanceWeight: 3 }
    const sweep = (fit: number) =>
      rankScore(input({ firstSeenKind: 'INITIAL_SWEEP', trustedPublishedAt: null, fit }), cfg).score
    expect(sweep(0.125)).toBe(0) // 0.375 -> 0
    expect(sweep(0.25)).toBe(1) // 0.75 -> 1
    expect(sweep(0.5)).toBe(2) // 1.5 -> 2
    expect(sweep(1)).toBe(3) // 3.0
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

  it('is monotonic: older never scores higher, a higher fit never scores lower', () => {
    let prev = Infinity
    for (let d = 0; d <= 40; d += 0.5) {
      const s = rankScore(input({ ageDays: d, fit: 0.2 })).score
      expect(s).toBeLessThanOrEqual(prev)
      prev = s
    }
    let prevF = -1
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const s = rankScore(input({ ageDays: 5, fit: f })).score
      expect(s).toBeGreaterThan(prevF)
      prevF = s
    }
  })

  it('platform weight scales freshness and relevance, not penalties; weight 1 is the identity', () => {
    const cfg = { ...RANK_DEFAULTS, platformWeight: 0.5 }
    // (100 + 60) * 0.5 - 15 = 65
    expect(rankScore(input({ fit: 0.2, unknownSeniority: true }), cfg).score).toBe(65)
    expect(rankScore(input({ fit: 0.2, unknownSeniority: true })).score).toBe(145)
  })

  it('eligibility gates are not penalties: an eligibility field on the input changes nothing', () => {
    const plain = input({ fit: 0.3, ageDays: 2 })
    for (const extra of [
      { eligibility: 'EXCLUDED' },
      { eligibility: 'GATED', gate: 'REGION' },
      { restricted: true, excluded: true },
    ]) {
      expect(rankScore({ ...plain, ...extra } as RankInput)).toEqual(rankScore(plain))
    }
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
      input({ firstSeenKind: 'INITIAL_SWEEP', trustedPublishedAt: null, fit: 0.1 }),
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
  it('invalid evaluation time: freshness 0, unknown-date warning, the fit still counts', () => {
    const r = rankScore(input({ evaluationTime: bad, fit: 0.1 }))
    expect(r).toEqual({ score: 30, warnings: ['UNKNOWN_DATE'] })
  })
  it('invalid evaluation time with a published date: still no NaN, no FUTURE_DATE', () => {
    const r = rankScore(input({ evaluationTime: bad, trustedPublishedAt: daysAgo(1) }))
    expect(r).toEqual({ score: 0, warnings: ['UNKNOWN_DATE'] })
  })
  it('invalid first-seen without a published date: freshness 0 and a warning', () => {
    const r = rankScore(input({ trustedPublishedAt: null, firstSeenAt: bad, fit: 0.2 }))
    expect(r).toEqual({ score: 60, warnings: ['UNKNOWN_DATE'] })
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
            input({ evaluationTime, firstSeenAt, trustedPublishedAt, fit: 0.4 }),
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
