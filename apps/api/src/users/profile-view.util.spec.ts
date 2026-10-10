import { describe, expect, it } from 'vitest'
import { collectExposedRequisiteFields, computePendingSeniorShare } from './profile-view.util'

const target = {
  id: 'u-1',
  displayName: 'Senior One',
  pendingSeniorSharePercent: 40,
  seniorSharePercent: 30,
}

describe('computePendingSeniorShare', () => {
  it('returns null for any non-PENDING status', () => {
    expect(computePendingSeniorShare(target, 'NONE')).toBeNull()
    expect(computePendingSeniorShare(target, 'APPROVED')).toBeNull()
    expect(computePendingSeniorShare(target, '')).toBeNull()
  })

  it('builds the DTO from the pending percent when PENDING', () => {
    expect(computePendingSeniorShare(target, 'PENDING')).toEqual({
      percent: 40,
      effectivePercentAfterApproval: 40,
      approverId: 'u-1',
      approverName: 'Senior One',
    })
  })

  it('falls back to the active percent when pending percent is null', () => {
    expect(
      computePendingSeniorShare({ ...target, pendingSeniorSharePercent: null }, 'PENDING'),
    ).toEqual({
      percent: 30,
      effectivePercentAfterApproval: 30,
      approverId: 'u-1',
      approverName: 'Senior One',
    })
  })

  it('keeps a pending percent of 0 (nullish, not falsy, fallback)', () => {
    const r = computePendingSeniorShare({ ...target, pendingSeniorSharePercent: 0 }, 'PENDING')
    expect(r?.percent).toBe(0)
    expect(r?.effectivePercentAfterApproval).toBe(0)
  })
})

describe('collectExposedRequisiteFields', () => {
  it('returns only non-null requisite fields, in canonical order', () => {
    expect(
      collectExposedRequisiteFields({
        id: 'x',
        adminNote: 'secret',
        paymentMethod: 'USDT_ERC20',
        walletUsdtErc20: '0xabc',
        walletUsdtLabel: null,
        bankUahRecipient: null,
        bankUahIban: 'UA00',
        bankUahRnokpp: null,
        bankUahBankName: 'Mono',
      }),
    ).toEqual(['paymentMethod', 'walletUsdtErc20', 'bankUahIban', 'bankUahBankName'])
  })

  it('returns empty when all requisites are masked', () => {
    expect(
      collectExposedRequisiteFields({
        paymentMethod: null,
        walletUsdtErc20: null,
        walletUsdtLabel: null,
        bankUahRecipient: null,
        bankUahIban: null,
        bankUahRnokpp: null,
        bankUahBankName: null,
      }),
    ).toEqual([])
  })

  it('treats undefined as not exposed and ignores non-requisite keys', () => {
    expect(collectExposedRequisiteFields({ adminNote: 'x', walletUsdtLabel: 'main' })).toEqual([
      'walletUsdtLabel',
    ])
    expect(collectExposedRequisiteFields({})).toEqual([])
  })

  it('counts empty-string values as exposed (only null/undefined are masked)', () => {
    expect(collectExposedRequisiteFields({ bankUahRnokpp: '' })).toEqual(['bankUahRnokpp'])
  })
})
