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
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { PayoutRequestDto, TransactionDto } from '@crm/shared'

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
    // Explicit TransactionDto[] (not inferred never[] from `[]` under
    // `satisfies`) — the DROP re-audit describe block below reassigns this
    // per-test with real fixtures.
    transactions: [] as TransactionDto[],
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

function makeDropIncomeTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'drop-income-1',
    type: 'DROP_INCOME',
    status: 'PENDING_PAYMENT',
    amount: '500',
    currency: 'USDT',
    senderId: null,
    senderName: null,
    senderLabel: 'Client Co',
    receiverId: 'drop-1-id',
    receiverName: 'Drop',
    receiverLabel: null,
    seniorSharePercent: null,
    seniorSharePercentSource: null,
    dropSharePercent: 5,
    dropSharePercentSource: 'USER_DEFAULT',
    projectId: '00000000-0000-4000-b000-000000000001',
    projectName: 'Drop Project',
    receiptDocumentId: null,
    receiptExternalUrl: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    txHash: null,
    rejectionReason: null,
    payoutRequestId: PAYOUT.id,
    validatedBy: 'accountant-1',
    validatedAt: '2026-07-01T00:00:00.000Z',
    createdBy: 'drop-1-id',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function makePayoutLedgerTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    ...makeDropIncomeTx(),
    id: 'payout-ledger-row',
    type: 'PAYOUT',
    projectId: null,
    projectName: null,
    seniorSharePercent: null,
    dropSharePercent: null,
    senderId: 'drop-1-id',
    receiverId: null,
    receiverLabel: 'CheekyCheeseIT',
    ...overrides,
  }
}

describe('PayoutDetailDialog — «Транзакции в выплате» list, DROP payouts (fidelity-review re-audit)', () => {
  // PayoutPaymentForm's income-list filter was SENIOR_INCOME-only (PR #56
  // legacy) — silently empty for a DROP's own payout, same root cause as the
  // step-2 summary line's project-count bug (both derive from
  // `payout.transactions`, which is type-mixed). Fixed to the generic
  // `isIncomeTransaction` filter; this pins the DROP half with an exact
  // VALUE assertion, not just "the section exists".
  const originalTransactions = PAYOUT.transactions

  afterEach(() => {
    // vi.hoisted const object — restore the shared fixture's mutable field
    // so this describe block cannot leak state into other test files.
    PAYOUT.transactions = originalTransactions
  })

  it('shows the DROP_INCOME rows with the correct count — not empty, not the SENIOR_INCOME-only count', () => {
    currentRole = 'DROP'
    PAYOUT.transactions = [
      makeDropIncomeTx({ id: 'drop-income-1' }),
      makeDropIncomeTx({ id: 'drop-income-2', amount: '300' }),
      // The PAYOUT ledger row itself — must NOT be counted as a 3rd row.
      makePayoutLedgerTx(),
    ]
    renderDialog()
    expect(screen.getByTestId('payout-detail-transactions-count')).toHaveTextContent(
      'Транзакции в выплате (2)',
    )
    expect(screen.getByTestId('payout-detail-tx-drop-income-1')).toBeInTheDocument()
    expect(screen.getByTestId('payout-detail-tx-drop-income-2')).toBeInTheDocument()
    expect(screen.queryByTestId('payout-detail-tx-payout-ledger-row')).not.toBeInTheDocument()
  })
})
