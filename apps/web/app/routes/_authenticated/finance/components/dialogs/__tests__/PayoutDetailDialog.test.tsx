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
    txFromAddress: null,
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

// task-split-payouts-and-obligations (backlog 174). `settleByCompany` flips a
// cascade-booked SENIOR_PENDING_PAYOUT IN PLACE to SENIOR_INCOME (status=PAID)
// and RESETS its own `payoutRequestId` to null (task-settle-in-place ADR) —
// `findPayoutRequest` re-attaches it to this payout's `transactions` array via
// the SEPARATE `pending_obligations.payoutRequestId` column instead. The row
// therefore now matches `isIncomeTransaction` (SENIOR_INCOME) but carries the
// OPPOSITE money direction (COMPANY → recipient, not recipient → COMPANY) of
// a genuinely bundled income. `payoutRequestId !== payout.id` is what tells
// the two apart.
function makeObligationTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    ...makeDropIncomeTx(),
    id: 'obligation-1',
    type: 'SENIOR_INCOME',
    status: 'PAID',
    // The defining trait: settleByCompany reset this to null — it is NOT
    // this payout's own bundled income, however it got attached here.
    payoutRequestId: null,
    receiverId: 'senior-owed-1',
    receiverName: 'Иван Синьоров',
    senderLabel: 'COMPANY',
    projectName: 'Drop Project',
    seniorSharePercent: null,
    dropSharePercent: null,
    ...overrides,
  }
}

