/**
 * finance.spec.ts — unit tests for financeSummarySchema.dropBalances
 * covering the new dropSharePercent + pendingCount fields added in
 * feat/drop-balances-panel.
 */
import { describe, expect, it } from 'vitest'
import { financeSummarySchema } from './finance'

const baseSummary = {
  totalIncome: 50000,
  totalExpenses: 12000,
  totalSalaries: 5000,
  netBalance: 33000,
  adminBalances: [],
  monthly: [],
}

describe('financeSummarySchema.dropBalances — new fields', () => {
  it('parses a drop balance entry with dropSharePercent and pendingCount', () => {
    const result = financeSummarySchema.parse({
      ...baseSummary,
      dropBalances: [
        {
          userId: 'a0000000-0000-4000-8000-000000000007',
          displayName: 'Drop User',
          balance: 1250.5,
          dropSharePercent: 7,
          pendingCount: 2,
        },
      ],
    })
    const entry = result.dropBalances[0]
    expect(entry.dropSharePercent).toBe(7)
    expect(entry.pendingCount).toBe(2)
    expect(entry.balance).toBe(1250.5)
  })

  it('accepts null dropSharePercent (legacy rows)', () => {
    const result = financeSummarySchema.parse({
      ...baseSummary,
      dropBalances: [
        {
          userId: 'a0000000-0000-4000-8000-000000000007',
          displayName: 'Drop User',
          balance: 0,
          dropSharePercent: null,
          pendingCount: 0,
        },
      ],
    })
    expect(result.dropBalances[0].dropSharePercent).toBeNull()
  })

  it('accepts zero balance with pendingCount=0', () => {
    const result = financeSummarySchema.parse({
      ...baseSummary,
      dropBalances: [
        {
          userId: 'a0000000-0000-4000-8000-000000000007',
          displayName: 'Drop User',
          balance: 0,
          dropSharePercent: 5,
          pendingCount: 0,
        },
      ],
    })
    expect(result.dropBalances[0].balance).toBe(0)
    expect(result.dropBalances[0].pendingCount).toBe(0)
  })

  it('rejects dropSharePercent > 100', () => {
    expect(() =>
      financeSummarySchema.parse({
        ...baseSummary,
        dropBalances: [
          {
            userId: 'a0000000-0000-4000-8000-000000000007',
            displayName: 'Drop User',
            balance: 0,
            dropSharePercent: 101,
            pendingCount: 0,
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects negative pendingCount', () => {
    expect(() =>
      financeSummarySchema.parse({
        ...baseSummary,
        dropBalances: [
          {
            userId: 'a0000000-0000-4000-8000-000000000007',
            displayName: 'Drop User',
            balance: 0,
            dropSharePercent: 5,
            pendingCount: -1,
          },
        ],
      }),
    ).toThrow()
  })

  it('defaults to empty array when dropBalances is omitted', () => {
    const result = financeSummarySchema.parse(baseSummary)
    expect(result.dropBalances).toEqual([])
  })

  it('accepts multiple drop balance entries', () => {
    const result = financeSummarySchema.parse({
      ...baseSummary,
      dropBalances: [
        {
          userId: 'a0000000-0000-4000-8000-000000000007',
          displayName: 'Drop User',
          balance: 300,
          dropSharePercent: 5,
          pendingCount: 1,
        },
        {
          userId: 'a0000000-0000-4000-8000-000000000008',
          displayName: 'Drop User 2',
          balance: -100,
          dropSharePercent: 10,
          pendingCount: 3,
        },
      ],
    })
    expect(result.dropBalances).toHaveLength(2)
    expect(result.dropBalances[1].dropSharePercent).toBe(10)
    expect(result.dropBalances[1].pendingCount).toBe(3)
  })
})
