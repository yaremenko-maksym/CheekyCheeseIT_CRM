import { describe, expect, it } from 'vitest'
import {
  budgetWindowEnd,
  budgetWindowStart,
  isCredibleBudgetLimit,
  resolveBudget,
  spendBudget,
  type SourceBudgetState,
} from './source-budget'

/**
 * task-vacancy-matching §4 — "Бюджет источника — механикой, а не намерением".
 *
 * The hostile-input block is the one that matters most. The rule it enforces —
 * "a corrupt limit must TIGHTEN the restriction, never release it" — was learned
 * the expensive way: a limit parameter that answered `NaN` or `1e21` removed the
 * cap entirely, and the TYPE did not object, because `number` contains both.
 * Every one of those values is asserted here individually rather than as a
 * lumped "invalid input" case, so a regression names the value that broke.
 */

const JULY = new Date('2026-07-15T12:00:00.000Z')

const state = (over: Partial<SourceBudgetState> = {}): SourceBudgetState => ({
  limit: 200,
  window: 'MONTH',
  used: 0,
  windowStartedAt: new Date('2026-07-01T00:00:00.000Z'),
  ...over,
})

describe('resolveBudget — a source with no published limit', () => {
  it('is unlimited when the limit is explicitly null (DOU)', () => {
    const budget = resolveBudget(
      { limit: null, window: null, used: 0, windowStartedAt: null },
      JULY,
    )
    expect(budget.limited).toBe(false)
    expect(budget.remaining).toBeNull()
    expect(budget.exhausted).toBe(false)
  })

  it('never reports a reset time it cannot honour', () => {
    const budget = resolveBudget(
      { limit: null, window: null, used: 0, windowStartedAt: null },
      JULY,
    )
    expect(budget.resetsAt).toBeNull()
  })
})

