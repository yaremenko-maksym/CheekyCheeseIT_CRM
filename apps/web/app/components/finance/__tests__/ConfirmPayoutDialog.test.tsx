/**
 * ConfirmPayoutDialog.test.tsx — unit tests for the three-method payout
 * confirmation dialog (task-payout-company-ui).
 *
 * Covers:
 *   - default CRYPTO: recipient selector + txHash row visible
 *   - CRYPTO/CASH route to `financeApi.confirmPayout` (legacy admin-credit flow)
 *   - COMPANY_ACCOUNT hides the recipient selector + shows the hint
 *   - COMPANY_ACCOUNT routes to `financeApi.manualConfirmPayout` off the
 *     payoutRequestId (NOT confirmPayout), with method COMPANY_ACCOUNT
 *   - COMPANY_ACCOUNT submit is enabled without a recipient (txHash optional)
 *   - dialog renders null when tx is null
 *
 * `@tanstack/react-query` is mocked to capture the mutationFn and run it
 * synchronously so we can assert which api method fires. Both api methods are
 * mocked.
 */
import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest'
import {
  render as rtlRender,
  screen,
  fireEvent,
  act,
  type RenderResult,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import type { TransactionDto } from '@crm/shared'
import { kyivToday } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

beforeAll(async () => {
  await loadCatalog('uk')
})

// `ConfirmPayoutDialog` calls `useLingui()` now — wrap every render (same
// pattern as `PayoutDetailDialog.test.tsx`).
function render(ui: ReactElement): RenderResult {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

// ─── mocks ───────────────────────────────────────────────────────────────────

const invalidateQueriesMock = vi.fn()
let capturedMutationFn: (() => Promise<unknown>) | undefined
let capturedOnSuccess: (() => void) | undefined

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
    useMutation: ({
      mutationFn,
      onSuccess,
    }: {
      mutationFn: () => Promise<unknown>
      onSuccess?: () => void
    }) => {
      capturedMutationFn = mutationFn
      capturedOnSuccess = onSuccess
      return {
        // mutate() runs the real mutationFn so the test can assert which api
        // method (confirmPayout vs manualConfirmPayout) gets called.
        mutate: () => {
          void mutationFn()
        },
        isPending: false,
        error: null,
      }
    },
  }
})

const confirmPayoutMock = vi.fn().mockResolvedValue({ payout: {}, confirmed: null })
const manualConfirmPayoutMock = vi.fn().mockResolvedValue({ id: 'pr-1' })

