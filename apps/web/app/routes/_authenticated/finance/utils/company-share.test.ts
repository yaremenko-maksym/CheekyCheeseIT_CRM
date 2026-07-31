import { describe, expect, it } from 'vitest'
import type { TransactionDto } from '@crm/shared'
import {
  buildAmountLabel,
  buildPreviewRows,
  groupByProject,
  pluralizeIncomes,
  pluralizeProjects,
  resolveSharePercent,
  sumPayable,
} from './company-share'

/**
 * company-share.test.ts — task-company-share-cta.
 *
 * Pins the ONE calculation that matters most in this feature (AC1): the
 * amount shown must be the COMPANY'S payable share, never the gross income.
 * Also covers project-grouping order and the DROP_INCOME share-resolution
 * path (the old PayoutDialog assumed `seniorSharePercent` unconditionally,
 * which would silently mis-price a DROP payout preview).
 */

function makeTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'tx-1',
    type: 'SENIOR_INCOME',
    status: 'VALIDATED',
    amount: '1000',
    currency: 'USDT',
    senderId: null,
    senderName: null,
    senderLabel: 'Client Co',
    receiverId: 'user-1',
    receiverName: 'Senior',
    receiverLabel: null,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    dropSharePercent: null,
    dropSharePercentSource: null,
    projectId: 'p1',
    projectName: 'Project One',
    receiptDocumentId: null,
    receiptExternalUrl: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    txHash: null,
    rejectionReason: null,
    payoutRequestId: null,
    validatedBy: 'accountant-1',
    validatedAt: '2026-07-01T00:00:00.000Z',
    createdBy: 'user-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('resolveSharePercent', () => {
  it('uses the SENIOR_INCOME snapshot when present', () => {
    const tx = makeTx({ seniorSharePercent: 40 })
    expect(resolveSharePercent(tx, 26)).toEqual({ sharePercent: 40, isApproximate: false })
  })

  it('falls back to the caller-supplied SENIOR default for a legacy row with no snapshot', () => {
    const tx = makeTx({ seniorSharePercent: null })
    expect(resolveSharePercent(tx, 30)).toEqual({ sharePercent: 30, isApproximate: true })
  })

  it('uses the DROP_INCOME snapshot — NOT the senior default (regression: old PayoutDialog bug)', () => {
    const tx = makeTx({
      type: 'DROP_INCOME',
      seniorSharePercent: null,
      dropSharePercent: 12,
    })
    // Even with a SENIOR default of 26, a DROP row's own 12% snapshot wins.
    expect(resolveSharePercent(tx, 26)).toEqual({ sharePercent: 12, isApproximate: false })
  })

  it('falls back to the DROP constant (5) for a legacy DROP row with no snapshot', () => {
    const tx = makeTx({ type: 'DROP_INCOME', seniorSharePercent: null, dropSharePercent: null })
    expect(resolveSharePercent(tx, 26)).toEqual({ sharePercent: 5, isApproximate: true })
  })
})

describe('buildPreviewRows — AC1: payable = COMPANY share, not gross income', () => {
  it('computes payable as amount * (1 - sharePercent/100), not the raw amount', () => {
    const tx = makeTx({ amount: '1000', seniorSharePercent: 26 })
    const [row] = buildPreviewRows([tx], 26)
    expect(row!.payable).toBeCloseTo(740, 5) // 1000 * 0.74
    expect(row!.ownShare).toBeCloseTo(260, 5) // 1000 * 0.26
    // The most important assertion in this whole test file: payable must NOT
    // equal the gross transaction amount.
    expect(row!.payable).not.toBeCloseTo(1000, 5)
  })

  it('sums payable across multiple rows correctly (sumPayable)', () => {
    const rows = buildPreviewRows(
      [
        makeTx({ id: 't1', amount: '1000', seniorSharePercent: 26 }),
        makeTx({ id: 't2', amount: '500', seniorSharePercent: 26 }),
      ],
      26,
    )
    // 1000*0.74 + 500*0.74 = 740 + 370 = 1110 — matches the backend's own
    // regression fixture (senior-payout-no-dup.spec.ts scenario C).
    expect(sumPayable(rows)).toBeCloseTo(1110, 5)
  })
})

describe('groupByProject', () => {
  it('groups incomes under their project, newest income first per project group ordering', () => {
    const groups = groupByProject([
      makeTx({
        id: 't-old',
        projectId: 'p1',
        projectName: 'Alpha',
        txDate: '2026-01-01T00:00:00.000Z',
      }),
      makeTx({
        id: 't-new',
        projectId: 'p2',
        projectName: 'Beta',
        txDate: '2026-06-01T00:00:00.000Z',
      }),
    ])
    expect(groups.map((g) => g.projectId)).toEqual(['p2', 'p1'])
    expect(groups[0]!.incomes).toHaveLength(1)
  })

  it('collects multiple incomes for the same project into one group', () => {
    const groups = groupByProject([
      makeTx({ id: 't1', projectId: 'p1' }),
      makeTx({ id: 't2', projectId: 'p1' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.incomes.map((t) => t.id)).toEqual(['t1', 't2'])
  })
})

describe('pluralizeProjects', () => {
  it.each([
    [1, 'проект'],
    [2, 'проекта'],
    [4, 'проекта'],
    [5, 'проектов'],
    [11, 'проектов'],
    [21, 'проект'],
  ])('%i -> %s', (n, expected) => {
    expect(pluralizeProjects(n)).toBe(expected)
  })
})

describe('pluralizeIncomes', () => {
  it.each([
    [1, 'приход'],
    [2, 'прихода'],
    [4, 'прихода'],
    [5, 'приходов'],
    [11, 'приходов'],
    [21, 'приход'],
  ])('%i -> %s', (n, expected) => {
    expect(pluralizeIncomes(n)).toBe(expected)
  })
})

describe('buildAmountLabel', () => {
  it('single currency — plain formatted amount', () => {
    expect(buildAmountLabel(new Map([['USDT', 1240]]))).toContain('USDT')
  })

  it('2-3 currencies — joined breakdown', () => {
    const label = buildAmountLabel(
      new Map([
        ['USDT', 820],
        ['EUR', 300],
      ]),
    )
    expect(label).toContain('USDT')
    expect(label).toContain('EUR')
    expect(label).toContain('+')
  })

  it('4+ currencies — fixed placeholder pointing at the modal', () => {
    const label = buildAmountLabel(
      new Map([
        ['USDT', 1],
        ['EUR', 1],
        ['USD', 1],
        ['UAH', 1],
      ]),
    )
    expect(label).toBe('3+ валюты — точная сумма в модалке')
  })
})
