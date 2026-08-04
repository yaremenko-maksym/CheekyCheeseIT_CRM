/**
 * ReceiptPanel — external vs own-file receipt rendering
 * (fix/external-receipt-rendering, task AC1/AC2/AC4/AC5 + round 2 MED-1/MED-3/LOW
 * from security-review PR #470).
 *
 * Background (round 1): the site's CSP `object-src` only allow-lists our own
 * domain + `blob:` + R2 — an external `<object>` PDF embed is blocked, and a
 * legacy `http://` receipt is blocked as mixed content regardless of file
 * type. Embedding either produced an empty frame with a MISLEADING "PDF не
 * поддерживается браузером" caption (browser support was never the issue),
 * or, for http://, a completely silent empty frame.
 *
 * Correction (round 2, security-review PR #470 MED-3): CSP `img-src` is a
 * BLANKET `https:` allow-list (`nginx/conf.d/csp-map.conf`) — an external
 * **https image** was never blocked and must keep its inline `<img>`
 * preview. Only an external **PDF** (any host) or **any `http://` value**
 * (any file type) is actually unrenderable.
 *
 * Pins:
 * 1. An external PDF (any host) renders the honest "external" card — never
 *    an <object> embed.
 * 2. An external HTTPS image renders inline via <img>, same as an own image
 *    (MED-3 — img-src allows any https host, this was never CSP-blocked).
 * 3. An own (presigned) receipt still renders inline (image <img>, PDF
 *    <object>) — regression guard for the untouched path.
 * 4. A legacy http:// external receipt (any file type) renders the honest
 *    card and its link still points at the original http:// URL.
 * 5. The misleading "не поддерживается браузером" text never appears on the
 *    external-card path.
 * 6. MED-1 — an unsafe scheme (javascript:/data:) on receiptExternalUrl never
 *    reaches href/src: useReceiptUrl nulls it out to "Чек недоступен".
 * 7. LOW — the external card itself is a single clickable <a>, not a
 *    non-interactive element with clickable-looking copy.
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

describe('ReceiptPanel — external PDF / http:// (blocked embed → honest card)', () => {
  it('renders the honest card + a working link for an external PDF on any host (no <object> embed)', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'https://www.w3.org/dummy.pdf',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.getByTestId('receipt-panel-external')).toBeInTheDocument()
    expect(document.querySelector('object')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
    const links = screen.getAllByRole('link', { name: /открыть чек|чек хранится/i })
    for (const link of links) {
      expect(link).toHaveAttribute('href', tx.receiptExternalUrl)
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    }
  })

  it('renders the honest card for a legacy http:// image (mixed content, not object-src) — link still opens the original URL (AC4)', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'http://legacy-partner.example/receipt.jpg',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.getByTestId('receipt-panel-external')).toBeInTheDocument()
    expect(document.querySelector(`img[src="${tx.receiptExternalUrl}"]`)).toBeNull()
    const card = screen.getByTestId('receipt-panel-external')
    expect(card).toHaveAttribute('href', 'http://legacy-partner.example/receipt.jpg')
  })

  it('never shows the misleading "не поддерживается браузером" caption on the external-card path (AC5)', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'https://www.w3.org/dummy.pdf',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.queryByText(/не поддерживается браузером/i)).not.toBeInTheDocument()
  })

  it('LOW: the external card is itself a single clickable <a> (whole card, not just the caption)', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'https://www.w3.org/dummy.pdf',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    const card = screen.getByTestId('receipt-panel-external')
    expect(card.tagName).toBe('A')
    expect(card).toHaveAttribute('href', tx.receiptExternalUrl)
  })
})

describe('ReceiptPanel — external HTTPS image (MED-3: img-src allows any https host)', () => {
  it('renders inline via <img>, NOT the external card — CSP never blocked this', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'https://drive.google.com/file/d/abc/view.png',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.queryByTestId('receipt-panel-external')).not.toBeInTheDocument()
    const img = screen.getByAltText('Чек')
    expect(img).toHaveAttribute('src', tx.receiptExternalUrl)
  })
})

describe('ReceiptPanel — unsafe scheme never reaches href/src (MED-1 defence-in-depth)', () => {
  it('a javascript: receiptExternalUrl falls back to "Чек недоступен" — no href anywhere', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'javascript:alert(1)',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.getByText('Чек недоступен')).toBeInTheDocument()
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(document.querySelector('[href*="alert"]')).toBeNull()
  })

  it('a data: receiptExternalUrl also falls back to "Чек недоступен"', () => {
    const tx = {
      ...BASE_TX,
      receiptExternalUrl: 'data:text/html,<script>alert(1)</script>',
    } as TransactionDto
    render(<ReceiptPanel tx={tx} />)

    expect(screen.getByText('Чек недоступен')).toBeInTheDocument()
    expect(document.querySelector('a[href^="data:"]')).toBeNull()
  })
})

describe('ReceiptPanel — own (presigned) receipts still preview inline (regression)', () => {
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
