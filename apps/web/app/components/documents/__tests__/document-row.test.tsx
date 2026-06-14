/**
 * DocumentRow — statusBadge + list skeleton tests (PR-2, Task 4).
 *
 * Covers:
 *   1. RESUME row: no statusBadge rendered
 *   2. Invoice row with statusBadge {kind:'invoice', state:'signed'}: renders DocumentStatusBadge
 *   3. Receipt row with statusBadge {kind:'receipt', state:'pending'}: renders DocumentStatusBadge
 *   4. Contract virtual entry with statusBadge {kind:'contract', state:'draft'}: renders badge
 *   5. Back-compat: invoicePendingSignature=true, no statusBadge → amber badge still renders
 *   6. DocumentList view='list' loading → row-shaped skeleton (data-testid documents-list-skeleton)
 *   7. DocumentList view='grid' loading → grid-shaped skeleton (no documents-list-skeleton)
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Document, SessionUser } from '@crm/shared'

vi.mock('@/hooks/use-documents', () => ({
  useDocumentDownloadUrl: () => ({
    data: null,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue({ data: null }),
  }),
  useDeleteDocument: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreDocument: () => ({ mutate: vi.fn(), isPending: false }),
  useHardDeleteDocument: () => ({ mutate: vi.fn(), isPending: false }),
}))

import { DocumentRow } from '../document-row'
import { DocumentList } from '../document-list'

const VIEWER_ID = '00000000-0000-0000-0000-000000000001'
const OWNER_ID = '00000000-0000-0000-0000-000000000002'
const DOC_ID = '00000000-0000-0000-0000-000000000003'

const viewer: SessionUser = {
  id: VIEWER_ID,
  email: 'viewer@example.com',
  displayName: 'Viewer',
  role: 'SENIOR',
  avatarUrl: null,
  seniorSharePercent: 26,
}

function baseDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: DOC_ID,
    ownerId: OWNER_ID,
    projectId: null,
    category: 'RESUME',
    name: 'cv.pdf',
    originalName: 'CV.pdf',
    s3Key: 'documents/RESUME/x/cv.pdf',
    thumbnailS3Key: null,
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    uploadedBy: OWNER_ID,
    uploadedByDisplayName: 'Owner',
    deletedAt: null,
    deletedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function renderRow(doc: Document, rowViewer: SessionUser = viewer) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => <DocumentRow doc={doc} viewer={rowViewer} />,
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Row badge tests
// ---------------------------------------------------------------------------

describe('DocumentRow — statusBadge (PR-2)', () => {
  it('1. RESUME row: no status badge rendered', async () => {
    renderRow(baseDoc())
    await screen.findByTestId('document-row')
    expect(screen.queryByTestId('document-status-badge')).toBeNull()
    expect(screen.queryByTestId('document-row-pending-signature')).toBeNull()
  })

  it('2. INVOICE row with statusBadge invoice/signed → renders DocumentStatusBadge', async () => {
    renderRow(
      baseDoc({
        category: 'INVOICE',
        name: 'invoice-12345678.pdf',
        statusBadge: { kind: 'invoice', state: 'signed' },
      }),
    )
    const badge = await screen.findByTestId('document-status-badge')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('Подписано')
    expect(badge).toHaveAttribute('data-badge-kind', 'invoice')
    expect(badge).toHaveAttribute('data-badge-state', 'signed')
  })

  it('3. RECEIPT row with statusBadge receipt/pending → renders DocumentStatusBadge', async () => {
    renderRow(
      baseDoc({
        category: 'RECEIPT',
        statusBadge: { kind: 'receipt', state: 'pending' },
      }),
    )
    const badge = await screen.findByTestId('document-status-badge')
    expect(badge).toHaveTextContent('Требует подтверждения')
    expect(badge).toHaveAttribute('data-badge-kind', 'receipt')
  })

  it('4. Contract virtual entry with contract/draft badge → renders DocumentStatusBadge', async () => {
    renderRow(
      baseDoc({
        category: 'CONTRACT',
        source: 'employee_contract',
        statusBadge: { kind: 'contract', state: 'draft' },
      }),
    )
    const badge = await screen.findByTestId('document-status-badge')
    expect(badge).toHaveTextContent('Драфт')
    expect(badge).toHaveAttribute('data-badge-kind', 'contract')
  })

  it('5. Back-compat: invoicePendingSignature=true, no statusBadge → amber badge rendered', async () => {
    renderRow(
      baseDoc({
        category: 'INVOICE',
        name: 'invoice-12345678.pdf',
        invoicePendingSignature: true,
        // statusBadge intentionally omitted (pre-PR-2 API)
      }),
    )
    const badge = await screen.findByTestId('document-row-pending-signature')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('Требует подписи')
    // DocumentStatusBadge should NOT render (only the fallback badge)
    expect(screen.queryByTestId('document-status-badge')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Uploader link — DROP viewer gating (task-drop-profile-lockdown)
// ---------------------------------------------------------------------------

describe('DocumentRow — uploader link gated by viewer role (DROP lockdown)', () => {
  const dropViewer: SessionUser = { ...viewer, role: 'DROP' }

  it('SENIOR viewer → uploader name is a profile <Link> to /crm/profile/$uploadedBy', async () => {
    renderRow(baseDoc())
    const link = await screen.findByTestId('document-row-uploader-link')
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', `/crm/profile/${OWNER_ID}`)
    expect(link).toHaveTextContent('Owner')
  })

  it('DROP viewer → uploader name is PLAIN TEXT (span), NOT a link', async () => {
    renderRow(baseDoc(), dropViewer)
    const el = await screen.findByTestId('document-row-uploader-link')
    expect(el.tagName).toBe('SPAN')
    expect(el).not.toHaveAttribute('href')
    expect(el).toHaveTextContent('Owner')
    // No navigable profile anchor anywhere for DROP.
    expect(screen.queryByRole('link')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// DocumentList skeleton tests (PR-1 MED fix)
// ---------------------------------------------------------------------------

describe('DocumentList — view-aware loading skeleton (PR-1 MED fix)', () => {
  it('6. view=list + loading → row-shaped skeleton (data-testid=documents-list-skeleton)', () => {
    render(<DocumentList documents={[]} loading viewer={viewer} view="list" />)
    expect(screen.getByTestId('documents-list-skeleton')).toBeInTheDocument()
    // Grid skeleton (aspect-[4/3] cards) should NOT be present
    expect(screen.queryByTestId('documents-empty')).toBeNull()
  })

  it('7. view=grid + loading → grid-shaped skeleton (no documents-list-skeleton)', () => {
    render(<DocumentList documents={[]} loading viewer={viewer} view="grid" />)
    // Row skeleton testid should NOT be present for grid mode
    expect(screen.queryByTestId('documents-list-skeleton')).toBeNull()
  })

  it('8. default view (no prop) + loading → grid skeleton (backward compat)', () => {
    render(<DocumentList documents={[]} loading viewer={viewer} />)
    expect(screen.queryByTestId('documents-list-skeleton')).toBeNull()
  })
})
