/**
 * DocumentList — slot + loading contract (task-i18n-stage3e-pr2, COPY-M-docs-8).
 *
 * The list owns NO empty-state copy any more: the parent always passes
 * `emptyState` (receipts tab, invoices tab, generic / no-results). The dead
 * generic «Нет документов» placeholder was deleted, not translated — an empty
 * list without a slot renders nothing, a non-empty list renders its cards.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Document, SessionUser } from '@crm/shared'

// The card has its own tests; here it is a stub that reports what it received.
vi.mock('../document-card', () => ({
  DocumentCard: ({ doc }: { doc: Document }) => <div data-testid="card-stub">{doc.id}</div>,
}))

import { DocumentList } from '../document-list'

const viewer: SessionUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'viewer@example.com',
  displayName: 'Viewer',
  role: 'SENIOR',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
  locale: 'uk',
}

function makeDoc(id: string): Document {
  return {
    id,
    ownerId: viewer.id,
    projectId: null,
    category: 'RESUME',
    name: 'cv.pdf',
    originalName: 'CV.pdf',
    thumbnailS3Key: null,
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    uploadedBy: viewer.id,
    uploadedByDisplayName: 'Owner',
    deletedAt: null,
    deletedBy: null,
    createdAt: '2026-03-15T12:00:00.000Z',
  }
}

describe('DocumentList — what it renders', () => {
  it('non-empty list → one card per document, and NOT the parent slot', () => {
    render(
      <DocumentList
        documents={[makeDoc('a'), makeDoc('b')]}
        loading={false}
        viewer={viewer}
        emptyState={<p data-testid="slot">slot</p>}
      />,
    )
    expect(screen.getAllByTestId('card-stub').map((el) => el.textContent)).toEqual(['a', 'b'])
    expect(screen.queryByTestId('slot')).toBeNull()
  })

  it('empty list → exactly the parent-supplied slot', () => {
    render(
      <DocumentList
        documents={[]}
        loading={false}
        viewer={viewer}
        emptyState={<p data-testid="slot">slot</p>}
      />,
    )
    expect(screen.getByTestId('slot')).toBeInTheDocument()
    expect(screen.queryByTestId('card-stub')).toBeNull()
  })

  it('empty list without a slot → renders nothing (no built-in copy)', () => {
    const { container } = render(<DocumentList documents={[]} loading={false} viewer={viewer} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('loading wins over both the cards and the slot', () => {
    render(
      <DocumentList
        documents={[makeDoc('a')]}
        loading
        viewer={viewer}
        view="list"
        emptyState={<p data-testid="slot">slot</p>}
      />,
    )
    expect(screen.getByTestId('documents-list-skeleton')).toBeInTheDocument()
    expect(screen.queryByTestId('card-stub')).toBeNull()
    expect(screen.queryByTestId('slot')).toBeNull()
  })
})
