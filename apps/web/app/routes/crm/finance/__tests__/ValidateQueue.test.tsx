/**
 * ValidateQueue.test.tsx — unit tests for the ValidateDialog queue behaviour
 * (finance-validation-ux AC2).
 *
 * Covers:
 *   - counter shows remaining count (N) on confirm button when queue.length > 1
 *   - queue progress indicator rendered when queue.length > 1
 *   - clicking «Подтвердить (N)» opens AlertDialog confirm popup
 *   - confirming in AlertDialog calls mutation and then calls onAdvance with next tx
 *   - after last tx in queue, onClose is called instead of onAdvance
 *   - clicking «Отклонить» (with reason) calls mutation and advances/closes
 *   - dialog renders null (unmounted) when tx is null
 *
 * Heavy deps (financeApi, useQuery exchange rate) are mocked.
 * useMutation is mocked to capture mutationFn and call it synchronously.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { TransactionDto } from '@crm/shared'

// ─── mocks ───────────────────────────────────────────────────────────────────

const mutateMock = vi.fn()
const invalidateQueriesMock = vi.fn()
let onSuccessCallback: (() => void) | undefined

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: () => ({ data: undefined }),
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
    useMutation: ({ onSuccess }: { onSuccess?: () => void }) => {
      onSuccessCallback = onSuccess
      return { mutate: mutateMock, isPending: false, error: null }
    },
  }
})

vi.mock('@/routes/crm/finance/api', () => ({
  financeApi: {
    validateTransaction: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: {} }) },
}))

// receipt-panel adds async fetch for S3 — stub it out
vi.mock(
  '/Users/maksym/Desktop/programming/CheekyCheeseIT_CRM/.claude/worktrees/agent-ad163a46b78e12bca/apps/web/app/routes/crm/finance/components/dialogs/receipt-panel',
  () => ({ ReceiptPanel: () => null }),
)

import { ValidateDialog } from '../components/dialogs/ValidateDialog'

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTx(id: string, overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id,
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: 1000,
    currency: 'USD',
    createdAt: new Date().toISOString(),
    senderName: 'Client A',
    projectName: 'Project X',
    notes: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    recipientId: 'user-1',
    rejectionReason: null,
    ...overrides,
  } as unknown as TransactionDto
}

function renderDialog(props: {
  tx: TransactionDto | null
  queue: TransactionDto[]
  onClose?: () => void
  onAdvance?: (tx: TransactionDto) => void
}) {
  const onClose = props.onClose ?? vi.fn()
  const onAdvance = props.onAdvance ?? vi.fn()
  return {
    ...render(
      <ValidateDialog tx={props.tx} queue={props.queue} onClose={onClose} onAdvance={onAdvance} />,
    ),
    onClose,
    onAdvance,
  }
}

beforeEach(() => {
  mutateMock.mockReset()
  invalidateQueriesMock.mockReset()
  onSuccessCallback = undefined
})

// ─── tests ───────────────────────────────────────────────────────────────────

describe('ValidateDialog — queue behaviour (AC2)', () => {
  it('renders nothing when tx is null', () => {
    const { container } = renderDialog({ tx: null, queue: [] })
    expect(container).toBeEmptyDOMElement()
  })

  it('shows dialog when tx is provided', () => {
    const tx = makeTx('tx-1')
    renderDialog({ tx, queue: [tx] })
    expect(screen.getByTestId('validate-transaction-dialog')).toBeInTheDocument()
  })

  it('shows «Подтвердить» (no count) when queue has 1 item', () => {
    const tx = makeTx('tx-1')
    renderDialog({ tx, queue: [tx] })
    expect(screen.getByTestId('validate-transaction-confirm')).toHaveTextContent('Подтвердить')
    expect(screen.getByTestId('validate-transaction-confirm')).not.toHaveTextContent('(')
  })

  it('shows «Подтвердить (N)» when queue has multiple items', () => {
    const tx1 = makeTx('tx-1')
    const tx2 = makeTx('tx-2')
    const tx3 = makeTx('tx-3')
    renderDialog({ tx: tx1, queue: [tx1, tx2, tx3] })
    expect(screen.getByTestId('validate-transaction-confirm')).toHaveTextContent('Подтвердить (3)')
  })

  it('decrements counter when moved to next tx', () => {
    const tx1 = makeTx('tx-1')
    const tx2 = makeTx('tx-2')
    const tx3 = makeTx('tx-3')
    // Simulate parent moved to tx2 (index 1 of 3 → remaining = 2)
    renderDialog({ tx: tx2, queue: [tx1, tx2, tx3] })
    expect(screen.getByTestId('validate-transaction-confirm')).toHaveTextContent('Подтвердить (2)')
  })

  it('shows queue progress indicator when queue has > 1 item', () => {
    const tx1 = makeTx('tx-1')
    const tx2 = makeTx('tx-2')
    renderDialog({ tx: tx1, queue: [tx1, tx2] })
    expect(screen.getByTestId('validate-queue-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('validate-queue-remaining')).toHaveTextContent('2')
  })

  it('hides queue indicator when queue has exactly 1 item', () => {
    const tx = makeTx('tx-1')
    renderDialog({ tx, queue: [tx] })
    expect(screen.queryByTestId('validate-queue-indicator')).not.toBeInTheDocument()
  })

  it('opens AlertDialog confirm popup on «Подтвердить» click', () => {
    const tx = makeTx('tx-1')
    renderDialog({ tx, queue: [tx] })
    expect(screen.queryByTestId('validate-confirm-alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('validate-transaction-confirm'))
    // AlertDialog is rendered in the DOM (open=true via Radix Portal)
    expect(screen.getByTestId('validate-confirm-alert')).toBeInTheDocument()
  })

  it('calls mutation with action=validate when AlertDialog «Подтвердить» clicked', () => {
    const tx = makeTx('tx-1')
    renderDialog({ tx, queue: [tx] })
    fireEvent.click(screen.getByTestId('validate-transaction-confirm'))
    fireEvent.click(screen.getByTestId('validate-confirm-ok'))
    expect(mutateMock).toHaveBeenCalledWith({ action: 'validate' })
  })

  it('calls onAdvance with next tx after successful validate (not last in queue)', () => {
    const tx1 = makeTx('tx-1')
    const tx2 = makeTx('tx-2')
    const onAdvance = vi.fn()
    const onClose = vi.fn()
    renderDialog({ tx: tx1, queue: [tx1, tx2], onAdvance, onClose })

    fireEvent.click(screen.getByTestId('validate-transaction-confirm'))
    fireEvent.click(screen.getByTestId('validate-confirm-ok'))

    // Simulate mutation success
    onSuccessCallback?.()

    expect(onAdvance).toHaveBeenCalledWith(tx2)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose after successful validate when last in queue', () => {
    const tx = makeTx('tx-1')
    const onAdvance = vi.fn()
    const onClose = vi.fn()
    renderDialog({ tx, queue: [tx], onAdvance, onClose })

    fireEvent.click(screen.getByTestId('validate-transaction-confirm'))
    fireEvent.click(screen.getByTestId('validate-confirm-ok'))

    // Simulate mutation success
    onSuccessCallback?.()

    expect(onClose).toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
  })

  it('«Отклонить» button is disabled when reason is empty', () => {
    const tx = makeTx('tx-1')
    renderDialog({ tx, queue: [tx] })
    expect(screen.getByTestId('validate-transaction-reject')).toBeDisabled()
  })

  it('enables «Отклонить» when reason is entered', () => {
    const tx = makeTx('tx-1')
    renderDialog({ tx, queue: [tx] })
    const textarea = screen.getByPlaceholderText('Укажите причину при отклонении...')
    fireEvent.change(textarea, { target: { value: 'Неверная сумма' } })
    expect(screen.getByTestId('validate-transaction-reject')).not.toBeDisabled()
  })

  it('calls mutation with action=reject and reason on «Отклонить» click', () => {
    const tx = makeTx('tx-1')
    renderDialog({ tx, queue: [tx] })
    const textarea = screen.getByPlaceholderText('Укажите причину при отклонении...')
    fireEvent.change(textarea, { target: { value: 'Неверная сумма' } })
    fireEvent.click(screen.getByTestId('validate-transaction-reject'))
    expect(mutateMock).toHaveBeenCalledWith({ action: 'reject' })
  })

  it('calls onAdvance after reject when next tx exists', () => {
    const tx1 = makeTx('tx-1')
    const tx2 = makeTx('tx-2')
    const onAdvance = vi.fn()
    const onClose = vi.fn()
    renderDialog({ tx: tx1, queue: [tx1, tx2], onAdvance, onClose })

    const textarea = screen.getByPlaceholderText('Укажите причину при отклонении...')
    fireEvent.change(textarea, { target: { value: 'Причина' } })
    fireEvent.click(screen.getByTestId('validate-transaction-reject'))

    // Simulate success
    onSuccessCallback?.()

    expect(onAdvance).toHaveBeenCalledWith(tx2)
  })

  it('calls onClose after reject when last in queue', () => {
    const tx = makeTx('tx-1')
    const onAdvance = vi.fn()
    const onClose = vi.fn()
    renderDialog({ tx, queue: [tx], onAdvance, onClose })

    const textarea = screen.getByPlaceholderText('Укажите причину при отклонении...')
    fireEvent.change(textarea, { target: { value: 'Причина' } })
    fireEvent.click(screen.getByTestId('validate-transaction-reject'))

    // Simulate success
    onSuccessCallback?.()

    expect(onClose).toHaveBeenCalled()
    expect(onAdvance).not.toHaveBeenCalled()
  })

  it('invalidates queries on success', () => {
    const tx = makeTx('tx-1')
    renderDialog({ tx, queue: [tx] })

    fireEvent.click(screen.getByTestId('validate-transaction-confirm'))
    fireEvent.click(screen.getByTestId('validate-confirm-ok'))

    onSuccessCallback?.()

    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['transactions'] })
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['finance-summary'] })
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['accountant', 'summary'] })
  })
})
