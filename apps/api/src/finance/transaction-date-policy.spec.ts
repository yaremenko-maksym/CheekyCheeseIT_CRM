import { HttpException, HttpStatus } from '@nestjs/common'
import { kyivToday } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { BACKDATE_LIMIT_DAYS, resolveTransactionDateWithPolicy } from './transaction-date-policy'

/**
 * SR-809-H-1 = CR-809-M-3 — the ONE server-side policy for an operator-chosen
 * business date. Before this, `transactionBusinessDateSchema` asked only "is
 * this a real calendar day", so every writer accepted any date: a SENIOR could
 * backdate an income into an already-reported month, or forward-date the PAYOUT
 * row whose date is printed on the invoice — a legal document.
 *
 * Owner decision D-2 (2026-10-22), implemented here verbatim:
 *   - future dates only for PENDING/planned rows;
 *   - SENIOR/DROP may backdate at most 31 days;
 *   - ADMIN/ACCOUNTANT may go beyond 31 days only with a mandatory reason,
 *     which is written to the audit log.
 *
 * The policy lives server-side rather than in the shared Zod schema because it
 * depends on the caller's role and on the flow, and a schema can see neither.
 */

// The policy's business-day reference is `kyivToday()` — the same clock the date
// pickers and the NBU rate day already use. Deriving the fixtures from it (plain
// calendar arithmetic on a YYYY-MM-DD string) keeps them correct whenever the
// suite happens to run, instead of pinning a date that goes stale.
const dayOffset = (days: number) =>
  new Date(Date.parse(`${kyivToday()}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const EXECUTED = { flow: 'EXECUTED' } as const
const PLANNED = { flow: 'PLANNED' } as const

function thrownFrom(act: () => unknown): HttpException {
  try {
    act()
  } catch (err) {
    return err as HttpException
  }
  throw new Error('expected the policy to reject, but it returned normally')
}

describe('resolveTransactionDateWithPolicy — the backdating window', () => {
  it('is 31 days, per owner decision D-2', () => {
    expect(BACKDATE_LIMIT_DAYS).toBe(31)
  })

  it('an omitted date keeps the real current instant for every role, with no reason needed', () => {
    const now = new Date('2026-10-05T18:12:34.567Z')
    for (const role of ['ADMIN', 'ACCOUNTANT', 'SENIOR', 'DROP', 'JUNIOR', 'HR'] as const) {
      const result = resolveTransactionDateWithPolicy(undefined, { role, ...EXECUTED, now })
      expect(result.txDate).toBe(now)
      expect(result.backdateReason).toBeNull()
    }
  })

  it('accepts a date inside the window for a self-service role', () => {
    const result = resolveTransactionDateWithPolicy(dayOffset(-BACKDATE_LIMIT_DAYS + 1), {
      role: 'SENIOR',
      ...EXECUTED,
    })
    expect(result.backdateReason).toBeNull()
  })

  it('accepts the oldest day in the window — the boundary is inclusive', () => {
    expect(() =>
      resolveTransactionDateWithPolicy(dayOffset(-BACKDATE_LIMIT_DAYS), {
        role: 'SENIOR',
        ...EXECUTED,
      }),
    ).not.toThrow()
  })

  it('refuses the first day beyond the window for SENIOR', () => {
    const err = thrownFrom(() =>
      resolveTransactionDateWithPolicy(dayOffset(-BACKDATE_LIMIT_DAYS - 1), {
        role: 'SENIOR',
        ...EXECUTED,
      }),
    )
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST)
    expect((err.getResponse() as { code: string }).code).toBe('FINANCE_TX_DATE_TOO_OLD')
  })

  it('refuses it for every non-privileged role, and a reason does NOT buy them the exemption', () => {
    for (const role of ['SENIOR', 'DROP', 'JUNIOR', 'HR'] as const) {
      const err = thrownFrom(() =>
        resolveTransactionDateWithPolicy(dayOffset(-90), {
          role,
          ...EXECUTED,
          backdateReason: 'late paperwork',
        }),
      )
      expect((err.getResponse() as { code: string }).code).toBe('FINANCE_TX_DATE_TOO_OLD')
    }
  })
})

describe('resolveTransactionDateWithPolicy — the privileged backdate exemption', () => {
  it('ADMIN and ACCOUNTANT may go beyond the window WITH a reason, which is returned for the audit log', () => {
    for (const role of ['ADMIN', 'ACCOUNTANT'] as const) {
      const result = resolveTransactionDateWithPolicy(dayOffset(-120), {
        role,
        ...EXECUTED,
        backdateReason: 'Q2 reconciliation, invoice received late',
      })
      expect(result.backdateReason).toBe('Q2 reconciliation, invoice received late')
    }
  })

  it('refuses ADMIN and ACCOUNTANT beyond the window when no reason is given', () => {
    for (const role of ['ADMIN', 'ACCOUNTANT'] as const) {
      const err = thrownFrom(() =>
        resolveTransactionDateWithPolicy(dayOffset(-120), { role, ...EXECUTED }),
      )
      expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST)
      expect((err.getResponse() as { code: string }).code).toBe(
        'FINANCE_TX_DATE_BACKDATE_REASON_REQUIRED',
      )
    }
  })

  it('a blank or whitespace-only reason is not a reason', () => {
    for (const blank of ['', '   ', '\t\n']) {
      const err = thrownFrom(() =>
        resolveTransactionDateWithPolicy(dayOffset(-120), {
          role: 'ADMIN',
          ...EXECUTED,
          backdateReason: blank,
        }),
      )
      expect((err.getResponse() as { code: string }).code).toBe(
        'FINANCE_TX_DATE_BACKDATE_REASON_REQUIRED',
      )
    }
  })

  it('the returned reason is trimmed, so the audit log never stores padding as content', () => {
    const result = resolveTransactionDateWithPolicy(dayOffset(-120), {
      role: 'ADMIN',
      ...EXECUTED,
      backdateReason: '   signed contract arrived late   ',
    })
    expect(result.backdateReason).toBe('signed contract arrived late')
  })

  it('a reason supplied for a date INSIDE the window is not recorded — there was no exemption to justify', () => {
    const result = resolveTransactionDateWithPolicy(dayOffset(-1), {
      role: 'ADMIN',
      ...EXECUTED,
      backdateReason: 'not needed here',
    })
    expect(result.backdateReason).toBeNull()
  })
})

describe('resolveTransactionDateWithPolicy — future dates', () => {
  it('refuses a future date for a flow recording something that already happened', () => {
    const err = thrownFrom(() =>
      resolveTransactionDateWithPolicy(dayOffset(1), { role: 'ADMIN', ...EXECUTED }),
    )
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST)
    expect((err.getResponse() as { code: string }).code).toBe('FINANCE_TX_DATE_IN_FUTURE')
  })

  it('refuses it for a privileged role too — a reason does not make a payment happen tomorrow', () => {
    const err = thrownFrom(() =>
      resolveTransactionDateWithPolicy(dayOffset(1), {
        role: 'ADMIN',
        ...EXECUTED,
        backdateReason: 'whatever',
      }),
    )
    expect((err.getResponse() as { code: string }).code).toBe('FINANCE_TX_DATE_IN_FUTURE')
  })

  it('allows a future date for a PENDING/planned row — a planned salary is legitimately ahead', () => {
    expect(() =>
      resolveTransactionDateWithPolicy(dayOffset(14), { role: 'ADMIN', ...PLANNED }),
    ).not.toThrow()
  })

  it('accepts today for an executed flow — the upper bound is inclusive', () => {
    expect(() =>
      resolveTransactionDateWithPolicy(kyivToday(), { role: 'SENIOR', ...EXECUTED }),
    ).not.toThrow()
  })

  it('still applies the backdate window to a planned row — "planned" lifts only the FUTURE bound', () => {
    const err = thrownFrom(() =>
      resolveTransactionDateWithPolicy(dayOffset(-120), { role: 'SENIOR', ...PLANNED }),
    )
    expect((err.getResponse() as { code: string }).code).toBe('FINANCE_TX_DATE_TOO_OLD')
  })
})

/**
 * CR-M-2 — the policy's "today" is the KYIV day, and these cases fail if it is
 * swapped for the UTC day.
 *
 * Between Kyiv midnight and UTC midnight (two hours in winter, three in summer)
 * the two calendars disagree. Every other test in this file would pass under
 * either definition, because they use instants where the two agree — so without
 * these two the choice of calendar is unpinned, and a UTC-day policy would
 * silently refuse a date the operator's own Kyiv-based picker had just offered.
 *
 * The instant is injected rather than faked globally, which is the whole reason
 * `kyivDayOf` exists as a separate entry point from `kyivToday`.
 */
describe('resolveTransactionDateWithPolicy — the business day is the Kyiv day', () => {
  // UTC 2026-07-14T21:30Z is already 2026-07-15 in Kyiv (EEST, UTC+3).
  const INSIDE_THE_WINDOW = new Date('2026-07-14T21:30:00.000Z')

  it('accepts the KYIV today for an executed flow, which the UTC day would refuse as future', () => {
    expect(() =>
      resolveTransactionDateWithPolicy('2026-07-15', {
        role: 'SENIOR',
        flow: 'EXECUTED',
        now: INSIDE_THE_WINDOW,
      }),
    ).not.toThrow()
  })

  it('an OMITTED date inside the Kyiv-ahead window resolves to the Kyiv day, not the UTC day', () => {
    // 21:30Z on 14 Jul: still 14 Jul in UTC, already 15 Jul in Kyiv. The stored
    // business date is the date-only value of the KYIV day (UTC midnight of 15 Jul),
    // never the current instant (which would read back as 14 Jul).
    for (const role of ['ADMIN', 'ACCOUNTANT', 'SENIOR', 'DROP'] as const) {
      const result = resolveTransactionDateWithPolicy(undefined, {
        role,
        flow: 'EXECUTED',
        now: INSIDE_THE_WINDOW,
      })
      expect(result.txDate.toISOString()).toBe('2026-07-15T00:00:00.000Z')
      expect(result.backdateReason).toBeNull()
    }
  })

  it('still refuses the day after the Kyiv today', () => {
    const err = thrownFrom(() =>
      resolveTransactionDateWithPolicy('2026-07-16', {
        role: 'SENIOR',
        flow: 'EXECUTED',
        now: INSIDE_THE_WINDOW,
      }),
    )
    expect((err.getResponse() as { code: string }).code).toBe('FINANCE_TX_DATE_IN_FUTURE')
  })

  it('measures the backdating window from the Kyiv day too', () => {
    // Kyiv today is 2026-07-15, so the oldest day in a 31-day window is
    // 2026-06-14. Under a UTC "today" of 2026-07-14 it would be 2026-06-13, and
    // 2026-06-14 would be a day further inside the window than it really is.
    expect(() =>
      resolveTransactionDateWithPolicy('2026-06-14', {
        role: 'SENIOR',
        flow: 'EXECUTED',
        now: INSIDE_THE_WINDOW,
      }),
    ).not.toThrow()
    const err = thrownFrom(() =>
      resolveTransactionDateWithPolicy('2026-06-13', {
        role: 'SENIOR',
        flow: 'EXECUTED',
        now: INSIDE_THE_WINDOW,
      }),
    )
    expect((err.getResponse() as { code: string }).code).toBe('FINANCE_TX_DATE_TOO_OLD')
  })
})

describe('resolveTransactionDateWithPolicy — delegation to the timestamp resolver', () => {
  it('stores an accepted past day at UTC midnight', () => {
    const now = new Date('2026-10-05T18:12:34.567Z')
    const result = resolveTransactionDateWithPolicy('2026-10-04', {
      role: 'ADMIN',
      ...EXECUTED,
      now,
    })
    expect(result.txDate.toISOString()).toBe('2026-10-04T00:00:00.000Z')
  })

  it('keeps the real instant when the chosen day is the current UTC day', () => {
    const now = new Date('2026-10-05T18:12:34.567Z')
    const result = resolveTransactionDateWithPolicy('2026-10-05', {
      role: 'ADMIN',
      ...EXECUTED,
      now,
    })
    expect(result.txDate).toBe(now)
  })

  it('rejects a non-existent calendar day as a 400 rather than recording "now"', () => {
    const err = thrownFrom(() =>
      resolveTransactionDateWithPolicy('2026-02-31', { role: 'ADMIN', ...EXECUTED }),
    )
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST)
    expect((err.getResponse() as { code: string }).code).toBe('FINANCE_TX_DATE_INVALID')
  })
})
