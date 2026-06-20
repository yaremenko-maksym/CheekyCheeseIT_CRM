/**
 * task-accountant-create-transaction — CreateTransactionDialog role-parity test.
 *
 * Pins the frontend AC: an ACCOUNTANT sees the SAME create-transaction type set
 * as an ADMIN (ADMIN_INCOME / EXPENSE / SALARY / ADMIN_TRANSFER), while a role
 * that should not reach the admin set (SENIOR) renders only its own type. This
 * locks the `isAdminSet = isAdmin || isAccountant` widening so a future edit
 * cannot silently drop the accountant back to an empty/foreign type list.
 *
 * Strategy mirrors UserDialog.create-wizard.test.tsx: mock auth/axios/router and
 * use the real query/mutation hooks (with a mocked queryClient) so the component
 * lifecycle works without a network.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── Mutable auth role so each test can pick the persona ─────────────────────
let currentRole = 'ADMIN'
vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', role: currentRole, displayName: 'Tester' } }),
}))

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// Real query/mutation hooks, but no network + a stub queryClient.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi
      .fn()
      .mockReturnValue({ data: [], isLoading: false, isFetching: false, error: null }),
    useQueryClient: vi
      .fn()
      .mockReturnValue({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
    useMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false, error: null }),
  }
})

// ── Component under test (imported AFTER mocks) ─────────────────────────────
import { CreateTransactionDialog } from '../CreateTransactionDialog'

// The full set an ADMIN can create — ACCOUNTANT must match it exactly.
const ADMIN_SET_TESTIDS = [
  'create-transaction-type-admin_income',
  'create-transaction-type-expense',
  'create-transaction-type-salary',
  'create-transaction-type-admin_transfer',
]

function renderDialog() {
  return render(<CreateTransactionDialog open onClose={() => {}} />)
}

describe('CreateTransactionDialog — ACCOUNTANT/ADMIN type parity', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('ACCOUNTANT sees the SAME type set as ADMIN', () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    for (const id of ADMIN_SET_TESTIDS) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    // And NOT the senior/drop income-only cards.
    expect(screen.queryByTestId('create-transaction-type-senior_income')).not.toBeInTheDocument()
    expect(screen.queryByTestId('create-transaction-type-drop_income')).not.toBeInTheDocument()
  })

  it('ADMIN sees the full admin set (regression baseline)', () => {
    currentRole = 'ADMIN'
    renderDialog()
    for (const id of ADMIN_SET_TESTIDS) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })

  it('SENIOR does NOT get the admin set (no over-grant)', () => {
    currentRole = 'SENIOR'
    renderDialog()
    expect(screen.getByTestId('create-transaction-type-senior_income')).toBeInTheDocument()
    for (const id of ADMIN_SET_TESTIDS) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument()
    }
  })
})

// task-payout-company-ui WS3 — DIVIDEND option is ADMIN-only. Dividends are
// withdrawn by an ADMIN partner; the ACCOUNTANT (despite admin-parity on the
// other types) must NOT see the dividend withdrawal here.
describe('CreateTransactionDialog — DIVIDEND option (ADMIN-only, WS3)', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('ADMIN sees the DIVIDEND type option', () => {
    currentRole = 'ADMIN'
    renderDialog()
    expect(screen.getByTestId('create-transaction-type-dividend')).toBeInTheDocument()
  })

  it('ACCOUNTANT does NOT see the DIVIDEND type option', () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    expect(screen.queryByTestId('create-transaction-type-dividend')).not.toBeInTheDocument()
  })

  it('SENIOR does NOT see the DIVIDEND type option', () => {
    currentRole = 'SENIOR'
    renderDialog()
    expect(screen.queryByTestId('create-transaction-type-dividend')).not.toBeInTheDocument()
  })
})
