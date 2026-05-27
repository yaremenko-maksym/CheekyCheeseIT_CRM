import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { InvoiceListItem } from '@crm/shared'
import { InvoiceCard } from '../invoice-card'

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
  it('renders the SENIOR payout type badge with the Russian label', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} />)
    // Round 4 fix #7 — label changed from «Выплата сеньору» to
    // «Выплата синьера» so it matches the rest of the CRM copy.
    expect(screen.getByTestId(`invoice-card-type-${baseInvoice.transactionId}`)).toHaveTextContent(
      'Выплата синьера',
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
    // ru-RU locale uses non-breaking space (U+00A0) — assert on the
    // currency-bearing line by querying the exact wrapper class. The amount
    // text contains "1 234,56 USDT".
    const amount = screen.getByText(/USDT/)
    expect(amount.textContent).toMatch(/USDT$/)
    expect(amount.textContent).toMatch(/1.*234.*56/)
  })

  it('shows status badge with pending label', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} />)
    expect(
      screen.getByTestId(`invoice-card-status-${baseInvoice.transactionId}`),
    ).toHaveTextContent('Ожидает подписи')
  })

  it('shows "Подписано всеми" when invoice.status === SIGNED', () => {
    render(<InvoiceCard invoice={{ ...baseInvoice, status: 'SIGNED' }} onOpen={vi.fn()} />)
    expect(
      screen.getByTestId(`invoice-card-status-${baseInvoice.transactionId}`),
    ).toHaveTextContent('Подписано всеми')
  })

  it('renders counterparty name', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} />)
    expect(screen.getByText(/Иван Иванов/)).toBeInTheDocument()
  })

  it('shows the "Ожидается ваша подпись" hint when awaitingViewerSignature is true', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} awaitingViewerSignature />)
    expect(screen.getByText('Ожидается ваша подпись')).toBeInTheDocument()
  })

  it('does NOT show the hint when awaitingViewerSignature is false', () => {
    render(<InvoiceCard invoice={baseInvoice} onOpen={vi.fn()} awaitingViewerSignature={false} />)
    expect(screen.queryByText('Ожидается ваша подпись')).not.toBeInTheDocument()
  })

  it('calls onOpen with the transactionId when the card is clicked', () => {
    const onOpen = vi.fn()
    render(<InvoiceCard invoice={baseInvoice} onOpen={onOpen} />)
    const card = screen.getByTestId(`invoice-card-${baseInvoice.transactionId}`)
    fireEvent.click(card)
    expect(onOpen).toHaveBeenCalledWith(baseInvoice.transactionId)
  })
})