describe('resolveBudget — normal accounting', () => {
  it('reports what is left inside the current window', () => {
    const budget = resolveBudget(state({ used: 47 }), JULY)
    expect(budget.limit).toBe(200)
    expect(budget.used).toBe(47)
    expect(budget.remaining).toBe(153)
    expect(budget.exhausted).toBe(false)
  })

  it('is exhausted the moment the spend reaches the limit', () => {
    expect(resolveBudget(state({ used: 199 }), JULY).exhausted).toBe(false)
    expect(resolveBudget(state({ used: 200 }), JULY).exhausted).toBe(true)
  })

  it('reports the reset instant so the UI can name a date', () => {
    const budget = resolveBudget(state({ used: 200 }), JULY)
    expect(budget.resetsAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('forgets the spend once the window has rolled over', () => {
    // Counter belongs to June; "now" is July — July starts clean.
    const budget = resolveBudget(
      state({ used: 200, windowStartedAt: new Date('2026-06-01T00:00:00.000Z') }),
      JULY,
    )
    expect(budget.used).toBe(0)
    expect(budget.remaining).toBe(200)
    expect(budget.exhausted).toBe(false)
  })

  it('keeps a DAY budget separate from the day before', () => {
    const yesterday = new Date('2026-07-14T23:00:00.000Z')
    const budget = resolveBudget(
      { limit: 250, window: 'DAY', used: 250, windowStartedAt: yesterday },
      JULY,
    )
    expect(budget.exhausted).toBe(false)
    expect(budget.resetsAt?.toISOString()).toBe('2026-07-16T00:00:00.000Z')
  })

  it('does not roll over early inside the same day', () => {
    const budget = resolveBudget(
      {
        limit: 250,
        window: 'DAY',
        used: 250,
        windowStartedAt: new Date('2026-07-15T00:00:00.000Z'),
      },
      JULY,
    )
    expect(budget.exhausted).toBe(true)
  })
})

/**
 * The core of §4. Each case asserts the STRICTER outcome, and each is its own
 * test so a failure names the exact value that stopped being handled.
 */
describe('resolveBudget — corrupt input tightens, never releases', () => {
  const corruptCases: [name: string, limit: number][] = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['1e21 (beyond credible, arithmetic breaks down)', 1e21],
    ['negative', -5],
    ['zero', 0],
    ['fractional', 12.5],
  ]

  for (const [name, limit] of corruptCases) {
    it(`limit ${name} → refuses everything (0 remaining), never "unlimited"`, () => {
      const budget = resolveBudget(state({ limit }), JULY)
      expect(budget.limited).toBe(true)
      expect(budget.remaining).toBe(0)
      expect(budget.exhausted).toBe(true)
    })
  }

  it('a corrupt USED counter counts as fully spent', () => {
    expect(resolveBudget(state({ used: Number.NaN }), JULY).exhausted).toBe(true)
    expect(resolveBudget(state({ used: -1 }), JULY).exhausted).toBe(true)
    expect(resolveBudget(state({ used: Number.POSITIVE_INFINITY }), JULY).exhausted).toBe(true)
  })

  it('a used counter above the limit cannot report negative remaining', () => {
    const budget = resolveBudget(state({ used: 5_000 }), JULY)
    expect(budget.remaining).toBe(0)
    expect(budget.exhausted).toBe(true)
  })

  it('a limit with no window is misconfigured, so it refuses', () => {
    const budget = resolveBudget(state({ window: null }), JULY)
    expect(budget.exhausted).toBe(true)
    expect(budget.remaining).toBe(0)
  })

  it('an Invalid Date window start is treated as a rollover, not a crash', () => {
    const budget = resolveBudget(state({ used: 10, windowStartedAt: new Date('nonsense') }), JULY)
    expect(budget.used).toBe(0)
    expect(budget.remaining).toBe(200)
  })

  it('a window start in the FUTURE keeps the counter (the stricter reading)', () => {
    // Clock skew or a hand-edited row must not become a way to zero the meter.
    const budget = resolveBudget(
      state({ used: 200, windowStartedAt: new Date('2026-09-01T00:00:00.000Z') }),
      JULY,
    )
    expect(budget.exhausted).toBe(true)
  })
})

describe('isCredibleBudgetLimit', () => {
  it('accepts a plausible published cap', () => {
    expect(isCredibleBudgetLimit(200)).toBe(true)
    expect(isCredibleBudgetLimit(250)).toBe(true)
    expect(isCredibleBudgetLimit(500)).toBe(true)
  })

  it('rejects every non-arithmetic number', () => {
    expect(isCredibleBudgetLimit(Number.NaN)).toBe(false)
    expect(isCredibleBudgetLimit(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isCredibleBudgetLimit(1e21)).toBe(false)
    expect(isCredibleBudgetLimit(-1)).toBe(false)
    expect(isCredibleBudgetLimit(0)).toBe(false)
    expect(isCredibleBudgetLimit(1.5)).toBe(false)
  })

  it('rejects values that are not numbers at all', () => {
    expect(isCredibleBudgetLimit('200')).toBe(false)
    expect(isCredibleBudgetLimit(null)).toBe(false)
    expect(isCredibleBudgetLimit(undefined)).toBe(false)
  })
})

describe('budget windows are calendar-anchored in UTC', () => {
  it('DAY starts at midnight and ends at the next midnight', () => {
    expect(budgetWindowStart(JULY, 'DAY').toISOString()).toBe('2026-07-15T00:00:00.000Z')
    expect(budgetWindowEnd(JULY, 'DAY').toISOString()).toBe('2026-07-16T00:00:00.000Z')
  })

  it('MONTH starts on the 1st and ends on the next 1st', () => {
    expect(budgetWindowStart(JULY, 'MONTH').toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(budgetWindowEnd(JULY, 'MONTH').toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('rolls the year over in December', () => {
    const december = new Date('2026-12-20T10:00:00.000Z')
    expect(budgetWindowEnd(december, 'MONTH').toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('spendBudget — what gets written back after one request', () => {
  it('increments the counter inside the current window', () => {
    expect(spendBudget(state({ used: 47 }), JULY)).toEqual({
      used: 48,
      windowStartedAt: new Date('2026-07-01T00:00:00.000Z'),
    })
  })

  it('starts a fresh window at 1 after a rollover', () => {
    const spent = spendBudget(
      state({ used: 200, windowStartedAt: new Date('2026-06-01T00:00:00.000Z') }),
      JULY,
    )
    expect(spent).toEqual({ used: 1, windowStartedAt: new Date('2026-07-01T00:00:00.000Z') })
  })

  it('writes nothing for an unlimited source', () => {
    expect(
      spendBudget({ limit: null, window: null, used: 0, windowStartedAt: null }, JULY),
    ).toBeNull()
  })

  it('cannot inflate the counter past the limit', () => {
    expect(spendBudget(state({ used: 200 }), JULY)?.used).toBe(200)
  })
})
