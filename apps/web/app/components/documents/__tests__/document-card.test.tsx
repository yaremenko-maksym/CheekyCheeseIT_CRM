/**
 * DocumentCard — pending-signature badge tests.
 *
 * Covers batch 3 acceptance:
 *   AC-1. INVOICE document with `invoicePendingSignature: true` renders the
 *         amber «Требует подписи» badge.
 *   AC-2. INVOICE document with `invoicePendingSignature: false` (or omitted)
 *         does NOT render the badge.
 *
 * Setup: minimal in-memory TanStack Router so the inner `<Link>` from
 * DocumentCard (uploader profile link) can build href values without a real
 * route tree. Hooks that fetch presigned URLs / mutate are mocked.
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

// Mock the documents hook — DocumentCard otherwise triggers a presigned URL
// query on mount + provides mutate handles we don't want to fire here.
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

import { DocumentCard } from '../document-card'

const VIEWER_ID = '00000000-0000-0000-0000-000000000001'
const OWNER_ID = '00000000-0000-0000-0000-000000000002'
const DOC_ID = '00000000-0000-0000-0000-000000000003'
const TX_ID = '00000000-0000-0000-0000-000000000004'

const viewer: SessionUser = {
  id: VIEWER_ID,
  email: 'viewer@example.com',
  displayName: 'Viewer',
  role: 'SENIOR',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function makeInvoiceDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: DOC_ID,
    ownerId: OWNER_ID,
    projectId: null,
    category: 'INVOICE',
    name: 'invoice-12345678.pdf',
    originalName: 'invoice-12345678.pdf',
    // s3Key removed from public DTO (s3/documents hygiene)
    thumbnailS3Key: null,
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    uploadedBy: OWNER_ID,
    uploadedByDisplayName: 'Owner',
    deletedAt: null,
    deletedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    invoiceTransactionId: TX_ID,
    invoicePendingSignature: false,
    ...overrides,
  }
}

function renderCard(doc: Document) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: () => <DocumentCard doc={doc} viewer={viewer} />,
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

describe('DocumentCard — pending signature badge', () => {
  it('renders the «Требует подписи» badge when invoicePendingSignature is true', async () => {
    renderCard(makeInvoiceDoc({ invoicePendingSignature: true }))
    const badge = await screen.findByTestId('document-card-pending-signature')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('Требует подписи')
  })

  it('does NOT render the badge when invoicePendingSignature is false', async () => {
    renderCard(makeInvoiceDoc({ invoicePendingSignature: false }))
    // Wait for one element that always renders so the router has settled.
    await screen.findByTestId('document-card')
    expect(screen.queryByTestId('document-card-pending-signature')).toBeNull()
  })

  it('does NOT render the badge when invoicePendingSignature is omitted', async () => {
    const doc = makeInvoiceDoc()
    // Strip the field entirely (older API clients won't set it).
    delete (doc as Partial<Document>).invoicePendingSignature
    renderCard(doc)
    await screen.findByTestId('document-card')
    expect(screen.queryByTestId('document-card-pending-signature')).toBeNull()
  })
})
