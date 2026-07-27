/**
 * PayoutDetailDialog.test.tsx — task-payout-company-ui WS2.
 *
 * Pins the Phase 8 v2 redesign ACs that are role-sensitive (and therefore
 * security-relevant) plus the instruction-card wiring:
 *
 *   - The company wallet address (payout.contractAddress) + payable amount are
 *     rendered for the payer (SENIOR/DROP) — this is the "куда / сколько" they
 *     must see to perform the transfer.
 *   - The «Ручное подтверждение» section is visible ONLY to ADMIN / ACCOUNTANT
 *     and hidden for SENIOR / DROP / JUNIOR / HR. The backend re-checks RBAC,
 *     but the UI must not even render the escape hatch for unprivileged roles.
 *   - The COMPANY_ACCOUNT method (default) shows the «кредитует баланс счёта
 *     компании» hint.
 *
 * Strategy mirrors CreateTransactionDialog.accountant.test.tsx: mock
 * auth/router/sonner and the query/mutation hooks so the dialog renders without
 * a network. The payout query data is injected via the mocked useQuery.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PayoutRequestDto } from '@crm/shared'

// ── Mutable auth role so each test can pick the persona ─────────────────────
let currentRole = 'SENIOR'
vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', role: currentRole, displayName: 'Tester' } }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// `vi.hoisted` so the fixture is available inside the hoisted `vi.mock` factory
// below (top-level consts are NOT — they initialise after the hoisted mocks).
const { PAYOUT } = vi.hoisted(() => ({
  PAYOUT: {
    id: '00000000-0000-4000-a000-000000000010',
    seniorId: 'user-1',
    seniorName: 'Tester',
    incomeAmount: '5000',
    payableAmount: '1300',
    contractAddress: '0xCompanyWallet000000000000000000000000aaaa',
    txHash: null,
    txFromAddress: null,
    status: 'PENDING',
    transactions: [],
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
  } satisfies PayoutRequestDto,
}))

// Real hooks replaced with stubs: useQuery returns the payout; mutation/qc inert.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({ data: PAYOUT, isLoading: false, isError: false }),
    useQueryClient: vi
      .fn()
      .mockReturnValue({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
    useMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false, error: null }),
  }
})

import { PayoutDetailDialog } from '../PayoutDetailDialog'

function renderDialog() {
  return render(<PayoutDetailDialog open onClose={() => {}} payoutId={PAYOUT.id} />)
}

const PRIVILEGED = ['ADMIN', 'ACCOUNTANT'] as const
const UNPRIVILEGED = ['SENIOR', 'DROP', 'JUNIOR', 'HR'] as const

describe('PayoutDetailDialog — instruction card (payer surface)', () => {
  beforeEach(() => {
    currentRole = 'SENIOR'
  })

  it('renders the company wallet address (copyable) and payable amount', () => {
    renderDialog()
    expect(screen.getByTestId('payout-detail-contract-address')).toHaveTextContent(
      PAYOUT.contractAddress,
    )
    expect(screen.getByTestId('payout-detail-copy-address')).toBeInTheDocument()
    expect(screen.getByTestId('payout-detail-payable')).toBeInTheDocument()
    expect(screen.getByTestId('payout-detail-tx-hash-input')).toBeInTheDocument()
  })
})

describe('PayoutDetailDialog — manual-confirm section RBAC (WS2)', () => {
  it.each(PRIVILEGED)('%s sees the manual-confirm section', (role) => {
    currentRole = role
    renderDialog()
    expect(screen.getByTestId('payout-detail-manual-section')).toBeInTheDocument()
    // All three methods present.
    expect(screen.getByTestId('payout-detail-manual-method-cash')).toBeInTheDocument()
    expect(screen.getByTestId('payout-detail-manual-method-admin_usdt')).toBeInTheDocument()
    expect(screen.getByTestId('payout-detail-manual-method-company_account')).toBeInTheDocument()
    expect(screen.getByTestId('payout-detail-manual-submit')).toBeInTheDocument()
  })

  it.each(UNPRIVILEGED)('%s does NOT see the manual-confirm section', (role) => {
    currentRole = role
    renderDialog()
    expect(screen.queryByTestId('payout-detail-manual-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('payout-detail-manual-submit')).not.toBeInTheDocument()
  })

  it('COMPANY_ACCOUNT (default) shows the balance-credit hint', () => {
    currentRole = 'ADMIN'
    renderDialog()
    expect(screen.getByText(/кредитует баланс счёта компании/i)).toBeInTheDocument()
  })
})
