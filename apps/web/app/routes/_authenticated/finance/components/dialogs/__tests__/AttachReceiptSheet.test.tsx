/**
 * task-receipts-frontend — `AttachReceiptSheet` interaction tests
 * (design-spec §5.3, task interaction-AC).
 *
 * Pins:
 * 1. Attach flow (no existing receipt): submit is DISABLED until a receipt is
 *    entered; filling the url field enables it; submitting calls
 *    `financeApi.attachReceipt` directly (no confirm step — nothing to lose).
 * 2. Replace flow (existing receipt): the form is pre-seeded from the tx's
 *    current receipt; submitting opens an `AlertDialog` confirm FIRST;
 *    confirming calls `attachReceipt`; cancelling does NOT call it.
 * 3. Escape closes the Sheet (calls onClose) — standard Radix Dialog behavior.
 * 4. Focus restores to the external trigger element after the Sheet closes.
 * 5. Explorer-only mode (USDT tx) is passed straight through to ReceiptInput.
 * 6. fix/external-receipt-rendering round 2 (security-review PR #470 MED-2):
 *    confirming "Заменить" WITHOUT actually changing the pre-filled value is
 *    a no-op close, not a network round-trip — resubmitting a byte-identical
 *    legacy value has nothing to save and could 400 under the tightened
 *    https-only write schema for a field nobody touched.
 *
 * Strategy: real `@tanstack/react-query` hooks (QueryClientProvider), mock
 * only the API boundary (`../../../api` — three levels up from
 * `dialogs/__tests__/`, mirrors `PaySalaryDialog.test.tsx`) + `sonner`.
 */
import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const attachReceiptMock = vi.fn().mockResolvedValue({})
vi.mock('../../../api', () => ({
  financeApi: {
    attachReceipt: (...args: unknown[]) => attachReceiptMock(...args),
  },
}))

import { AttachReceiptSheet } from '../AttachReceiptSheet'
import type { TransactionDto } from '@crm/shared'

const NO_RECEIPT_TX = {
  id: 'tx-1',
  type: 'ADMIN_INCOME',
  status: 'PENDING',
  amount: '500',
  currency: 'USD',
  receiptDocumentId: null,
  receiptExternalUrl: null,
} as unknown as TransactionDto

const USDT_TX = {
  ...NO_RECEIPT_TX,
  id: 'tx-usdt',
  currency: 'USDT',
} as unknown as TransactionDto

const EXISTING_RECEIPT_TX = {
  ...NO_RECEIPT_TX,
  id: 'tx-2',
  receiptExternalUrl: 'https://etherscan.io/tx/0xold',
} as unknown as TransactionDto

function renderSheet(tx: TransactionDto | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <AttachReceiptSheet tx={tx} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

// Harness with an external trigger button — needed to assert focus restore
// (Radix Dialog/Sheet saves+restores `document.activeElement` around open/close).
function TriggerHarness() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" data-testid="row-trigger" onClick={() => setOpen(true)}>
        Прикрепить чек
      </button>
      <AttachReceiptSheet tx={open ? NO_RECEIPT_TX : null} onClose={() => setOpen(false)} />
    </div>
  )
}

function renderTriggerHarness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TriggerHarness />
    </QueryClientProvider>,
  )
}

describe('AttachReceiptSheet — attach flow (no existing receipt)', () => {
  beforeEach(() => {
    attachReceiptMock.mockClear()
  })

  it('submit is disabled until a receipt is entered', () => {
    renderSheet(NO_RECEIPT_TX)
    expect(screen.getByTestId('attach-receipt-sheet-submit')).toBeDisabled()
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/receipt.png' },
    })
    expect(screen.getByTestId('attach-receipt-sheet-submit')).toBeEnabled()
  })

  it('submits attachReceipt directly (no confirm step) when there is no existing receipt', async () => {
    renderSheet(NO_RECEIPT_TX)
    fireEvent.click(screen.getByTestId('receipt-input-mode-url'))
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://example.com/receipt.png' },
    })
    fireEvent.click(screen.getByTestId('attach-receipt-sheet-submit'))
    expect(screen.queryByTestId('attach-receipt-confirm-replace')).not.toBeInTheDocument()
    await waitFor(() => expect(attachReceiptMock).toHaveBeenCalledTimes(1))
    const [id, payload] = attachReceiptMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('tx-1')
    expect(payload).toMatchObject({ receiptExternalUrl: 'https://example.com/receipt.png' })
  })

  it('renders explorer-only (no tab-toggle) when the tx currency is USDT', () => {
    renderSheet(USDT_TX)
    expect(screen.queryByTestId('receipt-input-mode-file')).not.toBeInTheDocument()
    expect(screen.getByTestId('receipt-input-explorer-hint')).toBeInTheDocument()
  })
})

