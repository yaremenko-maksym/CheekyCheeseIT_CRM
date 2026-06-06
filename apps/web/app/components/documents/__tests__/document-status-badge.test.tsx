/**
 * DocumentStatusBadge — unit tests (Task 4 — PR-2).
 *
 * Verifies that each {kind, state} combination maps to the correct
 * Russian label and data-badge-* attributes. No router or TanStack Query
 * required — the component is pure (no hooks / queries).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { StatusBadge } from '@crm/shared'
import { DocumentStatusBadge } from '../document-status-badge'

function renderBadge(badge: StatusBadge) {
  return render(<DocumentStatusBadge badge={badge} />)
}

// ---------------------------------------------------------------------------
// Contract badges
// ---------------------------------------------------------------------------

describe('DocumentStatusBadge — contract', () => {
  it('contract/draft → «Драфт» (neutral tone)', () => {
    renderBadge({ kind: 'contract', state: 'draft' })
    const el = screen.getByTestId('document-status-badge')
    expect(el).toBeInTheDocument()
    expect(el).toHaveTextContent('Драфт')
    expect(el).toHaveAttribute('data-badge-kind', 'contract')
    expect(el).toHaveAttribute('data-badge-state', 'draft')
  })

  it('contract/ready → «Готово к подписи» (amber tone)', () => {
    renderBadge({ kind: 'contract', state: 'ready' })
    const el = screen.getByTestId('document-status-badge')
    expect(el).toHaveTextContent('Готово к подписи')
    expect(el).toHaveAttribute('data-badge-state', 'ready')
    // amber tone: class contains amber
    expect(el.className).toMatch(/amber/)
  })

  it('contract/signed → «Подписано» (green tone)', () => {
    renderBadge({ kind: 'contract', state: 'signed' })
    const el = screen.getByTestId('document-status-badge')
    expect(el).toHaveTextContent('Подписано')
    expect(el.className).toMatch(/emerald/)
  })
})

// ---------------------------------------------------------------------------
// Invoice badges
// ---------------------------------------------------------------------------

describe('DocumentStatusBadge — invoice', () => {
  it('invoice/ready → «Ожидает подписи» (amber tone)', () => {
    renderBadge({ kind: 'invoice', state: 'ready' })
    const el = screen.getByTestId('document-status-badge')
    expect(el).toHaveTextContent('Ожидает подписи')
    expect(el.className).toMatch(/amber/)
  })

  it('invoice/signed → «Подписано» (green tone)', () => {
    renderBadge({ kind: 'invoice', state: 'signed' })
    const el = screen.getByTestId('document-status-badge')
    expect(el).toHaveTextContent('Подписано')
    expect(el.className).toMatch(/emerald/)
  })
})

// ---------------------------------------------------------------------------
// Receipt badges
// ---------------------------------------------------------------------------

describe('DocumentStatusBadge — receipt', () => {
  it('receipt/pending → «Требует подтверждения» (amber tone)', () => {
    renderBadge({ kind: 'receipt', state: 'pending' })
    const el = screen.getByTestId('document-status-badge')
    expect(el).toHaveTextContent('Требует подтверждения')
    expect(el.className).toMatch(/amber/)
  })

  it('receipt/validated → «Подтверждено» (green tone)', () => {
    renderBadge({ kind: 'receipt', state: 'validated' })
    const el = screen.getByTestId('document-status-badge')
    expect(el).toHaveTextContent('Подтверждено')
    expect(el.className).toMatch(/emerald/)
  })
})

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

describe('DocumentStatusBadge — data attributes', () => {
  it('sets data-badge-kind and data-badge-state on the element', () => {
    renderBadge({ kind: 'invoice', state: 'signed' })
    const el = screen.getByTestId('document-status-badge')
    expect(el).toHaveAttribute('data-badge-kind', 'invoice')
    expect(el).toHaveAttribute('data-badge-state', 'signed')
  })
})