vi.mock('@/routes/_authenticated/finance/api', () => ({
  financeApi: {
    confirmPayout: (...args: unknown[]) => confirmPayoutMock(...args),
    manualConfirmPayout: (...args: unknown[]) => manualConfirmPayoutMock(...args),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { toast } from 'sonner'
import { ConfirmPayoutDialog } from '../ConfirmPayoutDialog'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTx(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'tx-1',
    type: 'PAYOUT',
    status: 'PENDING_PAYMENT',
    amount: '1000',
    currency: 'USDT',
    senderId: 'user-senior',
    senderName: 'Senior One',
    senderLabel: null,
    receiverId: null,
    receiverLabel: 'CheekyCheeseIT',
    receiverName: null,
    projectId: 'proj-1',
    projectName: 'Project X',
    payoutRequestId: 'pr-1',
    payoutRequest: null,
    seniorSharePercent: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    recipientId: null,
    createdBy: 'user-admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as TransactionDto
}

async function runMutation() {
  // mutationFn is async; flush it so the api mock is observed before asserting.
  await act(async () => {
    await capturedMutationFn?.()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedMutationFn = undefined
  capturedOnSuccess = undefined
})

// ─── tests ─────────────────────────────────────────────────────────────────

describe('ConfirmPayoutDialog', () => {
  it('renders null when tx is null', () => {
    const { container } = render(<ConfirmPayoutDialog tx={null} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows three method options and the recipient selector by default (CRYPTO)', () => {
    render(<ConfirmPayoutDialog tx={makeTx()} onClose={vi.fn()} />)
    expect(screen.getByTestId('confirm-payout-txdate')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-payout-method-crypto')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-payout-method-cash')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-payout-method-company_account')).toBeInTheDocument()
    // CRYPTO default → recipient selector + txHash visible, no company hint.
    expect(screen.getByTestId('confirm-payout-admin-select')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-payout-tx-hash')).toBeInTheDocument()
    expect(screen.queryByTestId('confirm-payout-company-account-hint')).not.toBeInTheDocument()
    // CRYPTO (not COMPANY_ACCOUNT) → txHash is required, "(необов'язково)" does
    // NOT appear next to its label (kills the isCompanyAccount ConditionalExpression/
    // LogicalOperator mutants on the label's optional-marker branch).
    expect(screen.queryByText('(необов’язково)')).not.toBeInTheDocument()
    // Placeholder text on the (empty) recipient select.
    expect(screen.getByText('— оберіть адміна —')).toBeInTheDocument()
  })

  it('CRYPTO method calls confirmPayout (not manualConfirmPayout)', async () => {
    render(<ConfirmPayoutDialog tx={makeTx()} onClose={vi.fn()} />)
    // pick recipient + hash so the legacy contract is well-formed
    fireEvent.change(screen.getByTestId('confirm-payout-tx-hash'), {
      target: { value: '0x1234567890abcdef' },
    })
    await runMutation()
    expect(confirmPayoutMock).toHaveBeenCalledTimes(1)
    expect(manualConfirmPayoutMock).not.toHaveBeenCalled()
    const [id, payload] = confirmPayoutMock.mock.calls[0]!
    expect(id).toBe('tx-1')
    expect(payload).toMatchObject({
      method: 'CRYPTO',
      txHash: '0x1234567890abcdef',
      txDate: kyivToday(),
    })
  })

  it('CASH method calls confirmPayout and omits txHash', async () => {
    render(<ConfirmPayoutDialog tx={makeTx()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('confirm-payout-method-cash'))
    await runMutation()
    expect(confirmPayoutMock).toHaveBeenCalledTimes(1)
    expect(manualConfirmPayoutMock).not.toHaveBeenCalled()
    const [, payload] = confirmPayoutMock.mock.calls[0]!
    expect(payload).toMatchObject({ method: 'CASH' })
    expect(payload).not.toHaveProperty('txHash')
  })

  it('COMPANY_ACCOUNT hides recipient selector and shows the hint', () => {
    render(<ConfirmPayoutDialog tx={makeTx()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('confirm-payout-method-company_account'))
    expect(screen.queryByTestId('confirm-payout-admin-select')).not.toBeInTheDocument()
    expect(screen.getByTestId('confirm-payout-company-account-hint')).toBeInTheDocument()
    // COMPANY_ACCOUNT → txHash IS optional, "(необов'язково)" appears next to
    // its label (the true branch this file's default-CRYPTO test does not
    // reach — kills the isCompanyAccount ConditionalExpression mutants).
    expect(screen.getByText('(необов’язково)')).toBeInTheDocument()
    // The space between the label and "(необов'язково)" is its own JSX
    // expression ({' '}) — a StringLiteral mutant on it ("" instead of " ")
    // would not affect either substring assertion above but would collapse
    // the label to "Хеш транзакції(необов’язково)".
    // There is no RTL query for "this label's full accumulated text across
    // its nested optional-marker span"; textContent is the only way to see
    // the space.
    // eslint-disable-next-line testing-library/no-node-access
    const label = document.querySelector('label[for="confirm-payout-tx-hash"]')
    expect(label).toHaveTextContent('Хеш транзакції (необов’язково)')
  })

  it('COMPANY_ACCOUNT calls manualConfirmPayout off payoutRequestId (not confirmPayout)', async () => {
    render(<ConfirmPayoutDialog tx={makeTx()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('confirm-payout-method-company_account'))
    await runMutation()
    expect(manualConfirmPayoutMock).toHaveBeenCalledTimes(1)
    expect(confirmPayoutMock).not.toHaveBeenCalled()
    const [payoutRequestId, payload] = manualConfirmPayoutMock.mock.calls[0]!
    expect(payoutRequestId).toBe('pr-1')
    expect(payload).toMatchObject({ method: 'COMPANY_ACCOUNT', txDate: kyivToday() })
    // txHash is optional + omitted when blank
    expect(payload).not.toHaveProperty('txHash')
  })

  it('COMPANY_ACCOUNT submit is enabled without a recipient', () => {
    render(<ConfirmPayoutDialog tx={makeTx()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('confirm-payout-method-company_account'))
    // No recipient chosen, no txHash — still submittable for the company account.
    expect(screen.getByTestId('confirm-payout-submit')).not.toBeDisabled()
  })

  it('COMPANY_ACCOUNT attaches txHash when provided', async () => {
    render(<ConfirmPayoutDialog tx={makeTx()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('confirm-payout-method-company_account'))
    fireEvent.change(screen.getByTestId('confirm-payout-tx-hash'), {
      target: { value: '0xCOMPANYHASH123456' },
    })
    await runMutation()
    const [, payload] = manualConfirmPayoutMock.mock.calls[0]!
    expect(payload).toMatchObject({ method: 'COMPANY_ACCOUNT', txHash: '0xCOMPANYHASH123456' })
  })

  it('onSuccess invalidates transactions, finance-summary and company-account', () => {
    render(<ConfirmPayoutDialog tx={makeTx()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('confirm-payout-method-company_account'))
    // Trigger the captured onSuccess directly to assert the invalidation set.
    capturedOnSuccess?.()
    const invalidatedKeys = invalidateQueriesMock.mock.calls.map(
      (c) => (c[0] as { queryKey: string[] }).queryKey[0],
    )
    expect(invalidatedKeys).toContain('transactions')
    expect(invalidatedKeys).toContain('finance-summary')
    expect(invalidatedKeys).toContain('company-account')
    // COMPANY_ACCOUNT → the credit-worded toast, not the generic "confirmed" one.
    expect(toast.success).toHaveBeenCalledWith('Оплату зараховано на рахунок компанії')
  })

  it('onSuccess for CRYPTO/CASH shows the generic "confirmed" toast', () => {
    render(<ConfirmPayoutDialog tx={makeTx()} onClose={vi.fn()} />)
    // Default method is CRYPTO — do not switch to COMPANY_ACCOUNT.
    capturedOnSuccess?.()
    expect(toast.success).toHaveBeenCalledWith('Оплату підтверджено')
  })

  // Sender row — `senderName ?? displayCounterpartyLabel(senderLabel, …) ?? '—'`.
  // The span carries title={senderDisplay}, so getByTitle pins the exact text and
  // a `??` → `&&` swap fails on at least one of these cases.
  describe('sender display', () => {
    it('shows the sender name when present, ignoring the label', () => {
      render(
        <ConfirmPayoutDialog
          tx={makeTx({ senderName: 'Senior One', senderLabel: 'COMPANY' })}
          onClose={vi.fn()}
        />,
      )
      expect(screen.getByTitle('Senior One')).toHaveTextContent('Senior One')
      expect(screen.queryByTitle('Рахунок компанії')).not.toBeInTheDocument()
    })

    it('localizes the COMPANY code when there is no name', () => {
      render(
        <ConfirmPayoutDialog
          tx={makeTx({ senderName: null, senderLabel: 'COMPANY' })}
          onClose={vi.fn()}
        />,
      )
      expect(screen.getByTitle('Рахунок компанії')).toHaveTextContent('Рахунок компанії')
      expect(screen.queryByText('COMPANY')).not.toBeInTheDocument()
    })

    it('passes a non-code label through when there is no name', () => {
      render(
        <ConfirmPayoutDialog
          tx={makeTx({ senderName: null, senderLabel: 'Acme Ltd' })}
          onClose={vi.fn()}
        />,
      )
      expect(screen.getByTitle('Acme Ltd')).toHaveTextContent('Acme Ltd')
    })

    it('falls back to the dash when there is neither name nor label', () => {
      render(
        <ConfirmPayoutDialog
          tx={makeTx({ senderName: null, senderLabel: null })}
          onClose={vi.fn()}
        />,
      )
      expect(screen.getByTitle('—')).toHaveTextContent('—')
    })
  })
})
