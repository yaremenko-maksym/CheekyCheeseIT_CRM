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

const toastWarningMock = vi.fn()
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    warning: (...args: unknown[]) => toastWarningMock(...args),
    success: vi.fn(),
    error: vi.fn(),
  }),
}))

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
    // COPY-M-1: the OBLIGATION, old → new, in its own currency (USD, not the
    // paid UAH); COPY-M-2: the rate by locale, with its pair.
    expect(line.textContent).toMatch(
      /^Зобов’язання за зарплатою: 1\D?180,00\sUSD → 1\D?184,65\sUSD за курсом переказу 41,25\sUAH\/USD$/,
    )
    // COPY-M-3 / COPY-H-1: conditional, «співробітник».
    expect(screen.getByTestId('cascade-salary-invoice-reissue').textContent).toBe(
      'Якщо рахунок уже виставлено, його буде анульовано — співробітник підпише новий',
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
    // COPY-M-4: future tense, the obligation named, its figure quoted.
    expect(line.textContent).toMatch(
      /^Курс переказу не записано — зобов’язання залишиться 1\D?180,00\sUSD, зміниться лише виплачена сума$/,
    )
    expect(screen.queryByTestId('cascade-salary-obligation')).toBeNull()
    expect(screen.getByTestId('cascade-salary-invoice-reissue')).toBeTruthy()
  })

  it('PSE-8. a legacy row with no recorded obligation currency shows bare figures, never «null»', async () => {
    getEditCascadePreviewMock.mockResolvedValue(
      salaryPreview({
        originalCurrency: null,
        exchangeRate: '41.25000000',
        oldOriginalAmount: 1180,
        newOriginalAmount: 1184.654545,
        recomputed: true,
      }),
    )
    renderDialog({ ...PAID_SALARY, originalCurrency: null } as TransactionDto)
    fireEvent.change(amountInput(), { target: { value: '48867' } })

    const line = await screen.findByTestId('cascade-salary-obligation')
    // No currency ⇒ no «null», and no half a pair on the rate.
    expect(line.textContent).toMatch(
      /^Зобов’язання за зарплатою: 1\D?180,00\s+→ 1\D?184,65\s+за курсом переказу 41,25$/,
    )
  })

  it('PSE-9. a salary DTO that omits the rate field is not locked — absent is «not recorded», not «bad rate»', () => {
    const { exchangeRate: _omitted, ...withoutRate } = PAID_SALARY as unknown as Record<
      string,
      unknown
    >
    renderDialog(withoutRate as unknown as TransactionDto)
    expect(amountInput().disabled).toBe(false)
    expect(screen.queryByTestId('admin-edit-locked-amount-note')).toBeNull()
  })

  it('PSE-10. a save whose invoice re-issue failed is not reported as a clean success (SR-M-1)', async () => {
    adminUpdateTransactionMock.mockResolvedValueOnce({ invoiceReissueIncomplete: true })
    // A plain re-save — the path that repairs a voided salary invoice.
    renderDialog(PAID_SALARY)
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    await waitFor(() => expect(toastWarningMock).toHaveBeenCalledTimes(1))
    expect(String(toastWarningMock.mock.calls[0]?.[0])).toContain(
      'рахунок не вдалося анулювати або перевипустити',
    )
  })

  it('PSE-11. a clean save raises no invoice warning', async () => {
    adminUpdateTransactionMock.mockResolvedValueOnce({})
    renderDialog(PAID_SALARY)
    fireEvent.click(screen.getByTestId('admin-edit-save'))
    await waitFor(() => expect(adminUpdateTransactionMock).toHaveBeenCalled())
    expect(toastWarningMock).not.toHaveBeenCalled()
  })

  it('PSE-12. a figure whose obligation is out of range says «перевірте суму», never a reversal (CR-M-1)', async () => {
    getEditCascadePreviewMock.mockResolvedValue({
      editable: false,
      blockedReason: 'SALARY_OBLIGATION_OUT_OF_RANGE',
      plan: null,
      version: null,
    })
    renderDialog(PAID_SALARY)
    fireEvent.change(amountInput(), { target: { value: '400000' } })
    const banner = await screen.findByTestId('cascade-blocked-banner')
    expect(banner.textContent).toBe(
      'За записаним курсом переказу ця сума дає зобов’язання поза допустимими межами — перевірте суму',
    )
  })

  it('PSE-13. a salary whose STORED figure already gives an out-of-range obligation keeps its field open', () => {
    // 400 000 UAH at 0.5 UAH/USD = 800 000 USD, above the ceiling: the figure
    // is wrong, which is exactly what the operator came to fix.
    renderDialog({
      ...PAID_SALARY,
      amount: '400000',
      exchangeRate: '0.50000000',
    } as TransactionDto)
    expect(amountInput().disabled).toBe(false)
    expect(screen.queryByTestId('admin-edit-locked-amount-note')).toBeNull()
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
