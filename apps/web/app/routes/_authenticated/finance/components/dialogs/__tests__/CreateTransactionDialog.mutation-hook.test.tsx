/**
 * `useCreateTransactionMutation` (extracted verbatim from `CreateTransactionDialog`):
 * which endpoint each transaction type reaches, the EXACT payload it sends, and the
 * post-success side effects (cache invalidation, toast, close + reset).
 *
 * Strategy: real `useMutation` (so the production `mutationFn`/`onSuccess` genuinely
 * run), only the API boundary + toast are mocked. Every expected payload below is a
 * hand-written literal, never computed from the hook's own inputs.
 */
import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import type { ReceiptState } from '../../ReceiptInput'

const toastSuccess = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m), error: vi.fn() } }))

const declareUsdtProjectIncome = vi.fn().mockResolvedValue({})
const createAdminIncome = vi.fn().mockResolvedValue({})
const createSeniorIncome = vi.fn().mockResolvedValue({})
const createDropIncome = vi.fn().mockResolvedValue({})
const createExpense = vi.fn().mockResolvedValue({})
const createSalary = vi.fn().mockResolvedValue({})
const createAdminTransfer = vi.fn().mockResolvedValue({})
const createDividend = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    declareUsdtProjectIncome: (...a: unknown[]) => declareUsdtProjectIncome(...a),
    createAdminIncome: (...a: unknown[]) => createAdminIncome(...a),
    createSeniorIncome: (...a: unknown[]) => createSeniorIncome(...a),
    createDropIncome: (...a: unknown[]) => createDropIncome(...a),
    createExpense: (...a: unknown[]) => createExpense(...a),
    createSalary: (...a: unknown[]) => createSalary(...a),
    createAdminTransfer: (...a: unknown[]) => createAdminTransfer(...a),
  },
  companyAccountApi: { createDividend: (...a: unknown[]) => createDividend(...a) },
}))

import { useCreateTransactionMutation } from '../create-transaction/useCreateTransactionMutation'
import type { DialogTxType } from '../create-transaction/shared'

const FILE_RECEIPT: ReceiptState = {
  mode: 'file',
  documentId: 'doc-1',
  externalUrl: '',
  fileName: '',
  previewUrl: null,
  mimeType: '',
}

type Args = Parameters<typeof useCreateTransactionMutation>[0]

let invalidate: ReturnType<typeof vi.fn>
let onClose: ReturnType<typeof vi.fn>
let resetForm: ReturnType<typeof vi.fn>

