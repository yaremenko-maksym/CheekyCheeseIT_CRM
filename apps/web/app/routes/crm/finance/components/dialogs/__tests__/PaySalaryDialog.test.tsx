/**
 * task-salary-pay-flow — PaySalaryDialog tests (AC6).
 *
 * Pins:
 * 1. The account selector shows «Счёт компании» (default) + every ADMIN partner.
 * 2. «Счёт компании» is selected by default; the currency selector is disabled
 *    (locked to USDT) and the balance hint is shown.
 * 3. Selecting a partner switches to ADMIN_PERSONAL: the currency selector
 *    unlocks, the company balance hint disappears.
 * 4. Submitting with «Счёт компании» calls paySalary with
 *    { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' } (no payerAdminId).
 * 5. Submitting with a partner calls paySalary with
 *    { fundingSource: 'ADMIN_PERSONAL', payerAdminId: <partner>, currency }.
 *
 * Strategy mirrors CreateTransactionDialog.funding-source.test.tsx — mock axios /
 * TanStack hooks so the dialog mounts without a network call, and assert the
 * real mutationFn body by capturing the financeApi.paySalary args.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

// Capture paySalary args. The real mutationFn closes over component state, so we
// drive it through the captured useMutation options below.
const paySalaryMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    paySalary: (...args: unknown[]) => paySalaryMock(...args),
  },
  companyAccountApi: {
    getAccount: vi.fn().mockResolvedValue({ balance: 5000 }),
  },
}))

// Stub TanStack Query hooks. useMutation captures the real mutationFn so we can
// invoke it after driving the UI; useQuery yields admins + a company balance.
let capturedMutationFn: (() => unknown) | null = null
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      if (Array.isArray(queryKey) && queryKey[0] === 'company-account') {
        return { data: { balance: 5000 }, isLoading: false, isFetching: false, error: null }
      }
      if (Array.isArray(queryKey) && queryKey[0] === 'users-all') {
        return {
          data: [
            { id: 'maksym-id', displayName: 'Максим', role: 'ADMIN' },
            { id: 'kostya-id', displayName: 'Костя', role: 'ADMIN' },
            { id: 'hr-id', displayName: 'HR Person', role: 'HR' },
          ],
          isLoading: false,
          isFetching: false,
          error: null,
        }
      }
      return { data: [], isLoading: false, isFetching: false, error: null }
    }),
    useQueryClient: vi
      .fn()
      .mockReturnValue({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
    useMutation: vi.fn().mockImplementation((opts: { mutationFn: () => unknown }) => {
      capturedMutationFn = opts.mutationFn
      return {
        mutate: () => {
          capturedMutationFn?.()
        },
        isPending: false,
        error: null,
      }
    }),
  }
})

import { PaySalaryDialog } from '../PaySalaryDialog'

const TX = {
  id: 'salary-tx-1',
  type: 'SALARY',
  status: 'PENDING',
  amount: '500',
  currency: 'USD',
  receiverName: 'HR Person',
  salaryMonth: '2026-05',
  createdAt: '2026-05-01T00:00:00.000Z',
} as never

function renderDialog() {
  return render(<PaySalaryDialog tx={TX} onClose={() => {}} />)
}

describe('PaySalaryDialog — account + currency selectors', () => {
  beforeEach(() => {
    paySalaryMock.mockClear()
    capturedMutationFn = null
  })

  it('renders «Счёт компании» + every ADMIN partner as account options', () => {
    renderDialog()
    expect(screen.getByTestId('pay-salary-account-company')).toBeInTheDocument()
    expect(screen.getByTestId('pay-salary-account-admin-maksym-id')).toBeInTheDocument()
    expect(screen.getByTestId('pay-salary-account-admin-kostya-id')).toBeInTheDocument()
    // Non-admins must NOT appear as a payer account.
    expect(screen.queryByTestId('pay-salary-account-admin-hr-id')).not.toBeInTheDocument()
  })

  it('«Счёт компании» is default → company balance hint shown', () => {
    renderDialog()
    expect(screen.getByTestId('pay-salary-company-balance-hint')).toBeInTheDocument()
  })

  it('selecting a partner hides the company balance hint', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('pay-salary-account-admin-maksym-id'))
    expect(screen.queryByTestId('pay-salary-company-balance-hint')).not.toBeInTheDocument()
  })

  it('submitting with «Счёт компании» → paySalary(COMPANY_ACCOUNT, USDT, no payerAdminId)', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect(paySalaryMock).toHaveBeenCalledTimes(1)
    const [id, payload] = paySalaryMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('salary-tx-1')
    expect(payload.fundingSource).toBe('COMPANY_ACCOUNT')
    expect(payload.currency).toBe('USDT')
    expect(payload.payerAdminId).toBeUndefined()
  })

  it('submitting with a partner → paySalary(ADMIN_PERSONAL, payerAdminId set)', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('pay-salary-account-admin-kostya-id'))
    fireEvent.click(screen.getByTestId('pay-salary-submit'))
    expect(paySalaryMock).toHaveBeenCalledTimes(1)
    const [, payload] = paySalaryMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.fundingSource).toBe('ADMIN_PERSONAL')
    expect(payload.payerAdminId).toBe('kostya-id')
  })
})