describe('PayoutDetailDialog — obligations split (task-split-payouts-and-obligations, backlog 174)', () => {
  const originalTransactions = PAYOUT.transactions

  afterEach(() => {
    PAYOUT.transactions = originalTransactions
  })

  it('a recovered company obligation is excluded from the income counter and rendered in its own section, with the correct direction', () => {
    currentRole = 'ADMIN'
    PAYOUT.transactions = [
      makeDropIncomeTx({ id: 'drop-income-1' }), // genuinely bundled — payoutRequestId === PAYOUT.id
      makeObligationTx({ id: 'obligation-1', receiverName: 'Иван Синьоров', amount: '130' }),
    ]
    renderDialog()

    // "Транзакции в выплате" counts ONLY the genuinely bundled row.
    expect(screen.getByTestId('payout-detail-transactions-count')).toHaveTextContent(
      'Транзакции в выплате (1)',
    )
    expect(screen.getByTestId('payout-detail-tx-drop-income-1')).toBeInTheDocument()
    expect(screen.queryByTestId('payout-detail-tx-obligation-1')).not.toBeInTheDocument()

    // The obligation renders separately, with an explicit direction label —
    // said ONCE, in the section title + caption (design-audit PR #592 HIGH:
    // repeating "Компания должна" per row ate the mobile-width budget the
    // recipient's actual NAME needed — see the row assertion below).
    expect(screen.getByTestId('payout-detail-obligations-count')).toHaveTextContent(
      'Обязательства компании (1)',
    )
    expect(screen.getByTestId('payout-detail-obligations-caption')).toHaveTextContent(
      'Компания должна эти суммы — они не входят в выплату выше',
    )
    const row = screen.getByTestId('payout-detail-obligation-obligation-1')
    expect(row).toHaveTextContent('Иван Синьоров')
    // Regression guard for the design-audit HIGH: the per-row prefix must
    // NOT come back — it is what caused the name to truncate to nothing on
    // 320px (measured: prefix alone consumed the column's ~118px budget).
    expect(row).not.toHaveTextContent('Компания должна')
    expect(row).toHaveTextContent('130')
  })

  it('with only a recovered obligation (no genuine income) the income counter does not render at all', () => {
    currentRole = 'ADMIN'
    PAYOUT.transactions = [makeObligationTx({ id: 'obligation-only' })]
    renderDialog()

    expect(screen.queryByTestId('payout-detail-transactions-count')).not.toBeInTheDocument()
    expect(screen.getByTestId('payout-detail-obligations-count')).toHaveTextContent(
      'Обязательства компании (1)',
    )
    expect(screen.getByTestId('payout-detail-obligation-obligation-only')).toBeInTheDocument()
  })

  it('with only genuine incomes (no obligation) the obligations section does not render at all', () => {
    currentRole = 'ADMIN'
    PAYOUT.transactions = [makeDropIncomeTx({ id: 'drop-income-only' })]
    renderDialog()

    expect(screen.getByTestId('payout-detail-transactions-count')).toHaveTextContent(
      'Транзакции в выплате (1)',
    )
    expect(screen.queryByTestId('payout-detail-obligations-count')).not.toBeInTheDocument()
  })

  it('renders the recipient dash-fallback on its own — a null receiverName does not silently render empty', () => {
    // Deliberately NOT combined with a null projectName in the same fixture:
    // both fields fall back to the SAME '—' glyph, and `row.textContent`
    // concatenates sibling <p> elements with no separator — a null
    // projectName's correct dash would sit immediately after an EMPTY
    // (bugged) receiverName slot and accidentally satisfy a substring check
    // meant for the receiver. Keeping them in separate tests, each with the
    // OTHER field non-null, makes each assertion unambiguous.
    currentRole = 'ADMIN'
    const obligationTx = makeObligationTx({
      id: 'obligation-recv-null',
      receiverName: null,
      projectName: 'Unambiguous Project',
    })
    PAYOUT.transactions = [obligationTx]
    renderDialog()

    const row = screen.getByTestId('payout-detail-obligation-obligation-recv-null')
    expect(row).toHaveTextContent('—')
    expect(row).toHaveTextContent('Unambiguous Project')
    // Regression guard (design-audit PR #592 HIGH) — see the note on the
    // previous test for why this string must never reappear per row.
    expect(row).not.toHaveTextContent('Компания должна')
  })

  it('renders the obligation row fields precisely — project dash-fallback, sliced id, createdAt date-fallback, status badge', () => {
    currentRole = 'ADMIN'
    const obligationTx = makeObligationTx({
      id: 'obligation-long-id-1',
      receiverName: 'Иван Синьоров',
      // null exercises the '—' fallback — distinguishes `?? '—'` from a
      // `&&` mutant, which would render nothing (falsy) instead.
      projectName: null,
      // null exercises the createdAt fallback — distinguishes `?? createdAt`
      // from a `&&` mutant, which would resolve to `null` (epoch date).
      txDate: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      status: 'PAID',
    })
    PAYOUT.transactions = [obligationTx]
    renderDialog()

    const row = screen.getByTestId('payout-detail-obligation-obligation-long-id-1')
    const expectedDate = new Date(obligationTx.createdAt).toLocaleDateString('ru-RU')
    // Dash fallback + a REAL space between "от" and the date + the date
    // itself computed from createdAt (txDate is null). receiverName is a
    // real (non-dash) name here, so this substring is unambiguous — see the
    // note on the previous test for why the two dash-fallbacks are split.
    expect(row).toHaveTextContent(`— · #obliga от ${expectedDate}`)
    // Sliced id: exactly the first 6 chars — the full id must NOT appear
    // verbatim (kills the `.id` (unsliced) mutant).
    expect(row.textContent).not.toContain('obligation-long-id-1')

    const badge = screen.getByTestId('payout-detail-obligation-status-obligation-long-id-1')
    expect(badge).toHaveTextContent('Оплачено')
  })

  it('gracefully handles a payout with no transactions field (optional in the DTO) — no crash, neither section renders', () => {
    currentRole = 'ADMIN'
    // `transactions` is optional on PayoutRequestDto — this exercises that
    // branch directly (kills the `payout.transactions?.filter` OptionalChaining
    // mutants: without `?.` this would throw instead of rendering nothing).
    ;(PAYOUT as { transactions?: TransactionDto[] | undefined }).transactions = undefined
    renderDialog()

    expect(screen.queryByTestId('payout-detail-transactions-count')).not.toBeInTheDocument()
    expect(screen.queryByTestId('payout-detail-obligations-count')).not.toBeInTheDocument()
    // Sanity: the rest of the dialog still renders — no crash.
    expect(screen.getByTestId('payout-detail-payable')).toBeInTheDocument()
  })

  it('a long recipient name is preserved in full and wraps rather than being cut off (design-audit PR #592 HIGH)', () => {
    // Real pixel-level proof (getBoundingClientRect on a live 320px DOM) is
    // what the design audit used — jsdom/happy-dom (this test's environment)
    // does not run a real layout engine, so it cannot reproduce that
    // measurement. What CAN be pinned deterministically here, and is exactly
    // the regression this finding warned about ("следующая правка вёрстки
    // сломает молча"), is the CODE-LEVEL contract the fix relies on:
    //   1. the full name is in the DOM verbatim — nothing truncates it at
    //      the string/JS level (a future `.slice()`/prefix reintroduction
    //      would fail this);
    //   2. the name element wraps (`line-clamp-2`) rather than clipping with
    //      an ellipsis (`truncate`) — swapping back to `truncate` is the
    //      exact regression the HIGH finding was about, and this assertion
    //      fails loudly if that happens.
    // A live 320/375px screenshot was additionally taken by hand against a
    // temporary dev harness (not committed, mirroring the auditor's own
    // methodology) to confirm the rendered result — see the PR thread.
    currentRole = 'ADMIN'
    const longName = 'Олександр-Максиміліан Найдовшепрізвищенко-Компанійський'
    const obligationTx = makeObligationTx({ id: 'obligation-long-name', receiverName: longName })
    PAYOUT.transactions = [obligationTx]
    renderDialog()

    const row = screen.getByTestId('payout-detail-obligation-obligation-long-name')
    expect(row).toHaveTextContent(longName)
    const nameEl = screen.getByTestId('payout-detail-obligation-name-obligation-long-name')
    expect(nameEl).toHaveTextContent(longName)
    expect(nameEl).toHaveClass('line-clamp-2')
    expect(nameEl).not.toHaveClass('truncate')
  })
})