function baseArgs(over: Partial<Args> = {}): Args {
  return {
    qc: { invalidateQueries: invalidate } as unknown as QueryClient,
    type: 'SENIOR_INCOME',
    amount: '100',
    receipt: FILE_RECEIPT,
    isSelectedProjectUsdt: false,
    projectId: 'proj-1',
    receiverId: 'rcv-1',
    usdtIncomeIdempotencyKey: 'k-usdt',
    notes: '',
    txDate: '',
    isUsdtLocked: false,
    currency: 'EUR',
    isAdmin: true,
    fundingSource: 'legacy',
    seniorIncomeIdempotencyKey: 'k-senior',
    dropIncomeIdempotencyKey: 'k-drop',
    category: 'Hosting',
    salaryMonth: '2025-03',
    salaryIdempotencyKey: 'k-salary',
    effectiveTransferSenderId: 'adm-1',
    transferReceiverId: 'adm-2',
    dividendIdempotencyKey: 'k-div',
    dividendReceiverId: 'adm-2',
    isAdminIncomeCompanyFunded: false,
    onClose: onClose as unknown as () => void,
    resetForm: resetForm as unknown as () => void,
    ...over,
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return (
    <I18nTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nTestProvider>
  )
}

async function submit(over: Partial<Args>) {
  const { result } = renderHook(() => useCreateTransactionMutation(baseArgs(over)), { wrapper })
  await act(async () => {
    await result.current.mutateAsync()
  })
}

beforeEach(async () => {
  await loadCatalog('uk')
  invalidate = vi.fn()
  onClose = vi.fn()
  resetForm = vi.fn()
  toastSuccess.mockClear()
  for (const m of [
    declareUsdtProjectIncome,
    createAdminIncome,
    createSeniorIncome,
    createDropIncome,
    createExpense,
    createSalary,
    createAdminTransfer,
    createDividend,
  ])
    m.mockClear()
})

describe('payload per transaction type (empty notes/date -> null)', () => {
  it('ADMIN_INCOME on a USDT project -> declareUsdtProjectIncome, and ONLY that', async () => {
    await submit({ type: 'ADMIN_INCOME', isSelectedProjectUsdt: true })
    expect(declareUsdtProjectIncome).toHaveBeenCalledWith({
      projectId: 'proj-1',
      amount: 100,
      currency: 'USDT',
      receiverId: 'rcv-1',
      receiptDocumentId: 'doc-1',
      receiptExternalUrl: null,
      idempotencyKey: 'k-usdt',
      notes: null,
      txDate: null,
    })
    expect(createAdminIncome).not.toHaveBeenCalled()
  })

  it('ADMIN_INCOME (ADMIN, non-USDT project) -> createAdminIncome with the picked receiver', async () => {
    await submit({ type: 'ADMIN_INCOME' })
    expect(createAdminIncome).toHaveBeenCalledWith({
      projectId: 'proj-1',
      amount: 100,
      currency: 'EUR',
      receiptDocumentId: 'doc-1',
      receiptExternalUrl: null,
      notes: null,
      txDate: null,
      receiverId: 'rcv-1',
    })
    expect(declareUsdtProjectIncome).not.toHaveBeenCalled()
  })

  it('ADMIN_INCOME with a locked USDT currency sends USDT', async () => {
    await submit({ type: 'ADMIN_INCOME', isUsdtLocked: true })
    expect(createAdminIncome.mock.calls[0]![0]).toMatchObject({ currency: 'USDT' })
  })

  it('ADMIN_INCOME (ACCOUNTANT, legacy funding) sends NO receiverId key at all', async () => {
    await submit({ type: 'ADMIN_INCOME', isAdmin: false, fundingSource: 'legacy' })
    const payload = createAdminIncome.mock.calls[0]![0] as Record<string, unknown>
    expect('receiverId' in payload).toBe(false)
  })

  it('ADMIN_INCOME (ACCOUNTANT, company funding) sends the COMPANY_ACCOUNT sentinel', async () => {
    await submit({ type: 'ADMIN_INCOME', isAdmin: false, fundingSource: 'COMPANY_ACCOUNT' })
    expect(createAdminIncome.mock.calls[0]![0]).toMatchObject({ receiverId: 'COMPANY_ACCOUNT' })
  })

  it('SENIOR_INCOME -> createSeniorIncome with its own idempotency key', async () => {
    await submit({ type: 'SENIOR_INCOME' })
    expect(createSeniorIncome).toHaveBeenCalledWith({
      projectId: 'proj-1',
      amount: 100,
      currency: 'EUR',
      idempotencyKey: 'k-senior',
      receiptDocumentId: 'doc-1',
      receiptExternalUrl: null,
      notes: null,
      txDate: null,
    })
  })

  it('DROP_INCOME -> createDropIncome with its own idempotency key', async () => {
    await submit({ type: 'DROP_INCOME' })
    expect(createDropIncome).toHaveBeenCalledWith({
      projectId: 'proj-1',
      amount: 100,
      currency: 'EUR',
      idempotencyKey: 'k-drop',
      receiptDocumentId: 'doc-1',
      receiptExternalUrl: null,
      notes: null,
      txDate: null,
    })
  })

  it('EXPENSE (legacy funding) -> createExpense without a fundingSource key', async () => {
    await submit({ type: 'EXPENSE' })
    expect(createExpense).toHaveBeenCalledWith({
      amount: 100,
      currency: 'EUR',
      category: 'Hosting',
      notes: null,
      receiptDocumentId: 'doc-1',
      receiptExternalUrl: null,
      txDate: null,
    })
    expect('fundingSource' in (createExpense.mock.calls[0]![0] as object)).toBe(false)
  })

  it('EXPENSE from the company account sends fundingSource and a locked USDT currency', async () => {
    await submit({ type: 'EXPENSE', fundingSource: 'COMPANY_ACCOUNT', isUsdtLocked: true })
    expect(createExpense.mock.calls[0]![0]).toMatchObject({
      currency: 'USDT',
      fundingSource: 'COMPANY_ACCOUNT',
    })
  })

  it('SALARY -> createSalary (a neutral reminder: no receipt, no funding source)', async () => {
    await submit({ type: 'SALARY' })
    expect(createSalary).toHaveBeenCalledWith({
      receiverId: 'rcv-1',
      amount: 100,
      currency: 'EUR',
      salaryMonth: '2025-03',
      idempotencyKey: 'k-salary',
      notes: null,
      txDate: null,
    })
  })

  it('ADMIN_TRANSFER -> createAdminTransfer between the effective sender and receiver', async () => {
    await submit({ type: 'ADMIN_TRANSFER' })
    expect(createAdminTransfer).toHaveBeenCalledWith({
      senderId: 'adm-1',
      receiverId: 'adm-2',
      amount: 100,
      currency: 'EUR',
      receiptDocumentId: 'doc-1',
      receiptExternalUrl: null,
      notes: null,
      txDate: null,
    })
  })

  it('DIVIDEND -> createDividend with the target admin and its own idempotency key', async () => {
    await submit({ type: 'DIVIDEND' })
    expect(createDividend).toHaveBeenCalledWith({
      amount: 100,
      idempotencyKey: 'k-div',
      receiptDocumentId: 'doc-1',
      receiptExternalUrl: null,
      txDate: null,
      adminId: 'adm-2',
    })
  })

  it('DIVIDEND without a resolved receiver omits adminId entirely', async () => {
    await submit({ type: 'DIVIDEND', dividendReceiverId: '' })
    expect('adminId' in (createDividend.mock.calls[0]![0] as object)).toBe(false)
  })

  it('an unknown type rejects with "Unknown type"', async () => {
    const { result } = renderHook(
      () => useCreateTransactionMutation(baseArgs({ type: 'NOPE' as DialogTxType })),
      { wrapper },
    )
    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow('Unknown type')
    })
  })
})

