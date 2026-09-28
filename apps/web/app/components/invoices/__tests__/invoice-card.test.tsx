import { describe, expect, it, vi, beforeAll } from 'vitest'
import { render as rtlRender, screen, fireEvent, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { InvoiceListItem } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { InvoiceCard } from '../invoice-card'

beforeAll(async () => {
  await loadCatalog('uk')
})

// `InvoiceCard` calls `useLingui()` now — wrap every render (same pattern
// as `cascade-impact-panel.test.tsx`).
function render(ui: ReactElement): RenderResult {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

const baseInvoice: InvoiceListItem = {
  transactionId: '00000000-0000-0000-0000-000000000001',
  status: 'PENDING',
  type: 'SENIOR_INCOME',
  amount: '1234.56',
  currency: 'USDT',
  counterpartyName: 'Иван Иванов',
  createdAt: new Date('2026-05-26T10:00:00Z').toISOString(),
}

describe('InvoiceCard', () => {
  it('renders the SENIOR payout type badge with the uk label', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} />)
    // task-i18n-stage3d-pr4: `getInvoiceTypeLabel` (legacy Russian export)
    // replaced by the catalog-backed `useInvoiceTypeLabel` — canon spelling
    // «сеньйор» (glossary), «дохід» not the legacy «виплата»/payout.
    expect(screen.getByTestId(`invoice-card-type-${baseInvoice.transactionId}`)).toHaveTextContent(
      'Дохід сеньйора',
    )
  })

  it('renders SALARY badge with green palette label', () => {
    render(<InvoiceCard invoice={{ ...baseInvoice, type: 'SALARY' }} onOpen={vi.fn()} />)
    expect(screen.getByTestId(`invoice-card-type-${baseInvoice.transactionId}`)).toHaveTextContent(
      'Зарплата',
    )
  })

  it('renders the amount formatted with currency suffix', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} />)
    // uk-UA locale uses non-breaking space (U+00A0) — assert on the
    // currency-bearing line by querying the exact wrapper class. The amount
    // text contains "1 234,56 USDT".
    const amount = screen.getByText(/USDT/)
    expect(amount.textContent).toMatch(/USDT$/)
    expect(amount.textContent).toMatch(/1.*234.*56/)
  })

  it('shows status badge with pending label', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} />)
    expect(
      screen.getByTestId(`invoice-card-status-${baseInvoice.transactionId}`),
    ).toHaveTextContent('Очікує підпису')
  })

  it('shows "Підписано всіма" when invoice.status === SIGNED', () => {
    render(<InvoiceCard invoice={{ ...baseInvoice, status: 'SIGNED' }} onOpen={vi.fn()} />)
    expect(
      screen.getByTestId(`invoice-card-status-${baseInvoice.transactionId}`),
    ).toHaveTextContent('Підписано всіма')
  })

  it('renders counterparty name', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} />)
    expect(screen.getByText(/Иван Иванов/)).toBeInTheDocument()
  })

  it('shows the "Очікується ваш підпис" hint when awaitingViewerSignature is true', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} awaitingViewerSignature />)
    expect(screen.getByText('Очікується ваш підпис')).toBeInTheDocument()
  })

  it('does NOT show the hint when awaitingViewerSignature is false', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} awaitingViewerSignature={false} />)
    expect(screen.queryByText('Очікується ваш підпис')).not.toBeInTheDocument()
  })

  it('aria-label names the invoice type and formatted amount as "рахунок" (COPY-L-fin-16 — «інвойс» retired)', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} />)
    // Accessible name is built from the aria-label; asserting via getByRole
    // (not getByTestId) so a mutation to the aria-label string itself is
    // caught, not just the visible text. Amount literal ("1 234,56 USDT")
    // is written by hand, not derived from formatAmount, so it can't drift
    // silently together with the code under test. Also proves the aria-label
    // no longer leaks the raw enum (`SENIOR_INCOME`) — it reads the same
    // translated type label the badge shows.
    expect(
      screen.getByRole('button', { name: /Відкрити рахунок Дохід сеньйора на 1\s234,56\sUSDT/ }),
    ).toBeInTheDocument()
  })

  it('calls onOpen with the transactionId when the card is clicked', () => {
    const onOpen = vi.fn()
    render(<InvoiceCard invoice={baseInvoice} onOpen={onOpen} />)
    const card = screen.getByTestId(`invoice-card-${baseInvoice.transactionId}`)
    fireEvent.click(card)
    expect(onOpen).toHaveBeenCalledWith(baseInvoice.transactionId)
  })
})
