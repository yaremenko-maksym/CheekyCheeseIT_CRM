import { describe, expect, it } from 'vitest'
import { compareTxByAmount, compareTxByDate, type TxSortable } from '../sort'
import { DEFAULT_PAGE_SIZE } from '../hooks/usePaginatedFilter'

// Minimal factory — only fields used by the comparator.
const tx = (overrides: Partial<TxSortable>): TxSortable => ({
  txDate: null,
  createdAt: '2026-05-28T00:00:00.000Z',
  amount: '0',
  ...overrides,
})

describe('compareTxByDate', () => {
  it('sorts by txDate descending (newest first) — createdAt is reversed to prove txDate drives it', () => {
    const older = tx({
      txDate: '2026-05-26T00:00:00.000Z',
      createdAt: '2026-05-28T10:00:00.000Z', // created later, but happened earlier
    })
    const newer = tx({
      txDate: '2026-05-28T00:00:00.000Z',
      createdAt: '2026-05-26T10:00:00.000Z', // created earlier, but happened later
    })
    const list = [older, newer].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(newer)
    expect(list[1]).toBe(older)
  })

  it('sorts by txDate ascending (oldest first) — createdAt is reversed to prove txDate drives it', () => {
    const older = tx({
      txDate: '2026-05-26T00:00:00.000Z',
      createdAt: '2026-05-28T10:00:00.000Z',
    })
    const newer = tx({
      txDate: '2026-05-28T00:00:00.000Z',
      createdAt: '2026-05-26T10:00:00.000Z',
    })
    const list = [newer, older].sort((a, b) => compareTxByDate(a, b, 'asc'))
    expect(list[0]).toBe(older)
    expect(list[1]).toBe(newer)
  })

  it('breaks a same-day txDate tie with createdAt, descending', () => {
    // Two legacy income rows, both parsed to the same midnight-UTC txDate —
    // createdAt (unique, monotonic) must decide the order.
    const sameDay = '2026-05-28T00:00:00.000Z'
    const createdEarlier = tx({ txDate: sameDay, createdAt: '2026-05-28T07:00:00.000Z' })
    const createdLater = tx({ txDate: sameDay, createdAt: '2026-05-28T09:00:00.000Z' })
    const list = [createdEarlier, createdLater].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(createdLater)
    expect(list[1]).toBe(createdEarlier)
  })

  it('breaks a same-day txDate tie with createdAt, ascending', () => {
    const sameDay = '2026-05-28T00:00:00.000Z'
    const createdEarlier = tx({ txDate: sameDay, createdAt: '2026-05-28T07:00:00.000Z' })
    const createdLater = tx({ txDate: sameDay, createdAt: '2026-05-28T09:00:00.000Z' })
    const list = [createdLater, createdEarlier].sort((a, b) => compareTxByDate(a, b, 'asc'))
    expect(list[0]).toBe(createdEarlier)
    expect(list[1]).toBe(createdLater)
  })

  it('a null-txDate row (payout) uses its own createdAt as effective date — newer payout beats older dated row, descending', () => {
    // Round 2 (H-1): a null-txDate row is NOT pinned to a fixed edge — its
    // effective date is its own createdAt, and it sorts on equal footing
    // with dated rows. Here the payout's createdAt is NEWER than the dated
    // row's txDate, so it sorts first — same outcome round 1's "undated
    // always first" produced, but for a data-driven reason, not a rule.
    const dated = tx({ txDate: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
    const newerUndated = tx({ txDate: null, createdAt: '2026-06-01T00:00:00.000Z' })
    const list = [dated, newerUndated].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(newerUndated)
    expect(list[1]).toBe(dated)
  })

  it('a null-txDate row (payout) can sort AFTER a dated row when its createdAt is older, descending — round-1 regression (H-1)', () => {
    // This is exactly what round 1's "undated always first" got wrong: an
    // OLD payout has no business outranking a FRESH dated row just because
    // it lacks a txDate. With the createdAt fallback, an old payout's
    // effective date is genuinely old, so it sorts where it belongs.
    const oldUndated = tx({ txDate: null, createdAt: '2020-01-01T00:00:00.000Z' })
    const newerDated = tx({
      txDate: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-06-01T00:00:00.000Z',
    })
    const list = [oldUndated, newerDated].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(newerDated)
    expect(list[1]).toBe(oldUndated)
  })

  it('a null-txDate row (payout) uses its own createdAt as effective date, ascending', () => {
    const dated = tx({ txDate: '2024-01-01T00:00:00.000Z', createdAt: '2024-01-01T00:00:00.000Z' })
    const olderUndated = tx({ txDate: null, createdAt: '2020-01-01T00:00:00.000Z' })
    const list = [dated, olderUndated].sort((a, b) => compareTxByDate(a, b, 'asc'))
    expect(list[0]).toBe(olderUndated)
    expect(list[1]).toBe(dated)
  })

  it('breaks a tie between two null-txDate rows (payouts) with createdAt, descending', () => {
    const earlierCreated = tx({ txDate: null, createdAt: '2026-05-26T10:00:00.000Z' })
    const laterCreated = tx({ txDate: null, createdAt: '2026-05-28T10:00:00.000Z' })
    const list = [earlierCreated, laterCreated].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(laterCreated)
    expect(list[1]).toBe(earlierCreated)
  })

  it('returns 0 when txDate and createdAt are both identical', () => {
    const a = tx({ txDate: '2026-05-28T00:00:00.000Z', createdAt: '2026-05-28T05:00:00.000Z' })
    const b = tx({ txDate: '2026-05-28T00:00:00.000Z', createdAt: '2026-05-28T05:00:00.000Z' })
    // `mul * (0 - 0)` can produce -0 in JS; both are "equal" for Array.sort
    // semantics, so we normalise via `+ 0` and assert.
    expect(compareTxByDate(a, b, 'desc') + 0).toBe(0)
    expect(compareTxByDate(a, b, 'asc') + 0).toBe(0)
  })

  it('returns 0 when both rows are null-txDate with identical createdAt', () => {
    const a = tx({ txDate: null, createdAt: '2026-05-28T05:00:00.000Z' })
    const b = tx({ txDate: null, createdAt: '2026-05-28T05:00:00.000Z' })
    expect(compareTxByDate(a, b, 'desc') + 0).toBe(0)
    expect(compareTxByDate(a, b, 'asc') + 0).toBe(0)
  })

  it('treats an undefined txDate the same as null (no date) — falls back to createdAt, not epoch-0', () => {
    // `financeApi.getTransactions` types its response `TransactionDto[]` but
    // does not `.parse()` it — a payload that omits `txDate` reaches the
    // comparator as `undefined`, not `null`. `??` must still treat it as
    // "use createdAt", not fall through to `toTime()`'s epoch-0 default
    // (which would misfile it as the oldest possible dated row instead of
    // using its real createdAt).
    const dated = tx({ txDate: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
    // Cast: TxSortable's type says `string | null`, but this pins the actual
    // untyped-at-runtime shape described above. createdAt is LATER than
    // `dated`'s txDate, so if the fallback works it sorts first in DESC —
    // if it were mistaken for epoch-0 it would sort last instead.
    const undatedViaMissingKey = tx({
      txDate: undefined as unknown as null,
      createdAt: '2026-06-01T00:00:00.000Z',
    })
    const desc = [dated, undatedViaMissingKey].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(desc[0]).toBe(undatedViaMissingKey)
    expect(desc[1]).toBe(dated)
    const asc = [dated, undatedViaMissingKey].sort((a, b) => compareTxByDate(a, b, 'asc'))
    expect(asc[0]).toBe(dated)
    expect(asc[1]).toBe(undatedViaMissingKey)
  })

  describe('pagination regressions (task-finance-sort-date-and-jump)', () => {
    // Both tests below sort a page-worth-exceeding list and slice the FIRST
    // page exactly like `usePaginatedFilter` does, to catch a "correct
    // comparator, wrong result once paginated" class of bug directly — a
    // pure two-row comparator test cannot see a page boundary.

    it('round-1 guarantee, still held: a freshly-created undated payout is not pushed off page 1 by many older dated rows', () => {
      // The ORIGINAL bug (pre-round-1): a brand-new payout (txDate always
      // null, createdAt = now) sorted behind every dated row once the list
      // passed one page, becoming invisible right after creation.
      const oldDatedRows: TxSortable[] = Array.from({ length: DEFAULT_PAGE_SIZE + 10 }, (_, i) =>
        tx({
          txDate: `2020-01-01T00:00:00.${String(i).padStart(3, '0')}Z`,
          createdAt: `2020-01-01T00:00:00.${String(i).padStart(3, '0')}Z`,
        }),
      )
      const freshPayout = tx({ txDate: null, createdAt: '2026-08-22T12:00:00.000Z' })
      const sorted = [...oldDatedRows, freshPayout].sort((a, b) => compareTxByDate(a, b, 'desc'))
      const firstPage = sorted.slice(0, DEFAULT_PAGE_SIZE)
      expect(firstPage).toContain(freshPayout)
    })

    it('H-1 regression: a fresh dated row is not pushed off page 1 by a pile of older undated payouts', () => {
      // What round 1's "undated always first" broke, caught live by the
      // `drop-finance` E2E shard (16 real-API specs sharing one DB
      // accumulate payouts past 50 across a run; `crm_qa`'s local snapshot
      // only had ~2 and never crossed the boundary). Every payout below
      // predates `freshDated`, so under a correct effective-date sort it
      // must lose to it regardless of lacking a `txDate` — under round 1's
      // fixed "undated first" edge, all of them would win anyway.
      const oldPayouts: TxSortable[] = Array.from({ length: DEFAULT_PAGE_SIZE + 10 }, (_, i) =>
        tx({ txDate: null, createdAt: `2020-01-01T00:00:00.${String(i).padStart(3, '0')}Z` }),
      )
      const freshDated = tx({
        txDate: '2026-08-22T00:00:00.000Z',
        createdAt: '2020-06-01T00:00:00.000Z', // old createdAt too — only txDate makes it "fresh"
      })
      const sorted = [...oldPayouts, freshDated].sort((a, b) => compareTxByDate(a, b, 'desc'))
      const firstPage = sorted.slice(0, DEFAULT_PAGE_SIZE)
      expect(firstPage).toContain(freshDated)
    })
  })

  describe('same-day granularity (real CI regression: drop-share-usdt-income.spec.ts settle-in-place)', () => {
    // Live CI failure with the ?? createdAt fallback ALONE (no day
    // truncation): `SettleSeniorPayoutDialog` defaults a DROP settle's date
    // picker to the obligation's OWN `createdAt.slice(0, 10)` (day-only), so
    // settling writes a `txDate` at MIDNIGHT UTC of the SAME day the row was
    // already created on — see `pending-settlement.service.ts`'s
    // `txDateToWrite`. Comparing that coarse midnight instant against
    // another still-undated row's millisecond-precise `createdAt` fallback
    // is an apples-to-oranges granularity mismatch: the settled row could
    // rank BELOW same-day rows with a later time-of-day, even though its own
    // `createdAt` (and the calendar day itself) never changed.

    it('settling a same-day payout (coarse midnight txDate) does not change its rank relative to a same-day undated row', () => {
      const rowCreatedAt = '2026-08-22T14:20:00.000Z' // afternoon, same day
      // Still pending — its effective date is its own (earlier) createdAt.
      const otherUndated = tx({ txDate: null, createdAt: '2026-08-22T10:00:00.000Z' })

      const beforeSettle = tx({ txDate: null, createdAt: rowCreatedAt })
      const rankBefore = [beforeSettle, otherUndated].sort((a, b) => compareTxByDate(a, b, 'desc'))
      expect(rankBefore[0], 'before settle: 14:20 createdAt outranks 10:00').toBe(beforeSettle)

      // Settling: txDate = day(createdAt) at midnight; createdAt is
      // untouched (settle only writes txDate, per pending-settlement.service.ts).
      const afterSettle = tx({ txDate: '2026-08-22T00:00:00.000Z', createdAt: rowCreatedAt })
      const rankAfter = [afterSettle, otherUndated].sort((a, b) => compareTxByDate(a, b, 'desc'))
      expect(
        rankAfter[0],
        'after settle: same day as before — must still outrank the 10:00 undated row, not fall behind it because its txDate reads as literal midnight',
      ).toBe(afterSettle)
    })

    it('two rows on the same calendar day, one dated (any time-of-day) one undated, tie-break by raw createdAt — not by the coarse/precise mismatch', () => {
      const datedMidnight = tx({
        txDate: '2026-08-22T00:00:00.000Z',
        createdAt: '2026-08-22T23:00:00.000Z', // created LATE in the day
      })
      const undatedEarly = tx({ txDate: null, createdAt: '2026-08-22T01:00:00.000Z' }) // created EARLY
      const list = [undatedEarly, datedMidnight].sort((a, b) => compareTxByDate(a, b, 'desc'))
      // Same day either way — createdAt (23:00 vs 01:00) decides, not the
      // literal txDate/fallback instant (which would wrongly put the
      // midnight-txDate row behind the 01:00 undated row).
      expect(list[0]).toBe(datedMidnight)
      expect(list[1]).toBe(undatedEarly)
    })
  })
})

describe('compareTxByAmount', () => {
  it('sorts numerically by amount (DESC)', () => {
    const small = tx({ amount: '100' })
    const big = tx({ amount: '9999.99' })
    const list = [small, big].sort((a, b) => compareTxByAmount(a, b, 'desc'))
    expect(list[0]).toBe(big)
    expect(list[1]).toBe(small)
  })

  it('sorts numerically by amount (ASC)', () => {
    const small = tx({ amount: '100' })
    const big = tx({ amount: '9999.99' })
    const list = [big, small].sort((a, b) => compareTxByAmount(a, b, 'asc'))
    expect(list[0]).toBe(small)
    expect(list[1]).toBe(big)
  })
})
