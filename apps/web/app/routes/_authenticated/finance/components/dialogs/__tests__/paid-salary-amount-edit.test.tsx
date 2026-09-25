/**
 * task-paid-salary-amount-edit — the owner's scenario (2026-09-25): «Редактировать
 * транзакцию», Зарплата 48 867 UAH, месяц 2026-08. The amount field used to
 * refuse with «…исправьте документ об оплате» after the operator typed.
 *
 *   PSE-1/PSE-2  a paid salary previews what happens to its obligation — at the
 *                recorded rate, or said out loud that no rate was recorded — and
 *                warns that the invoice will be voided and re-issued
 *   PSE-3/PSE-4  a row whose amount stays pinned has the field disabled on OPEN,
 *                with the reason under it, instead of a refusal after typing
 *   PSE-5        …and a paid salary is NOT one of them
 *   PSE-6        the refusal banner for a pinned payment fact is the catalogued
 *                uk text, the same one the 400 carries
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

import type { CascadeEditPreviewResponse, TransactionDto } from '@crm/shared'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

const adminUpdateTransactionMock = vi.fn().mockResolvedValue({})
const getEditCascadePreviewMock = vi.fn()

vi.mock('../../../api', () => ({
  financeApi: {
    adminUpdateTransaction: (...args: unknown[]) => adminUpdateTransactionMock(...args),
    getEditCascadePreview: (...args: unknown[]) => getEditCascadePreviewMock(...args),
  },
}))

import { AdminEditTransactionDialog } from '../AdminEditTransactionDialog'

const PAID_SALARY = {
  id: '66666666-0000-4000-8f00-000000000001',
  type: 'SALARY',
  status: 'PAID',
  amount: '48675',
  currency: 'UAH',
  originalAmount: '1180.000000',
  originalCurrency: 'USD',
  exchangeRate: '41.25000000',
  settledAmount: null,
  receiptDocumentId: null,
  receiptExternalUrl: null,
  notes: null,
  receiverLabel: null,
  receiverName: 'Олена Коваль',
  salaryMonth: '2026-08',
  payoutRequestId: null,
} as unknown as TransactionDto

function salaryPreview(
  sourcePaymentFact: NonNullable<CascadeEditPreviewResponse['plan']>['sourcePaymentFact'],
): CascadeEditPreviewResponse {
  return {
    editable: true,
    blockedReason: null,
    plan: {
      sourceId: PAID_SALARY.id,
      sourceAmountChanged: true,
      oldSourceAmount: 48675,
      newSourceAmount: 48867,
      sourceCurrency: 'UAH',
      derivatives: [],
      sourceWarnings: [],
      sourcePaymentFact,
    },
    version: 'src:v1',
  }
}

function renderDialog(tx: TransactionDto) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AdminEditTransactionDialog tx={tx} onClose={() => {}} />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

function amountInput() {
  return screen.getByTestId('amount-currency-amount-input') as HTMLInputElement
}

beforeEach(async () => {
  vi.clearAllMocks()
  await loadCatalog('uk')
})

describe('paid salary: amount edit with the obligation at the recorded rate', () => {
  it('PSE-1. previews the obligation at the transfer rate and the invoice re-issue', async () => {
    getEditCascadePreviewMock.mockResolvedValue(
      salaryPreview({
        originalCurrency: 'USD',
        exchangeRate: '41.25000000',
        oldOriginalAmount: 1180,
        newOriginalAmount: 1184.654545,
        recomputed: true,
      }),
    )
    renderDialog(PAID_SALARY)
    fireEvent.change(amountInput(), { target: { value: '48867' } })

    const line = await screen.findByTestId('cascade-salary-obligation')
    expect(line.textContent).toContain('Зарплата стане')
    expect(line.textContent).toContain('за курсом переказу 41.25')
    expect(line.textContent).toContain('1')
    expect(screen.getByTestId('cascade-salary-invoice-reissue').textContent).toContain(
      'Рахунок буде анульовано й перевипущено на підпис працівнику',
    )
    // The generic «nothing to recompute» line would be false here — the
    // obligation IS recomputed.
    expect(screen.queryByTestId('cascade-preview-empty')).toBeNull()
    expect(screen.queryByTestId('cascade-salary-rate-missing')).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId('admin-edit-save')).toHaveProperty('disabled', false),
    )
  })

  it('PSE-2. with no recorded rate says the obligation is not recalculated, and quotes no new figure', async () => {
    getEditCascadePreviewMock.mockResolvedValue(
      salaryPreview({
        originalCurrency: 'USD',
        exchangeRate: null,
        oldOriginalAmount: 1180,
        newOriginalAmount: 1180,
        recomputed: false,
      }),
    )
    renderDialog({ ...PAID_SALARY, exchangeRate: null } as TransactionDto)
    fireEvent.change(amountInput(), { target: { value: '48867' } })

    const line = await screen.findByTestId('cascade-salary-rate-missing')
    expect(line.textContent).toContain('Курс переказу не записано')
    expect(screen.queryByTestId('cascade-salary-obligation')).toBeNull()
    expect(screen.getByTestId('cascade-salary-invoice-reissue')).toBeTruthy()
  })

  it('PSE-5. a paid salary keeps its amount field open', () => {
    renderDialog(PAID_SALARY)
    expect(amountInput().disabled).toBe(false)
    expect(screen.queryByTestId('admin-edit-locked-amount-note')).toBeNull()
  })
})

describe('rows whose amount stays pinned: disabled on open, not refused after typing', () => {
  it('PSE-3. a converted income carrying the payment fact — field disabled, catalogued reason shown', () => {
    renderDialog({ ...PAID_SALARY, type: 'SENIOR_INCOME' } as TransactionDto)
    expect(amountInput().disabled).toBe(true)
    expect(screen.getByTestId('admin-edit-locked-amount-note').textContent).toContain(
      'зафіксовано разом із курсом переказу',
    )
    expect(getEditCascadePreviewMock).not.toHaveBeenCalled()
  })

  it('PSE-4. a settled row — field disabled with the accumulator reason', () => {
    renderDialog({
      ...PAID_SALARY,
      type: 'SENIOR_INCOME',
      originalAmount: null,
      originalCurrency: null,
      exchangeRate: null,
      settledAmount: '48675',
    } as TransactionDto)
    expect(amountInput().disabled).toBe(true)
    expect(screen.getByTestId('admin-edit-locked-amount-note').textContent).toContain(
      'уже прошли выплаты',
    )
  })

  it('PSE-7. a PENDING row with the same columns is not pinned — only a PAID amount is', () => {
    renderDialog({ ...PAID_SALARY, type: 'SENIOR_INCOME', status: 'PENDING' } as TransactionDto)
    expect(amountInput().disabled).toBe(false)
  })

  it('PSE-6. the refusal banner for a pinned payment fact is the catalogued text', async () => {
    getEditCascadePreviewMock.mockResolvedValue({
      editable: false,
      blockedReason: 'PAYMENT_FACT_RECORDED',
      plan: null,
      version: null,
    })
    // A salary whose obligation at the recorded rate cannot be stored is the
    // one path that still reaches this banner from an open field.
    renderDialog(PAID_SALARY)
    fireEvent.change(amountInput(), { target: { value: '400000' } })

    const banner = await screen.findByTestId('cascade-blocked-banner')
    expect(banner.textContent).toContain('Суму цього платежу зафіксовано разом із курсом переказу')
    expect(banner.textContent).not.toContain('документ об оплате')
  })
})
