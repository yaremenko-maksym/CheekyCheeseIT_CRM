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

    fireEvent.click(screen.getByTestId(`company-share-income-checkbox-${TX_A2.id}`))
    // 400+240 = 640 * 0.74 = 473.60
    const total2 = screen.getByTestId('company-share-selection-total')
    expect(total2).toHaveTextContent('473,60')
  })

  it('groups projects (from different projects) as separate cards', () => {
    renderModal()
    expect(screen.getByTestId(`company-share-project-checkbox-${PROJECT_A}`)).toBeInTheDocument()
    expect(screen.getByTestId(`company-share-project-checkbox-${PROJECT_B}`)).toBeInTheDocument()
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
    fireEvent.click(screen.getByTestId('company-share-create-payout'))

    // Step 2 content appears — payable amount from the CREATED payout.
    await screen.findByTestId('payout-detail-payable')
    expect(screen.getByTestId('company-share-payout-modal')).toBeInTheDocument()
    expect(screen.getByTestId('company-share-created-notice')).toBeInTheDocument()
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
      const payoutLedgerRow = makeTx({
        id: 'payout-ledger-row',
        type: 'PAYOUT',
        projectId: null,
        projectName: null,
        seniorSharePercent: null,
      })
      const payout = makePayout({
        id: 'a1b2c3-full-uuid',
        transactions: [
          { ...TX_A1, id: 't1' },
          { ...TX_A1, id: 't2' },
          { ...TX_B1, id: 't3' },
          { ...TX_B1, id: 't4' },
          payoutLedgerRow,
        ],
      })
      createPayoutRequestMock.mockResolvedValue(payout)
      getPayoutRequestMock.mockResolvedValue(payout)

      renderModal({ preselectedTxIds: [TX_A1.id] })
      fireEvent.click(screen.getByTestId('company-share-create-payout'))

      const summary = await screen.findByTestId('company-share-payout-summary')
      // Exact value, not "contains a number" — this is the whole point.
      expect(summary).toHaveTextContent('№a1b2c3 · 2 проекта, 4 прихода')
    })

    it('DROP payout, 1 project / 2 DROP_INCOME rows + the PAYOUT ledger row — counts are 1/2, not 0 incomes or an inflated project count', async () => {
      const dropIncome1 = makeTx({
        id: 'drop-1',
        type: 'DROP_INCOME',
        projectId: PROJECT_A,
        projectName: 'Project Alpha',
        seniorSharePercent: null,
        dropSharePercent: 5,
        receiverId: 'drop-1-id',
      })
      const dropIncome2 = makeTx({
        id: 'drop-2',
        type: 'DROP_INCOME',
        projectId: PROJECT_A,
        projectName: 'Project Alpha',
        seniorSharePercent: null,
        dropSharePercent: 5,
        receiverId: 'drop-1-id',
      })
      const payoutLedgerRow = makeTx({
        id: 'payout-ledger-row-drop',
        type: 'PAYOUT',
        projectId: null,
        projectName: null,
        seniorSharePercent: null,
      })
      const payout = makePayout({
        id: 'd4e5f6-full-uuid',
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
      expect(summary).toHaveTextContent('№d4e5f6 · 1 проект, 2 прихода')
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
        'Заявка на выплату создана',
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
