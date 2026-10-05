/**
 * CompanySharePayoutModal.test.tsx — task-company-share-cta.
 *
 * Covers (AC references from the task file):
 *   - AC2: project checkbox toggles all its incomes; individual income
 *     checkboxes toggle independently; live total recomputes; empty
 *     selection disables submit.
 *   - AC3: after a successful create the modal does NOT close — it switches
 *     to the step-2 payment form for the freshly-created payout.
 *   - AC4: closing on step 2 does not attempt to roll back / cancel the
 *     already-created payout request (no DELETE-ish call is made).
 *   - AC5: the create button disables while the mutation is in flight, so a
 *     second click cannot fire a second `createPayoutRequest` call.
 *
 * Strategy mirrors `PaySalaryDialog.test.tsx`: keep the REAL
 * `@tanstack/react-query` hooks (fresh `QueryClientProvider` per render) so
 * `createMutation.mutate()` genuinely runs the component's own mutationFn;
 * only the API boundary (`../../../api`) and `@/context/auth` are mocked.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { toast } from 'sonner'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PayoutRequestDto, TransactionDto } from '@crm/shared'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

let currentUser: { id: string; role: string; seniorSharePercent: number } = {
  id: 'senior-1',
  role: 'SENIOR',
  seniorSharePercent: 26,
}
vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: currentUser }),
}))

const createPayoutRequestMock = vi.fn()
const getPayoutRequestMock = vi.fn()

vi.mock('../../../api', () => ({
  financeApi: {
    createPayoutRequest: (...args: unknown[]) => createPayoutRequestMock(...args),
    getPayoutRequest: (...args: unknown[]) => getPayoutRequestMock(...args),
    payPayoutRequest: vi.fn().mockResolvedValue({}),
    manualConfirmPayout: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/components/ui/date-picker', () => ({
  DatePickerField: ({
    value,
    onChange,
    minDate,
    id,
    'aria-describedby': ariaDescribedBy,
    'data-testid': dataTestId,
  }: {
    value: string
    onChange: (value: string) => void
    minDate?: string
    id?: string
    'aria-describedby'?: string
    'data-testid'?: string
  }) => (
    <input
      id={id}
      type="date"
      value={value}
      min={minDate}
      aria-describedby={ariaDescribedBy}
      data-testid={dataTestId}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

import { CompanySharePayoutModal } from '../CompanySharePayoutModal'

const PROJECT_A = '00000000-0000-4000-b000-00000000000a'
const PROJECT_B = '00000000-0000-4000-b000-00000000000b'

function makeTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'tx-1',
    type: 'SENIOR_INCOME',
    status: 'VALIDATED',
    amount: '1000',
    currency: 'USDT',
    senderId: null,
    senderName: null,
    senderLabel: 'Client Co',
    receiverId: 'senior-1',
    receiverName: 'Senior',
    receiverLabel: null,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'USER_DEFAULT',
    dropSharePercent: null,
    dropSharePercentSource: null,
    projectId: PROJECT_A,
    projectName: 'Project Alpha',
    receiptDocumentId: null,
    receiptExternalUrl: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    txHash: null,
    txFromAddress: null,
    rejectionReason: null,
    payoutRequestId: null,
    validatedBy: 'accountant-1',
    validatedAt: '2026-07-01T00:00:00.000Z',
    createdBy: 'senior-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

const TX_A1 = makeTx({
  id: 'a1',
  projectId: PROJECT_A,
  projectName: 'Project Alpha',
  amount: '400',
})
const TX_A2 = makeTx({
  id: 'a2',
  projectId: PROJECT_A,
  projectName: 'Project Alpha',
  amount: '240',
})
const TX_B1 = makeTx({ id: 'b1', projectId: PROJECT_B, projectName: 'Project Beta', amount: '360' })

function makePayout(overrides: Partial<PayoutRequestDto> = {}): PayoutRequestDto {
  return {
    id: 'payout-1',
    seniorId: 'senior-1',
    seniorName: 'Senior',
    incomeAmount: '1000',
    payableAmount: '740',
    contractAddress: '0xCompanyWallet0000000000000000000000aaaa',
    txHash: null,
    txFromAddress: null,
    status: 'PENDING',
    transactions: [],
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(async () => {
  await loadCatalog('uk')
})

function renderModal(props: Partial<Parameters<typeof CompanySharePayoutModal>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CompanySharePayoutModal
        open
        onClose={vi.fn()}
        validatedTxs={[TX_A1, TX_A2, TX_B1]}
        {...props}
      />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

describe('CompanySharePayoutModal — step 1 selection (AC2)', () => {
  beforeEach(() => {
    currentUser = { id: 'senior-1', role: 'SENIOR', seniorSharePercent: 26 }
    createPayoutRequestMock.mockReset()
    getPayoutRequestMock.mockReset()
  })

  it('defaults to everything selected when opened with no preselection (design spec §6.6)', () => {
    renderModal()
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A1.id}`)).toBeChecked()
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A2.id}`)).toBeChecked()
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_B1.id}`)).toBeChecked()
    expect(screen.getByTestId('company-share-create-payout')).not.toBeDisabled()
  })

  it('submits today as the payout date by default', async () => {
    const oldTx = makeTx({
      id: 'old-date',
      projectId: PROJECT_A,
      projectName: 'Project Alpha',
      txDate: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
    createPayoutRequestMock.mockResolvedValue(makePayout())
    getPayoutRequestMock.mockResolvedValue(makePayout())

    renderModal({ validatedTxs: [oldTx], preselectedTxIds: [oldTx.id] })

    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    fireEvent.click(screen.getByTestId('company-share-create-payout'))
    await waitFor(() =>
      expect(createPayoutRequestMock).toHaveBeenLastCalledWith({
        transactionIds: [oldTx.id],
        txDate: today,
      }),
    )
  })

  it('zero-pads a single-digit local month and day in the default payout date', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 2, 4, 12, 0, 0))
      const oldTx = makeTx({
        id: 'old-date-padding',
        txDate: '2020-01-01T00:00:00.000Z',
        createdAt: '2020-01-01T00:00:00.000Z',
      })
      createPayoutRequestMock.mockResolvedValue(makePayout())
      getPayoutRequestMock.mockResolvedValue(makePayout())
      renderModal({ validatedTxs: [oldTx], preselectedTxIds: [oldTx.id] })
      fireEvent.click(screen.getByTestId('company-share-create-payout'))
      await vi.runAllTimersAsync()
      expect(createPayoutRequestMock).toHaveBeenCalledWith({
        transactionIds: [oldTx.id],
        txDate: '2026-03-04',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('clamps the payout date when selection raises the minimum', async () => {
    const oldTx = makeTx({
      id: 'old-date',
      projectId: PROJECT_A,
      projectName: 'Project Alpha',
      txDate: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
    const futureTx = makeTx({
      id: 'future-date',
      projectId: PROJECT_B,
      projectName: 'Project Beta',
      txDate: '2099-01-10T00:00:00.000Z',
      createdAt: '2099-01-10T00:00:00.000Z',
    })
    createPayoutRequestMock.mockResolvedValue(makePayout())
    getPayoutRequestMock.mockResolvedValue(makePayout())

    renderModal({ validatedTxs: [oldTx, futureTx], preselectedTxIds: [oldTx.id] })
    fireEvent.click(screen.getByTestId(`company-share-income-checkbox-${futureTx.id}`))
    const date = screen.getByTestId('company-share-payout-date')
    await waitFor(() => expect(date).toHaveValue('2099-01-10'))
    expect(date).toHaveAttribute('min', '2099-01-10')
    expect(date).toHaveAttribute('aria-describedby', 'company-share-payout-date-helper')
    expect(screen.getByText(/Найраніша доступна дата/).textContent).toBe(
      'Найраніша доступна дата — 10.01.2099.',
    )
    fireEvent.click(screen.getByTestId('company-share-create-payout'))
    await waitFor(() =>
      expect(createPayoutRequestMock).toHaveBeenLastCalledWith({
        transactionIds: [oldTx.id, futureTx.id],
        txDate: '2099-01-10',
      }),
    )
  })

  it('uses txDate rather than createdAt when calculating the selected minimum', async () => {
    const tx = makeTx({
      id: 'date-precedence',
      txDate: '2099-05-06T00:00:00.000Z',
      createdAt: '2099-12-31T00:00:00.000Z',
    })
    renderModal({ validatedTxs: [tx], preselectedTxIds: [tx.id] })
    const date = screen.getByTestId('company-share-payout-date')
    await waitFor(() => expect(date).toHaveValue('2099-05-06'))
    expect(date).toHaveAttribute('min', '2099-05-06')
  })

  it('keeps the latest selected transaction date regardless of transaction order', async () => {
    const future = makeTx({
      id: 'future-first',
      txDate: '2099-05-06T00:00:00.000Z',
      createdAt: '2099-05-06T00:00:00.000Z',
    })
    const old = makeTx({
      id: 'old-second',
      txDate: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
    renderModal({
      validatedTxs: [future, old],
      preselectedTxIds: [future.id, old.id],
    })
    const date = screen.getByTestId('company-share-payout-date')
    await waitFor(() => expect(date).toHaveValue('2099-05-06'))
    expect(date).toHaveAttribute('min', '2099-05-06')
  })

  it('removes the date bound and helper when the selection becomes empty', () => {
    renderModal({ validatedTxs: [TX_A1], preselectedTxIds: [TX_A1.id] })
    const date = screen.getByTestId('company-share-payout-date')
    expect(date).toHaveAttribute('min', '2026-07-01')
    fireEvent.click(screen.getByTestId(`company-share-income-checkbox-${TX_A1.id}`))
    expect(date).not.toHaveAttribute('min')
    expect(date).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByText(/Найраніша доступна дата/)).not.toBeInTheDocument()
  })

  it('a single row-level preselect selects ONLY that income (unchanged from old PayoutDialog)', () => {
    renderModal({ preselectedTxIds: [TX_A1.id] })
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A1.id}`)).toBeChecked()
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A2.id}`)).not.toBeChecked()
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_B1.id}`)).not.toBeChecked()
  })

  it('unchecking every income disables submit', () => {
    renderModal()
    fireEvent.click(screen.getByTestId(`company-share-income-checkbox-${TX_A1.id}`))
    fireEvent.click(screen.getByTestId(`company-share-income-checkbox-${TX_A2.id}`))
    fireEvent.click(screen.getByTestId(`company-share-income-checkbox-${TX_B1.id}`))
    expect(screen.getByTestId('company-share-create-payout')).toBeDisabled()
  })

  it('the project checkbox toggles ALL of its incomes together', () => {
    renderModal({ preselectedTxIds: [TX_A1.id] }) // start with only a1 checked
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A1.id}`)).toBeChecked()
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A2.id}`)).not.toBeChecked()

    // Project A checkbox is indeterminate (partial) — clicking it selects ALL.
    fireEvent.click(screen.getByTestId(`company-share-project-checkbox-${PROJECT_A}`))
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A1.id}`)).toBeChecked()
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A2.id}`)).toBeChecked()
    // Project B is untouched by toggling project A.
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_B1.id}`)).not.toBeChecked()

    // Clicking again (now fully-selected) deselects ALL of project A's incomes.
    fireEvent.click(screen.getByTestId(`company-share-project-checkbox-${PROJECT_A}`))
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A1.id}`)).not.toBeChecked()
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A2.id}`)).not.toBeChecked()
  })

  it('individual income checkboxes toggle independently of the project checkbox', () => {
    renderModal()
    fireEvent.click(screen.getByTestId(`company-share-income-checkbox-${TX_A1.id}`))
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A1.id}`)).not.toBeChecked()
    expect(screen.getByTestId(`company-share-income-checkbox-${TX_A2.id}`)).toBeChecked()
  })

  it('the live total recomputes when selection changes (payable, not gross)', () => {
    renderModal({ preselectedTxIds: [TX_A1.id] }) // only 400 * 0.74 = 296
    const total1 = screen.getByTestId('company-share-selection-total')
    expect(total1).toHaveTextContent('296')
    // task-i18n-stage3d-pr4 (mutation-gate): pins the exact «Загальна сума»
    // and «Залишається вам» lines too, not just the payable figure — kills
    // the `totalIncome`/`totalOwn` reduce mutants that a payable-only
    // assertion cannot distinguish (400 income, 400-296=104 kept). Also
    // rules out the SIGN of the reduce (a `sum - x` mutant on a
    // single-element array renders "-400,00", which a plain SUBSTRING
    // match against "400,00" would not catch).
    expect(total1).toHaveTextContent('400,00')
    expect(total1).not.toHaveTextContent('-400,00')
    expect(total1).toHaveTextContent('104,00')
    expect(total1).not.toHaveTextContent('-104,00')
    // Single income, single project — the exact singular plural forms.
    expect(total1).toHaveTextContent('1 дохід · 1 проєкт')

    fireEvent.click(screen.getByTestId(`company-share-income-checkbox-${TX_A2.id}`))
    // 400+240 = 640 * 0.74 = 473.60
    const total2 = screen.getByTestId('company-share-selection-total')
    expect(total2).toHaveTextContent('473,60')
    // Two incomes, still one project (both A1/A2 are Project Alpha) — a
    // mutant on the `.map((tx) => tx.projectId)` array feeding the project
    // Plural count would turn this Set to size 1 regardless, same as one
    // income; the count STAYING at "1 проєкт" while incomes go to "2
    // прибутки" is exactly what distinguishes the two counts.
    expect(total2).toHaveTextContent('2 доходи · 1 проєкт')
  })

  // task-i18n-stage3d-pr4 (mutation-gate): a THIRD income from a DIFFERENT
  // project — the case the two-income test above cannot reach (A1+A2 are
  // both Project Alpha, so their Set-of-projectId size never leaves 1). A
  // mutant collapsing `.map((tx) => tx.projectId)` to `() => undefined`
  // would still report "1 проєкт" here too; the real count is 2.
  it('the project count in the selection total reflects TWO distinct projects when all three fixtures are selected', () => {
    renderModal() // defaults to all three selected: A1+A2 (Project Alpha), B1 (Project Beta)
    expect(screen.getByTestId('company-share-selection-total')).toHaveTextContent(
      '3 доходи · 2 проєкти',
    )
  })

  it('shows the mixed-currency breakdown (with its own project/income counts) when selected incomes span more than one currency', () => {
    // task-i18n-stage3d-pr4 (mutation-gate): TX_A1/A2/B1 (the shared
    // fixtures) are all USDT, so no existing test ever exercises
    // `hasMixedCurrencies`/`selectedCurrencies` — a mutant collapsing the
    // `.map((tx) => tx.currency)` callback to `() => undefined` produces the
    // SAME Set size (1) on an all-USDT selection and survives undetected.
    const eurTx = makeTx({
      id: 'eur-1',
      projectId: PROJECT_B,
      projectName: 'Project Beta',
      amount: '100',
      currency: 'EUR',
    })
    renderModal({
      validatedTxs: [TX_A1, eurTx],
      preselectedTxIds: [TX_A1.id, eurTx.id],
    })
    const total = screen.getByTestId('company-share-selection-total')
    expect(total).toHaveTextContent('Розбивка за валютами')
    expect(total).toHaveTextContent('2 доходи · 2 проєкти')
    expect(total).toHaveTextContent('EUR')
  })

  it('groups projects (from different projects) as separate cards', () => {
    renderModal()
    expect(screen.getByTestId(`company-share-project-checkbox-${PROJECT_A}`)).toBeInTheDocument()
    expect(screen.getByTestId(`company-share-project-checkbox-${PROJECT_B}`)).toBeInTheDocument()
  })

  // task-i18n-stage3d-pr4 (mutation-gate). Project Alpha's own row total —
  // 400 (TX_A1) + 240 (TX_A2) = 640.00 — pins the `reduce` inside
  // `ProjectRow`, which the selection-total tests above cannot reach (they
  // only exercise the PAYABLE figure downstream of `buildPreviewRows`, a
  // different code path entirely).
  it("shows each project's own income total (not the payable amount) next to its checkbox", () => {
    renderModal()
    const projectARow = screen.getByTestId(`company-share-project-row-${PROJECT_A}`)
    expect(projectARow).toHaveTextContent('640,00')
    // Rules out the SIGN of the `reduce` (a `sum - x` mutant on a
    // 2-element array still yields a number whose digits contain "640,00"
    // as a substring — "-640,00" — so the positive-only check above alone
    // would not catch it).
    expect(projectARow).not.toHaveTextContent('-640,00')
  })

  // task-i18n-stage3d-pr4 (mutation-gate). Both the checkbox `aria-label`
  // and the visible `<Trans>` line read the SAME `tx.txDate ?? tx.createdAt`
  // date — TX_A1 has `txDate: null`, so this also pins the `??` (not `&&`):
  // `null && tx.createdAt` would format `new Date(null)` (1970-01-01)
  // instead of the real `createdAt` (2026-07-01).
  it("shows an income row's creation date (txDate is null, falls back to createdAt) in the aria-label and the visible text", () => {
    renderModal()
    const incomeCheckbox = screen.getByTestId(`company-share-income-checkbox-${TX_A1.id}`)
    expect(incomeCheckbox.getAttribute('aria-label')).toBe('Дохід від 01.07.26')
    expect(screen.getByTestId(`company-share-income-date-${TX_A1.id}`)).toHaveTextContent(
      'Дохід від 01.07.26',
    )
  })

  // task-i18n-stage3d-pr4 (mutation-gate). Pins the actual aria-label text
  // of the project checkbox (a StringLiteral mutant collapsing it to "" is
  // invisible to `toBeInTheDocument`/`toBeChecked` checks elsewhere in this
  // file).
  it("shows a project checkbox's aria-label naming the project", () => {
    renderModal()
    const projectACheckbox = screen.getByTestId(`company-share-project-checkbox-${PROJECT_A}`)
    expect(projectACheckbox.getAttribute('aria-label')).toBe(
      'Вибрати всі доходи проєкту Project Alpha',
    )
  })
})

describe('CompanySharePayoutModal — create -> step 2 without closing (AC3/AC4)', () => {
  beforeEach(() => {
    currentUser = { id: 'senior-1', role: 'SENIOR', seniorSharePercent: 26 }
    createPayoutRequestMock.mockReset()
    getPayoutRequestMock.mockReset()
  })

  it('after a successful create, the modal stays open and shows the step-2 payment form', async () => {
    const onClose = vi.fn()
    const payout = makePayout()
    createPayoutRequestMock.mockResolvedValue(payout)
    getPayoutRequestMock.mockResolvedValue(payout)

    renderModal({ onClose, preselectedTxIds: [TX_A1.id] })
    // task-i18n-stage3d-pr4 (mutation-gate): the step-1 title/description,
    // pinned BEFORE the click — a mutant forcing the `step === 'select'`
    // ternary to always/never take the step-1 branch is invisible to any
    // assertion taken only after the transition to step 2 below.
    expect(screen.getByText('Оплата частки CheekyCheeseIT')).toBeInTheDocument()
    expect(
      screen.getByText('Виберіть проєкти та доходи, які увійдуть до заявки на виплату.', {
        selector: '[class~="sr-only"]',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('status', { name: 'Крок 1 з 2: вибір доходів до виплати' }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('company-share-create-payout'))

    // Step 2 content appears — payable amount from the CREATED payout.
    await screen.findByTestId('payout-detail-payable')
    // task-i18n-stage3d-pr4 (mutation-gate): pins the exact toast text — a
    // StringLiteral mutant collapsing it to "" passes every OTHER assertion
    // in this test (the toast library itself is mocked, so nothing renders
    // it to the DOM).
    expect(toast.success).toHaveBeenCalledWith('Заявку на виплату створено')
    expect(screen.getByTestId('company-share-payout-modal')).toBeInTheDocument()
    expect(screen.getByTestId('company-share-created-notice')).toBeInTheDocument()
    // Same pin for the step-2 title/description/status-label — the OTHER
    // side of the same three ternaries.
    expect(screen.getByText('Заявка на виплату')).toBeInTheDocument()
    expect(
      screen.getByText('Переведіть суму компанії та підтвердьте оплату.', {
        selector: '[class~="sr-only"]',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('status', { name: 'Крок 2 з 2: оплата створеної заявки' }),
    ).toBeInTheDocument()
    // Crucially: onClose was never called — the modal did NOT close itself.
    expect(onClose).not.toHaveBeenCalled()
  })

  describe('step 2 payout-id/project/income summary line — VALUE assertions (fidelity-review regression)', () => {
    // Regression context: `payout.transactions` (as the real backend
    // returns it) is NOT homogeneous — it includes the PAYOUT ledger row
    // itself (projectId NULL) alongside the bundled income rows. A prior fix
    // that filtered `incomesCount` but not `projectsCount` shipped a
    // universally-reproducible +1 project-count bug (confirmed against the
    // DB: 3 projects/3 incomes showed "4 проекта"; 1 project/1 income showed
    // "2 проекта"). Both fixtures below DELIBERATELY include that PAYOUT row
    // — a test built only from income rows would pass on the buggy code too
    // (Set({A,A,B,B}).size === 2 either way) and would NOT have caught this.

    it('SENIOR payout, 2 projects / 4 incomes + the PAYOUT ledger row itself — counts stay 2/4, not 3/4', async () => {
      const payoutId = 'a1b2c3-full-uuid'
      const payoutLedgerRow = makeTx({
        id: 'payout-ledger-row',
        type: 'PAYOUT',
        projectId: null,
        projectName: null,
        seniorSharePercent: null,
        // Mirrors createPayoutRequest: the PAYOUT ledger row + every bundled
        // income row carry THIS payout's id (task-split-payouts-and-
        // obligations, backlog 174 — isBundledIncomeTransaction now checks
        // it, not just the type).
        payoutRequestId: payoutId,
      })
      const payout = makePayout({
        id: payoutId,
        transactions: [
          { ...TX_A1, id: 't1', payoutRequestId: payoutId },
          { ...TX_A1, id: 't2', payoutRequestId: payoutId },
          { ...TX_B1, id: 't3', payoutRequestId: payoutId },
          { ...TX_B1, id: 't4', payoutRequestId: payoutId },
          payoutLedgerRow,
        ],
      })
      createPayoutRequestMock.mockResolvedValue(payout)
      getPayoutRequestMock.mockResolvedValue(payout)

      renderModal({ preselectedTxIds: [TX_A1.id] })
      fireEvent.click(screen.getByTestId('company-share-create-payout'))

      const summary = await screen.findByTestId('company-share-payout-summary')
      // Exact value, not "contains a number" — this is the whole point.
      expect(summary).toHaveTextContent('№a1b2c3 · 2 проєкти, 4 доходи')
    })

    it('DROP payout, 1 project / 2 DROP_INCOME rows + the PAYOUT ledger row — counts are 1/2, not 0 incomes or an inflated project count', async () => {
      const payoutId = 'd4e5f6-full-uuid'
      const dropIncome1 = makeTx({
        id: 'drop-1',
        type: 'DROP_INCOME',
        projectId: PROJECT_A,
        projectName: 'Project Alpha',
        seniorSharePercent: null,
        dropSharePercent: 5,
        receiverId: 'drop-1-id',
        payoutRequestId: payoutId,
      })
      const dropIncome2 = makeTx({
        id: 'drop-2',
        type: 'DROP_INCOME',
        projectId: PROJECT_A,
        projectName: 'Project Alpha',
        seniorSharePercent: null,
        dropSharePercent: 5,
        receiverId: 'drop-1-id',
        payoutRequestId: payoutId,
      })
      const payoutLedgerRow = makeTx({
        id: 'payout-ledger-row-drop',
        type: 'PAYOUT',
        projectId: null,
        projectName: null,
        seniorSharePercent: null,
        payoutRequestId: payoutId,
      })
      const payout = makePayout({
        id: payoutId,
        seniorId: 'drop-1-id',
        transactions: [dropIncome1, dropIncome2, payoutLedgerRow],
      })
      createPayoutRequestMock.mockResolvedValue(payout)
      getPayoutRequestMock.mockResolvedValue(payout)

      // The old SENIOR_INCOME-only filter would have produced
      // incomesCount=0 here (all rows are DROP_INCOME) — this fixture
      // exercises exactly that gap too.
      renderModal({ preselectedTxIds: [TX_A1.id] })
      fireEvent.click(screen.getByTestId('company-share-create-payout'))

      const summary = await screen.findByTestId('company-share-payout-summary')
      expect(summary).toHaveTextContent('№d4e5f6 · 1 проєкт, 2 доходи')
    })

    it('a recovered company obligation (payoutRequestId reset to null by settleByCompany) does not inflate the summary counts (task-split-payouts-and-obligations, backlog 174)', async () => {
      const payoutId = 'ffeeaa-full-uuid'
      const bundledIncome = { ...TX_A1, id: 'bundled-1', payoutRequestId: payoutId }
      const payoutLedgerRow = makeTx({
        id: 'payout-ledger-row-2',
        type: 'PAYOUT',
        projectId: null,
        projectName: null,
        seniorSharePercent: null,
        payoutRequestId: payoutId,
      })
      // Recovered obligation: settleByCompany flipped it to SENIOR_INCOME
      // (matches the OLD isIncomeTransaction-only filter) but reset its OWN
      // payoutRequestId to null (task-settle-in-place ADR) — findPayoutRequest
      // still returns it here via pending_obligations.payoutRequestId. Money
      // flows COMPANY → this OTHER senior, not this payout's own recipient
      // → this payout — it must never count as one of this payout's incomes.
      const recoveredObligation = makeTx({
        id: 'recovered-obligation-1',
        type: 'SENIOR_INCOME',
        status: 'PAID',
        payoutRequestId: null,
        receiverId: 'other-senior',
        projectId: PROJECT_B,
        projectName: 'Project Beta',
      })
      const payout = makePayout({
        id: payoutId,
        transactions: [bundledIncome, payoutLedgerRow, recoveredObligation],
      })
      createPayoutRequestMock.mockResolvedValue(payout)
      getPayoutRequestMock.mockResolvedValue(payout)

      renderModal({ preselectedTxIds: [TX_A1.id] })
      fireEvent.click(screen.getByTestId('company-share-create-payout'))

      const summary = await screen.findByTestId('company-share-payout-summary')
      // Without the fix this would read "2 проекта, 2 прихода" (Project Beta
      // + the recovered obligation counted alongside the genuine income).
      expect(summary).toHaveTextContent('№ffeeaa · 1 проєкт, 1 дохід')
    })
  })

  it('the step announcer live-region reports the step change (a11y)', async () => {
    const payout = makePayout()
    createPayoutRequestMock.mockResolvedValue(payout)
    getPayoutRequestMock.mockResolvedValue(payout)

    renderModal({ preselectedTxIds: [TX_A1.id] })
    expect(screen.getByTestId('company-share-step-announcer')).toHaveTextContent('')
    fireEvent.click(screen.getByTestId('company-share-create-payout'))

    await waitFor(() => {
      expect(screen.getByTestId('company-share-step-announcer')).toHaveTextContent(
        'Заявку на виплату створено',
      )
    })
  })

  it('closing on step 2 calls onClose WITHOUT any additional API call (payout stays created)', async () => {
    const onClose = vi.fn()
    const payout = makePayout()
    createPayoutRequestMock.mockResolvedValue(payout)
    getPayoutRequestMock.mockResolvedValue(payout)

    renderModal({ onClose, preselectedTxIds: [TX_A1.id] })
    fireEvent.click(screen.getByTestId('company-share-create-payout'))
    await screen.findByTestId('payout-detail-payable')

    createPayoutRequestMock.mockClear()
    fireEvent.click(screen.getByTestId('company-share-close-step2'))

    expect(onClose).toHaveBeenCalledTimes(1)
    // No second create call, no cancel/delete-shaped call — the hook exposes
    // no such method, so the strongest guarantee we can assert here is that
    // creation itself was never invoked again.
    expect(createPayoutRequestMock).not.toHaveBeenCalled()
  })
})

describe('CompanySharePayoutModal — double-submit guard (AC5)', () => {
  beforeEach(() => {
    currentUser = { id: 'senior-1', role: 'SENIOR', seniorSharePercent: 26 }
    createPayoutRequestMock.mockReset()
    getPayoutRequestMock.mockReset()
  })

  it('a second click while creation is in flight does not fire a second createPayoutRequest call', async () => {
    let resolveCreate: (value: PayoutRequestDto) => void = () => {}
    createPayoutRequestMock.mockImplementation(
      () =>
        new Promise<PayoutRequestDto>((resolve) => {
          resolveCreate = resolve
        }),
    )

    renderModal({ preselectedTxIds: [TX_A1.id] })
    const submitBtn = screen.getByTestId('company-share-create-payout')
    fireEvent.click(submitBtn)

    // Button disables while the mutation is pending — a real <button disabled>
    // does not dispatch a click event, so this IS the double-submit guard.
    await waitFor(() => expect(submitBtn).toBeDisabled())
    fireEvent.click(submitBtn)

    expect(createPayoutRequestMock).toHaveBeenCalledTimes(1)

    resolveCreate(makePayout())
    await screen.findByTestId('payout-detail-payable')
  })
})
