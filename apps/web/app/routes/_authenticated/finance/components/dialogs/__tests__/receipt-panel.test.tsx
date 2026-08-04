/**
 * ReceiptPanel — external vs own-file receipt rendering
 * (fix/external-receipt-rendering, task AC1/AC2/AC4/AC5).
 *
 * Background: the site's CSP `object-src` only allow-lists our own domain +
 * `blob:` + R2 — an external `<object>`/`<iframe>` embed is blocked, and
 * `img-src` only allows `https:` (a legacy `http://` receipt is blocked as
 * mixed content). Embedding an external receipt therefore produced either an
 * empty frame with a MISLEADING "PDF не поддерживается браузером" caption
 * (browser support was never the issue — the site's own CSP was), or, for
 * http://, a completely silent empty frame.
 *
 * Pins:
 * 1. AC1 — an external receipt (any host, PDF or image) renders the honest
 *    "external" card with a working link, never an <object>/<img> embed.
 * 2. AC2 — an own (presigned) receipt still renders inline (image <img>, PDF
 *    <object>) — regression guard for the untouched path.
 * 3. AC4 — a legacy http:// external receipt renders the same honest card
 *    and its link still points at the original http:// URL (nothing crashes,
 *    nothing silently drops the value).
 * 4. AC5 — the misleading "не поддерживается браузером" text never appears
 *    on the external path.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TransactionDto } from '@crm/shared'

const useDocumentDownloadUrlMock = vi.fn()
vi.mock('@/hooks/use-documents', () => ({
  useDocumentDownloadUrl: (...args: unknown[]) => useDocumentDownloadUrlMock(...args),
}))

import { ReceiptPanel } from '../receipt-panel'

const BASE_TX = {
  id: 'tx-1',
  type: 'ADMIN_INCOME',
  status: 'PENDING',
  amount: '500',
  currency: 'USD',
  receiptDocumentId: null,
  receiptExternalUrl: null,
} as unknown as TransactionDto

describe('ReceiptPanel — external receipts (never embedded)', () => {
  it('renders the honest card + a working link for an external PDF (no <object> embed, AC1)', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'https://www.w3.org/dummy.pdf',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.getByTestId('receipt-panel-external')).toBeInTheDocument()
    expect(document.querySelector('object')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
    const link = screen.getByRole('link', { name: /открыть чек/i })
    expect(link).toHaveAttribute('href', tx.receiptExternalUrl)
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders the same honest card for an external image on an arbitrary host (AC1)', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'https://drive.google.com/file/d/abc/view.png',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.getByTestId('receipt-panel-external')).toBeInTheDocument()
    // Never inline-embedded via <img>, unlike the own-file path below.
    expect(document.querySelector(`img[src="${tx.receiptExternalUrl}"]`)).toBeNull()
  })

  it('never shows the misleading "не поддерживается браузером" caption on the external path (AC5)', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'https://www.w3.org/dummy.pdf',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.queryByText(/не поддерживается браузером/i)).not.toBeInTheDocument()
  })

  it('renders the honest card (not an empty frame) for a legacy http:// receipt and its link still opens the original URL (AC4)', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'http://legacy-partner.example/receipt.jpg',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.getByTestId('receipt-panel-external')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /открыть чек/i })
    expect(link).toHaveAttribute('href', 'http://legacy-partner.example/receipt.jpg')
  })
})

describe('ReceiptPanel — own (presigned) receipts still preview inline (AC2 regression)', () => {
  it('renders an inline <img> preview for an own image receipt', () => {
    useDocumentDownloadUrlMock.mockReturnValue({
      data: { url: 'https://acct.r2.cloudflarestorage.com/bucket/key.png?X-Amz-Signature=abc' },
      isLoading: false,
    })
    const tx = {
      ...BASE_TX,
      receiptDocumentId: 'doc-1',
      receiptExternalUrl: null,
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.queryByTestId('receipt-panel-external')).not.toBeInTheDocument()
    expect(screen.getByAltText('Чек')).toBeInTheDocument()
  })

  it('renders an inline <object> PDF embed for an own PDF receipt', () => {
    useDocumentDownloadUrlMock.mockReturnValue({
      data: { url: 'https://acct.r2.cloudflarestorage.com/bucket/key.pdf?X-Amz-Signature=abc' },
      isLoading: false,
    })
    const tx = {
      ...BASE_TX,
      receiptDocumentId: 'doc-2',
      receiptExternalUrl: null,
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.queryByTestId('receipt-panel-external')).not.toBeInTheDocument()
    const obj = document.querySelector('object[type="application/pdf"]')
    expect(obj).not.toBeNull()
    expect(obj).toHaveAttribute(
      'data',
      'https://acct.r2.cloudflarestorage.com/bucket/key.pdf?X-Amz-Signature=abc',
    )
  })
})
