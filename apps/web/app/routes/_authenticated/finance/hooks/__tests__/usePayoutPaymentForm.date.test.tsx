import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PayoutRequestDto, TransactionDto } from '@crm/shared'
import { kyivToday } from '@crm/shared'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import type { ReactNode } from 'react'

let payout: PayoutRequestDto | undefined

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({ data: payout, isLoading: false, isError: false }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      error: null,
    }),
  }
})

vi.mock('../../api', () => ({
  financeApi: {
    getPayoutRequest: vi.fn(),
    payPayoutRequest: vi.fn(),
    manualConfirmPayout: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { usePayoutPaymentForm } from '../usePayoutPaymentForm'

function payoutTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'payout-tx',
    type: 'PAYOUT',
    status: 'PENDING_PAYMENT',
    amount: '100',
    currency: 'USDT',
    senderId: 'senior-1',
    senderName: 'Senior',
    senderLabel: null,
    receiverId: null,
    receiverName: null,
    receiverLabel: 'COMPANY',
    seniorSharePercent: null,
    seniorSharePercentSource: null,
    dropSharePercent: null,
    dropSharePercentSource: null,
    projectId: null,
    projectName: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    txHash: null,
    txFromAddress: null,
    rejectionReason: null,
    payoutRequestId: 'payout-1',
    validatedBy: null,
    validatedAt: null,
    createdBy: 'senior-1',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  } as TransactionDto
}

function makePayout(overrides: Partial<PayoutRequestDto> = {}): PayoutRequestDto {
  return {
    id: 'payout-1',
    seniorId: 'senior-1',
    seniorName: 'Senior',
    incomeAmount: '100',
    payableAmount: '74',
    contractAddress: '0xabc',
    txHash: null,
    txFromAddress: null,
    status: 'PENDING',
    transactions: [],
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return <I18nTestProvider>{children}</I18nTestProvider>
}

beforeEach(async () => {
  await loadCatalog('uk')
  payout = undefined
})

describe('usePayoutPaymentForm — payout date', () => {
  it('has no minimum and keeps today while payout data is unavailable', () => {
    payout = undefined
    const { result } = renderHook(() => usePayoutPaymentForm('payout-1', true), { wrapper })
    expect(result.current.payoutMinDate).toBeUndefined()
    expect(result.current.payoutDate).toBe(kyivToday())
  })

  it('prefers the PAYOUT row txDate over createdAt and clamps to a future source date', async () => {
    payout = makePayout({
      transactions: [
        payoutTx({
          txDate: '2099-07-08T00:00:00.000Z',
          createdAt: '2098-01-01T00:00:00.000Z',
        }),
      ],
    })
    const { result } = renderHook(() => usePayoutPaymentForm('payout-1', true), { wrapper })
    expect(result.current.payoutMinDate).toBe('2099-07-08')
    await waitFor(() => expect(result.current.payoutDate).toBe('2099-07-08'))
  })

  it('falls back to the payout row createdAt when txDate is absent', async () => {
    payout = makePayout({
      transactions: [payoutTx({ txDate: null, createdAt: '2099-08-09T12:00:00.000Z' })],
    })
    const { result } = renderHook(() => usePayoutPaymentForm('payout-1', true), { wrapper })
    expect(result.current.payoutMinDate).toBe('2099-08-09')
    await waitFor(() => expect(result.current.payoutDate).toBe('2099-08-09'))
  })

  it('uses payout.createdAt when no PAYOUT transaction is present', async () => {
    payout = makePayout({
      createdAt: '2099-09-10T00:00:00.000Z',
      transactions: [payoutTx({ type: 'SENIOR_INCOME' })],
    })
    const { result } = renderHook(() => usePayoutPaymentForm('payout-1', true), { wrapper })
    expect(result.current.payoutMinDate).toBe('2099-09-10')
    await waitFor(() => expect(result.current.payoutDate).toBe('2099-09-10'))
  })

  it('keeps today when the payout minimum is in the past', async () => {
    payout = makePayout({
      createdAt: '2020-01-02T00:00:00.000Z',
      transactions: [payoutTx({ txDate: '2020-01-02T00:00:00.000Z' })],
    })
    const { result } = renderHook(() => usePayoutPaymentForm('payout-1', true), { wrapper })
    expect(result.current.payoutMinDate).toBe('2020-01-02')
    await waitFor(() => expect(result.current.payoutDate).toBe(kyivToday()))
  })

  it('keeps today while inactive and applies the minimum after activation', async () => {
    payout = makePayout({
      transactions: [payoutTx({ txDate: '2099-10-11T00:00:00.000Z' })],
    })
    const { result, rerender } = renderHook(
      ({ active }) => usePayoutPaymentForm('payout-1', active),
      { initialProps: { active: false }, wrapper },
    )
    expect(result.current.payoutDate).toBe(kyivToday())
    rerender({ active: true })
    await waitFor(() => expect(result.current.payoutDate).toBe('2099-10-11'))
  })

  it('recomputes the date when payout data changes for a new payout id', async () => {
    payout = makePayout({
      id: 'payout-1',
      transactions: [payoutTx({ txDate: '2099-11-12T00:00:00.000Z' })],
    })
    const { result, rerender } = renderHook(
      ({ id }) => usePayoutPaymentForm(id, true),
      { initialProps: { id: 'payout-1' }, wrapper },
    )
    await waitFor(() => expect(result.current.payoutDate).toBe('2099-11-12'))

    payout = makePayout({
      id: 'payout-2',
      createdAt: '2099-12-13T00:00:00.000Z',
      transactions: [],
    })
    rerender({ id: 'payout-2' })
    expect(result.current.payoutMinDate).toBe('2099-12-13')
    await waitFor(() => expect(result.current.payoutDate).toBe('2099-12-13'))
  })
})