describe('notes and date are passed through when filled in', () => {
  const FILLED = { notes: 'paid in cash', txDate: '2025-03-04' }

  it.each([
    ['ADMIN_INCOME', () => createAdminIncome, { isSelectedProjectUsdt: false }],
    ['ADMIN_INCOME', () => declareUsdtProjectIncome, { isSelectedProjectUsdt: true }],
    ['SENIOR_INCOME', () => createSeniorIncome, {}],
    ['DROP_INCOME', () => createDropIncome, {}],
    ['EXPENSE', () => createExpense, {}],
    ['SALARY', () => createSalary, {}],
    ['ADMIN_TRANSFER', () => createAdminTransfer, {}],
  ] as const)('%s', async (type, api, extra) => {
    await submit({ type, ...extra, ...FILLED })
    expect(api().mock.calls[0]![0]).toMatchObject({ notes: 'paid in cash', txDate: '2025-03-04' })
  })

  it('DIVIDEND (has a date but no notes field)', async () => {
    await submit({ type: 'DIVIDEND', ...FILLED })
    expect(createDividend.mock.calls[0]![0]).toMatchObject({ txDate: '2025-03-04' })
  })
})

describe('receipt XOR fields', () => {
  it('url mode sends the link and no document id', async () => {
    await submit({
      receipt: { ...FILE_RECEIPT, mode: 'url', documentId: null, externalUrl: 'https://x.test/r' },
    })
    expect(createSeniorIncome.mock.calls[0]![0]).toMatchObject({
      receiptDocumentId: null,
      receiptExternalUrl: 'https://x.test/r',
    })
  })

  it('url mode with an empty link sends null, not an empty string', async () => {
    await submit({ receipt: { ...FILE_RECEIPT, mode: 'url', documentId: null, externalUrl: '' } })
    expect(createSeniorIncome.mock.calls[0]![0]).toMatchObject({
      receiptDocumentId: null,
      receiptExternalUrl: null,
    })
  })

  it('file mode ignores a stale link left over from url mode', async () => {
    await submit({ receipt: { ...FILE_RECEIPT, externalUrl: 'https://stale.test/r' } })
    expect(createSeniorIncome.mock.calls[0]![0]).toMatchObject({
      receiptDocumentId: 'doc-1',
      receiptExternalUrl: null,
    })
  })

  it('url mode ignores a stale document id left over from file mode', async () => {
    await submit({
      receipt: {
        ...FILE_RECEIPT,
        mode: 'url',
        documentId: 'doc-stale',
        externalUrl: 'https://x.test/r',
      },
    })
    expect(createSeniorIncome.mock.calls[0]![0]).toMatchObject({ receiptDocumentId: null })
  })
})

describe('onSuccess', () => {
  it('refreshes the transactions list + summary, then closes and resets (no toast, no company balance)', async () => {
    await submit({ type: 'SENIOR_INCOME' })
    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['transactions'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['finance-summary'] })
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(resetForm).toHaveBeenCalledTimes(1)
  })

  it('DROP_INCOME confirms with a toast', async () => {
    await submit({ type: 'DROP_INCOME' })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith('Дохід зареєстровано, очікує валідації')
  })

  it('DIVIDEND confirms with a toast and refreshes the company account', async () => {
    await submit({ type: 'DIVIDEND' })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith('Дивіденди виведено')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['company-account'] })
  })

  it('a company-account funded EXPENSE refreshes the company balance', async () => {
    await submit({ type: 'EXPENSE', fundingSource: 'COMPANY_ACCOUNT' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['company-account'] })
  })

  it('a company-funded ADMIN_INCOME refreshes the company balance', async () => {
    await submit({ type: 'ADMIN_INCOME', isAdminIncomeCompanyFunded: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['company-account'] })
  })

  it('a plain EXPENSE leaves the company balance alone', async () => {
    await submit({ type: 'EXPENSE' })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['company-account'] })
  })
})
