/**
 * task-salary-company-account / task-salary-pay-flow — funding source selector tests.
 *
 * Pins the AC (post-rework):
 * 1. SALARY no longer shows a funding-source section — a manual salary is a
 *    neutral PENDING reminder; the funding source + currency are chosen at pay
 *    time (PaySalaryDialog), NOT at creation.
 * 2. EXPENSE keeps the funding selector: defaults to legacy; selecting
 *    COMPANY_ACCOUNT shows the balance hint.
 * 3. ADMIN_INCOME keeps the funding selector: defaults to legacy; selecting
 *    COMPANY_ACCOUNT shows the balance hint.
 * 4. Switching type resets fundingSource to that type's default.
 * 5. Non-funding types (SENIOR_INCOME, ADMIN_TRANSFER) never show the section.
 *
 * Strategy mirrors CreateTransactionDialog.accountant.test.tsx:
 * mock auth/axios/router and stub TanStack hooks so the component mounts
 * without a network call.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── Mutable auth role ────────────────────────────────────────────────────────
let currentRole = 'ADMIN'
vi.mock('@/context/auth', () => ({
  useAuth: () => ({
    user: { id: 'admin-1', role: currentRole, displayName: 'Admin User' },
  }),
}))

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

// Stub TanStack Query hooks — return realistic empty/default values.
// useQuery is called multiple times (projects, users, company-account, exchange-rate);
// we return a discriminated mock so the company-account query yields a balance.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      // company-account query — return a stub balance so the hint renders.
      if (Array.isArray(queryKey) && queryKey[0] === 'company-account') {
        return {
          data: { balance: 1234.56, walletAddress: '0xABC', confirmationThreshold: 12 },
          isLoading: false,
          isFetching: false,
          error: null,
        }
      }
      // users-all — return one admin so the user pools have an option.
      if (Array.isArray(queryKey) && queryKey[0] === 'users-all') {
        return {
          data: [{ id: 'admin-1', displayName: 'Admin User', role: 'ADMIN' }],
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
    useMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false, error: null }),
  }
})

// ── Component ────────────────────────────────────────────────────────────────
import { CreateTransactionDialog } from '../CreateTransactionDialog'

function renderDialog() {
  return render(<CreateTransactionDialog open onClose={() => {}} />)
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function clickTypeCard(testId: string) {
  fireEvent.click(screen.getByTestId(testId))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CreateTransactionDialog — SALARY no longer has a funding selector', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('SALARY does NOT show the funding-source section (chosen at pay time)', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    expect(
      screen.queryByTestId('create-transaction-funding-source-section'),
    ).not.toBeInTheDocument()
  })

  it('SALARY shows no company balance hint and no payer-admin selector', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    expect(screen.queryByTestId('create-transaction-company-balance-hint')).not.toBeInTheDocument()
    expect(screen.queryByTestId('create-transaction-payer-admin-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('create-transaction-funding-personal')).not.toBeInTheDocument()
  })

  it('SALARY still shows the receiver + month fields (neutral reminder)', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    expect(screen.getByTestId('create-transaction-receiver-trigger')).toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — funding source: EXPENSE (kept)', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('funding-source section visible for EXPENSE', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-expense')
    expect(screen.getByTestId('create-transaction-funding-source-section')).toBeInTheDocument()
  })

  it('EXPENSE defaults to legacy (no company balance hint initially)', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-expense')
    // Legacy option should be pre-selected; no balance hint.
    expect(screen.getByTestId('create-transaction-funding-legacy')).toBeInTheDocument()
    expect(screen.queryByTestId('create-transaction-company-balance-hint')).not.toBeInTheDocument()
  })

  it('selecting COMPANY_ACCOUNT for EXPENSE shows the balance hint', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-expense')
    fireEvent.click(screen.getByTestId('create-transaction-funding-company'))
    expect(screen.getByTestId('create-transaction-company-balance-hint')).toBeInTheDocument()
  })
})

// task-admin-income-unified (§2, owner decision 2026-08-12): ADMIN's old
// binary "Источник средств" toggle for ADMIN_INCOME is REPLACED by the flat
// "Счёт получателя" receiver Select (any active admin + «Счёт компании») —
// same Select the USDT route uses. ACCOUNTANT keeps a toggle-shaped selector
// (see the next describe block) since the server denies them a specific-admin
// choice; ADMIN does not have that restriction.
describe('CreateTransactionDialog — ADMIN_INCOME receiver Select replaces the funding-source toggle for ADMIN (§2)', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('ADMIN gets the flat receiver Select, NOT the old funding-source section', () => {
    renderDialog()
    // ADMIN_INCOME is the first type in availableTypes for ADMIN — already selected.
    expect(
      screen.queryByTestId('create-transaction-funding-source-section'),
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-income-receiver-trigger')).toBeInTheDocument()
  })

  it('no balance hint before a receiver is chosen', () => {
    renderDialog()
    expect(screen.queryByTestId('create-transaction-company-balance-hint')).not.toBeInTheDocument()
  })

  it('selecting «Счёт компании» in the receiver Select shows the balance hint', async () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('admin-income-receiver-trigger'))
    fireEvent.click(await screen.findByRole('option', { name: 'Счёт компании' }))
    expect(screen.getByTestId('create-transaction-company-balance-hint')).toBeInTheDocument()
  })
})

// task-admin-income-unified (§2): ACCOUNTANT keeps a toggle-shaped selector —
// "Счёт получателя" reusing the exact `fundingSource` state/markup EXPENSE's
// toggle uses (no new state) — but it can only ever mean "project owner" or
// "company account", never a specific OTHER admin (server-enforced, AC10).
describe('CreateTransactionDialog — ACCOUNTANT constrained "Счёт получателя" for ADMIN_INCOME (§2, AC10)', () => {
  it('toggle-shaped section visible for ACCOUNTANT, no flat admin Select', () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    expect(screen.getByTestId('create-transaction-funding-source-section')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-income-receiver-trigger')).not.toBeInTheDocument()
  })

  it('defaults to "project owner" (no balance hint initially)', () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    expect(screen.queryByTestId('create-transaction-company-balance-hint')).not.toBeInTheDocument()
  })

  it('selecting «Счёт компании» shows the balance hint', () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    fireEvent.click(screen.getByTestId('create-transaction-funding-company'))
    expect(screen.getByTestId('create-transaction-company-balance-hint')).toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — funding source: type switch resets', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('switching from EXPENSE (company selected) to SALARY hides the section', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-expense')
    fireEvent.click(screen.getByTestId('create-transaction-funding-company'))
    expect(screen.getByTestId('create-transaction-company-balance-hint')).toBeInTheDocument()
    // Switch to SALARY — funding section disappears entirely.
    clickTypeCard('create-transaction-type-salary')
    expect(
      screen.queryByTestId('create-transaction-funding-source-section'),
    ).not.toBeInTheDocument()
  })

  it('switching from SALARY to EXPENSE shows the legacy default (no hint)', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    expect(
      screen.queryByTestId('create-transaction-funding-source-section'),
    ).not.toBeInTheDocument()
    // Switch to EXPENSE — section back, legacy default (no hint).
    clickTypeCard('create-transaction-type-expense')
    expect(screen.getByTestId('create-transaction-funding-source-section')).toBeInTheDocument()
    expect(screen.queryByTestId('create-transaction-company-balance-hint')).not.toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — funding source not shown for non-admin types', () => {
  it('SENIOR_INCOME does NOT show funding-source section', () => {
    currentRole = 'SENIOR'
    renderDialog()
    expect(
      screen.queryByTestId('create-transaction-funding-source-section'),
    ).not.toBeInTheDocument()
  })

  it('ADMIN_TRANSFER does NOT show funding-source section', () => {
    currentRole = 'ADMIN'
    renderDialog()
    clickTypeCard('create-transaction-type-admin_transfer')
    expect(
      screen.queryByTestId('create-transaction-funding-source-section'),
    ).not.toBeInTheDocument()
  })
})
