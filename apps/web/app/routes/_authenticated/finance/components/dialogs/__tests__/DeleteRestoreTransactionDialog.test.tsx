/**
 * DeleteTransactionDialog / RestoreTransactionDialog — pins the mandatory-reason
 * contract extracted verbatim from `finance/index.tsx`:
 *  - confirm is disabled until the TRIMMED reason has >= 3 chars;
 *  - a visible hint appears for a non-empty but too-short reason;
 *  - confirm sends the trimmed reason; success closes the dialog and resets it.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TransactionDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const deleteTransaction = vi.fn().mockResolvedValue({})
const restoreTransaction = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    deleteTransaction: (...a: unknown[]) => deleteTransaction(...a),
    restoreTransaction: (...a: unknown[]) => restoreTransaction(...a),
  },
}))

import { DeleteTransactionDialog } from '../DeleteTransactionDialog'
import { RestoreTransactionDialog } from '../RestoreTransactionDialog'

beforeAll(async () => {
  await loadCatalog('uk')
})
beforeEach(() => {
  vi.clearAllMocks()
})

const TX = {
  id: 'tx-9',
  type: 'EXPENSE',
  amount: '50',
  currency: 'USD',
  deletionReason: 'oops',
} as unknown as TransactionDto

function renderWith(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const spy = vi.spyOn(qc, 'invalidateQueries')
  const utils = render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>, {
    wrapper: I18nTestProvider,
  })
  return { ...utils, spy }
}

describe.each([
  {
    name: 'DeleteTransactionDialog',
    prefix: 'delete',
    confirm: 'delete-tx-confirm-button',
    input: 'delete-tx-reason-input',
    hint: 'delete-tx-reason-hint',
    api: deleteTransaction,
    cancel: 'Скасувати',
    Dialog: DeleteTransactionDialog,
  },
  {
    name: 'RestoreTransactionDialog',
    prefix: 'restore',
    confirm: 'restore-tx-confirm-button',
    input: 'restore-tx-reason-input',
    hint: 'restore-tx-reason-hint',
    api: restoreTransaction,
    cancel: 'Скасувати',
    Dialog: RestoreTransactionDialog,
  },
])('$name', ({ confirm, input, hint, api, cancel, Dialog }) => {
  it('renders nothing when tx is null', () => {
    renderWith(<Dialog tx={null} onClose={() => {}} />)
    expect(screen.queryByTestId(confirm)).not.toBeInTheDocument()
  })

  it('disables confirm and shows the hint for a too-short reason; no hint when empty', async () => {
    renderWith(<Dialog tx={TX} onClose={() => {}} />)
    expect(screen.getByTestId(confirm)).toBeDisabled()
    expect(screen.queryByTestId(hint)).not.toBeInTheDocument()
    await userEvent.type(screen.getByTestId(input), 'ab')
    expect(screen.getByTestId(hint)).toBeInTheDocument()
    expect(screen.getByTestId(confirm)).toBeDisabled()
  })

  it('treats whitespace padding as too short (trim)', async () => {
    renderWith(<Dialog tx={TX} onClose={() => {}} />)
    await userEvent.type(screen.getByTestId(input), ' a  ')
    expect(screen.getByTestId(hint)).toBeInTheDocument()
    expect(screen.getByTestId(confirm)).toBeDisabled()
  })

  it('submits the trimmed reason, invalidates lists and closes on success', async () => {
    const onClose = vi.fn()
    const { spy } = renderWith(<Dialog tx={TX} onClose={onClose} />)
    await userEvent.type(screen.getByTestId(input), '  because  ')
    expect(screen.queryByTestId(hint)).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId(confirm))
    await waitFor(() => expect(api).toHaveBeenCalledWith('tx-9', 'because'))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(spy).toHaveBeenCalledWith({ queryKey: ['transactions'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['finance-summary'] })
  })

  it('cancel closes and clears the typed reason', async () => {
    const onClose = vi.fn()
    renderWith(<Dialog tx={TX} onClose={onClose} />)
    await userEvent.type(screen.getByTestId(input), 'typed reason')
    await userEvent.click(screen.getByRole('button', { name: cancel }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId(input)).toHaveValue('')
  })
})

describe('RestoreTransactionDialog — original deletion reason', () => {
  it('shows the original deletion reason when present', () => {
    renderWith(<RestoreTransactionDialog tx={TX} onClose={() => {}} />)
    expect(screen.getByText('oops')).toBeInTheDocument()
  })
})
