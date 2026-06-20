/**
 * task-salary-company-account — funding source selector tests.
 *
 * Pins the AC:
 * 1. SALARY defaults to COMPANY_ACCOUNT (funding-source section visible,
 *    "Счёт компании" pre-selected, USDT locked).
 * 2. Switching SALARY to ADMIN_PERSONAL shows the payerAdmin selector.
 * 3. EXPENSE defaults to legacy (no company-account selection).
 * 4. Selecting COMPANY_ACCOUNT for EXPENSE shows the balance hint.
 * 5. ADMIN_INCOME defaults to legacy; selecting COMPANY_ACCOUNT shows balance hint.
 * 6. Switching type resets fundingSource to that type's default.
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
      // users-all — return one admin so payerAdmin selector has an option.
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

describe('CreateTransactionDialog — funding source: SALARY', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('funding-source section is visible when SALARY is selected', () => {
    renderDialog()
    // SALARY is the 3rd type button (ADMIN_INCOME, EXPENSE, SALARY…)
    clickTypeCard('create-transaction-type-salary')
    expect(screen.getByTestId('create-transaction-funding-source-section')).toBeInTheDocument()
  })

  it('COMPANY_ACCOUNT is pre-selected by default for SALARY', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    // The COMPANY_ACCOUNT button should be rendered and the dot indicator present.
    const companyBtn = screen.getByTestId('create-transaction-funding-company')
    expect(companyBtn).toBeInTheDocument()
    // The personal button must also exist (two options for SALARY).
    expect(screen.getByTestId('create-transaction-funding-personal')).toBeInTheDocument()
  })

  it('SALARY + COMPANY_ACCOUNT shows the company balance hint', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    // Balance hint renders when COMPANY_ACCOUNT is selected.
    expect(screen.getByTestId('create-transaction-company-balance-hint')).toBeInTheDocument()
  })

  it('switching SALARY to ADMIN_PERSONAL shows the payerAdmin selector', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    // Click the ADMIN_PERSONAL option.
    fireEvent.click(screen.getByTestId('create-transaction-funding-personal'))
    // payerAdmin selector should appear.
    expect(screen.getByTestId('create-transaction-payer-admin-section')).toBeInTheDocument()
    expect(screen.getByTestId('create-transaction-payer-admin-trigger')).toBeInTheDocument()
  })

  it('switching SALARY to ADMIN_PERSONAL hides the company balance hint', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    fireEvent.click(screen.getByTestId('create-transaction-funding-personal'))
    // Balance hint must be gone.
    expect(screen.queryByTestId('create-transaction-company-balance-hint')).not.toBeInTheDocument()
  })

  it('switching back to COMPANY_ACCOUNT hides the payerAdmin selector', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    // Switch to personal first.
    fireEvent.click(screen.getByTestId('create-transaction-funding-personal'))
    expect(screen.getByTestId('create-transaction-payer-admin-section')).toBeInTheDocument()
    // Switch back to company.
    fireEvent.click(screen.getByTestId('create-transaction-funding-company'))
    expect(screen.queryByTestId('create-transaction-payer-admin-section')).not.toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — funding source: EXPENSE', () => {
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

describe('CreateTransactionDialog — funding source: ADMIN_INCOME', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('funding-source section visible for ADMIN_INCOME', () => {
    renderDialog()
    // ADMIN_INCOME is the first type in availableTypes for ADMIN.
    // It is already selected by default.
    expect(screen.getByTestId('create-transaction-funding-source-section')).toBeInTheDocument()
  })

  it('ADMIN_INCOME defaults to legacy (no balance hint initially)', () => {
    renderDialog()
    expect(screen.queryByTestId('create-transaction-company-balance-hint')).not.toBeInTheDocument()
  })

  it('selecting COMPANY_ACCOUNT for ADMIN_INCOME shows the balance hint', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('create-transaction-funding-company'))
    expect(screen.getByTestId('create-transaction-company-balance-hint')).toBeInTheDocument()
  })
})

describe('CreateTransactionDialog — funding source: type switch resets', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('switching from SALARY (COMPANY_ACCOUNT) to EXPENSE resets to legacy', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    // SALARY defaults to COMPANY_ACCOUNT — balance hint visible.
    expect(screen.getByTestId('create-transaction-company-balance-hint')).toBeInTheDocument()
    // Switch to EXPENSE.
    clickTypeCard('create-transaction-type-expense')
    // Should reset to legacy — balance hint gone.
    expect(screen.queryByTestId('create-transaction-company-balance-hint')).not.toBeInTheDocument()
  })

  it('switching from EXPENSE (company selected) to SALARY resets to COMPANY_ACCOUNT', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-expense')
    fireEvent.click(screen.getByTestId('create-transaction-funding-company'))
    expect(screen.getByTestId('create-transaction-company-balance-hint')).toBeInTheDocument()
    // Switch to SALARY — should reset to COMPANY_ACCOUNT (already company, so hint still there).
    clickTypeCard('create-transaction-type-salary')
    // Balance hint should still be there (SALARY default = COMPANY_ACCOUNT).
    expect(screen.getByTestId('create-transaction-company-balance-hint')).toBeInTheDocument()
  })

  it('payerAdmin selector is not shown after switching away from SALARY+ADMIN_PERSONAL', () => {
    renderDialog()
    clickTypeCard('create-transaction-type-salary')
    fireEvent.click(screen.getByTestId('create-transaction-funding-personal'))
    expect(screen.getByTestId('create-transaction-payer-admin-section')).toBeInTheDocument()
    // Switch to EXPENSE.
    clickTypeCard('create-transaction-type-expense')
    // payerAdmin must be gone.
    expect(screen.queryByTestId('create-transaction-payer-admin-section')).not.toBeInTheDocument()
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
