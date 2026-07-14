/**
 * task-senior-settle-owner — SettleSeniorPayoutDialog tests.
 *
 * Pins that paying a senior IOU now mirrors the SALARY pay flow (shared
 * FundingSourceFields):
 * 1. The account selector shows «Счёт компании» (default) + every ADMIN partner.
 * 2. «Счёт компании» is the default → company balance hint shown.
 * 3. Selecting a partner switches to ADMIN_PERSONAL → the company balance hint
 *    disappears (the company account is not touched).
 * 4. Submitting with «Счёт компании» calls settleSeniorPayoutFromTransaction with
 *    { fundingSource: 'COMPANY_ACCOUNT', currency: 'USDT' } (no payerAdminId).
 * 5. Submitting with a partner calls it with
 *    { fundingSource: 'ADMIN_PERSONAL', payerAdminId: <partner>, currency }.
 *
 * Strategy mirrors PaySalaryDialog.test.tsx — mock axios / TanStack hooks /
 * sonner so the dialog mounts without a network call, and assert the real
 * mutationFn body by capturing the settle args.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// Capture the settle args. The real mutationFn closes over component state, so we
// drive it through the captured useMutation options below.
const settleMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    settleSeniorPayoutFromTransaction: (...args: unknown[]) => settleMock(...args),
  },
  companyAccountApi: {
    getAccount: vi.fn().mockResolvedValue({ balance: 5000 }),
  },
}))

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
    useMutation: vi
      .fn()
      .mockImplementation(
        (opts: { mutationFn: () => unknown; onSuccess?: () => void; onError?: () => void }) => {
          capturedMutationFn = opts.mutationFn
          return {
            mutate: () => {
              // Mirrors real useMutation: run mutationFn, then onSuccess once its
              // (possibly-async) result settles — needed so the settle-drop-btn
              // toast-copy tests can await the success toast below.
              Promise.resolve(capturedMutationFn?.())
                .then(() => opts.onSuccess?.())
                .catch(() => opts.onError?.())
            },
            isPending: false,
            error: null,
          }
        },
      ),
  }
})

import { toast } from 'sonner'
import { SettleSeniorPayoutDialog } from '../SettleSeniorPayoutDialog'

const TX = {
  id: 'senior-pending-1',
  type: 'SENIOR_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '560',
  currency: 'USDT',
  receiverName: 'Senior Person',
  projectName: 'Drop Project',
  createdAt: '2026-06-01T00:00:00.000Z',
} as never

// settle-drop-btn: SAME shape as TX above, only type flips to DROP_PENDING_PAYOUT
// (mirrors the company-IOU-to-a-drop row). Used to pin that the dialog is
// REUSED as-is for the drop mirror — only the recipient-facing copy adapts.
const DROP_TX = {
  id: 'drop-pending-1',
  type: 'DROP_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '420',
  currency: 'USDT',
  receiverName: 'Drop Person',
  projectName: 'USDT Project',
  createdAt: '2026-06-01T00:00:00.000Z',
} as never

function renderDialog(tx: unknown = TX) {
  return render(<SettleSeniorPayoutDialog tx={tx as never} onClose={() => {}} />)
}

describe('SettleSeniorPayoutDialog — account + currency selectors (salary-style)', () => {
  beforeEach(() => {
    settleMock.mockClear()
    capturedMutationFn = null
  })

  it('renders «Счёт компании» + every ADMIN partner as account options', () => {
    renderDialog()
    expect(screen.getByTestId('settle-senior-account-company')).toBeInTheDocument()
    expect(screen.getByTestId('settle-senior-account-admin-maksym-id')).toBeInTheDocument()
    expect(screen.getByTestId('settle-senior-account-admin-kostya-id')).toBeInTheDocument()
    // Non-admins must NOT appear as a payer account.
    expect(screen.queryByTestId('settle-senior-account-admin-hr-id')).not.toBeInTheDocument()
  })

  it('«Счёт компании» is default → company balance hint shown', () => {
    renderDialog()
    expect(screen.getByTestId('settle-senior-company-balance-hint')).toBeInTheDocument()
  })

  it('selecting a partner hides the company balance hint', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('settle-senior-account-admin-maksym-id'))
    expect(screen.queryByTestId('settle-senior-company-balance-hint')).not.toBeInTheDocument()
  })

  it('submitting with «Счёт компании» → settle(COMPANY_ACCOUNT, USDT, no payerAdminId)', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    expect(settleMock).toHaveBeenCalledTimes(1)
    const [id, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('senior-pending-1')
    expect(payload.fundingSource).toBe('COMPANY_ACCOUNT')
    expect(payload.currency).toBe('USDT')
    expect(payload.payerAdminId).toBeUndefined()
  })

  it('submitting with a partner → settle(ADMIN_PERSONAL, payerAdminId set)', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('settle-senior-account-admin-kostya-id'))
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    expect(settleMock).toHaveBeenCalledTimes(1)
    const [, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.fundingSource).toBe('ADMIN_PERSONAL')
    expect(payload.payerAdminId).toBe('kostya-id')
  })
})

// settle-drop-btn: pins that the dialog is REUSED as-is for DROP_PENDING_PAYOUT
// rows — same funding picker + same generic settle-company mutation as the
// senior branch above, only the recipient-facing copy (title / toast) adapts.
describe('SettleSeniorPayoutDialog — reused for DROP_PENDING_PAYOUT (settle-drop-btn mirror)', () => {
  beforeEach(() => {
    settleMock.mockClear()
    capturedMutationFn = null
    vi.mocked(toast.success).mockClear()
  })

  it('shows «Выплатить синьору» title for a SENIOR_PENDING_PAYOUT tx', () => {
    renderDialog(TX)
    expect(screen.getByText('Выплатить синьору')).toBeInTheDocument()
  })

  it('shows «Выплатить дропу» title for a DROP_PENDING_PAYOUT tx', () => {
    renderDialog(DROP_TX)
    expect(screen.getByText('Выплатить дропу')).toBeInTheDocument()
    expect(screen.queryByText('Выплатить синьору')).not.toBeInTheDocument()
  })

  it('still surfaces the recipient name (drop) via the shared «Получатель» row', () => {
    renderDialog(DROP_TX)
    expect(screen.getByText('Drop Person')).toBeInTheDocument()
  })

  it('submitting a DROP_PENDING_PAYOUT settle still calls the SAME generic endpoint', () => {
    renderDialog(DROP_TX)
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    expect(settleMock).toHaveBeenCalledTimes(1)
    const [id, payload] = settleMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('drop-pending-1')
    expect(payload.fundingSource).toBe('COMPANY_ACCOUNT')
    expect(payload.currency).toBe('USDT')
  })

  it('submitting a DROP settle shows the drop-specific success toast', async () => {
    renderDialog(DROP_TX)
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Выплата дропу проведена'))
  })

  it('submitting a SENIOR settle still shows the original success toast', async () => {
    renderDialog(TX)
    fireEvent.click(screen.getByTestId('settle-senior-submit'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Выплата синьору проведена'))
  })
})