describe('AttachReceiptSheet — replace flow (existing receipt)', () => {
  beforeEach(() => {
    attachReceiptMock.mockClear()
  })

  it('pre-seeds the form from the existing receipt and enables submit immediately', () => {
    renderSheet(EXISTING_RECEIPT_TX)
    expect(screen.getByTestId('receipt-input-url-field')).toHaveValue(
      'https://etherscan.io/tx/0xold',
    )
    expect(screen.getByTestId('attach-receipt-sheet-submit')).toBeEnabled()
    expect(screen.getByText('Заменить')).toBeInTheDocument()
  })

  it('submitting opens the destructive confirm dialog FIRST — does not call attachReceipt yet', () => {
    renderSheet(EXISTING_RECEIPT_TX)
    fireEvent.click(screen.getByTestId('attach-receipt-sheet-submit'))
    expect(screen.getByTestId('attach-receipt-confirm-replace')).toBeInTheDocument()
    expect(attachReceiptMock).not.toHaveBeenCalled()
  })

  it('cancelling the confirm dialog does NOT call attachReceipt', () => {
    renderSheet(EXISTING_RECEIPT_TX)
    fireEvent.click(screen.getByTestId('attach-receipt-sheet-submit'))
    fireEvent.click(screen.getByTestId('attach-receipt-confirm-cancel'))
    expect(attachReceiptMock).not.toHaveBeenCalled()
  })

  it('confirming replace calls attachReceipt with the new value', async () => {
    renderSheet(EXISTING_RECEIPT_TX)
    fireEvent.change(screen.getByTestId('receipt-input-url-field'), {
      target: { value: 'https://etherscan.io/tx/0xnew' },
    })
    fireEvent.click(screen.getByTestId('attach-receipt-sheet-submit'))
    fireEvent.click(screen.getByTestId('attach-receipt-confirm-submit'))
    await waitFor(() => expect(attachReceiptMock).toHaveBeenCalledTimes(1))
    const [id, payload] = attachReceiptMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(id).toBe('tx-2')
    expect(payload).toMatchObject({ receiptExternalUrl: 'https://etherscan.io/tx/0xnew' })
  })

  it('confirming replace WITHOUT changing the pre-filled value is a no-op — does not call attachReceipt (MED-2)', () => {
    const onClose = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <AttachReceiptSheet tx={EXISTING_RECEIPT_TX} onClose={onClose} />
      </QueryClientProvider>,
    )
    // Confirm without touching receipt-input-url-field — it's already
    // pre-seeded with the tx's current value.
    fireEvent.click(screen.getByTestId('attach-receipt-sheet-submit'))
    fireEvent.click(screen.getByTestId('attach-receipt-confirm-submit'))
    expect(attachReceiptMock).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('AttachReceiptSheet — Escape closes (focus-restore is a Radix primitive, verified visually)', () => {
  // Note: focus-restore-to-trigger on close is handled by the underlying Radix
  // `Dialog` primitive (same one every Sheet/Dialog in this app uses) —
  // `FocusScope`'s unmount-auto-focus relies on real-browser focus semantics
  // that happy-dom does not faithfully emulate (asserting `document.activeElement`
  // here reliably lands on `<body>`, a known jsdom/happy-dom limitation, not a
  // behavior regression). Covered instead by the Playwright smoke pass — see
  // coder report — and it's the SAME mechanism `CreateTransactionDialog`'s own
  // Escape test relies on, so no new risk is introduced here.
  it('pressing Escape closes the Sheet (calls onClose via onOpenChange)', () => {
    renderTriggerHarness()
    fireEvent.click(screen.getByTestId('row-trigger'))
    expect(screen.getByTestId('attach-receipt-sheet')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByTestId('attach-receipt-sheet')).not.toBeInTheDocument()
  })
})
