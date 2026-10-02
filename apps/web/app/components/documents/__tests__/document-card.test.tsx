/**
 * DocumentCard — pending-signature badge tests.
 *
 * Covers batch 3 acceptance:
 *   AC-1. INVOICE document with `invoicePendingSignature: true` renders the
 *         amber «Очікує підпису» badge.
 *   AC-2. INVOICE document with `invoicePendingSignature: false` (or omitted)
 *         does NOT render the badge.
 *
 * Setup: minimal in-memory TanStack Router so the inner `<Link>` from
 * DocumentCard (uploader profile link) can build href values without a real
 * route tree. Hooks that fetch presigned URLs / mutate are mocked.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Document, SessionUser } from '@crm/shared'
// task-i18n-stage3a (Task 2) — `DocumentCard` now calls `useLocale()`
// (`formatBytes(bytes, locale)`), which needs an `I18nProvider` in the tree
// or `useLingui()` throws before render even reaches this test's assertions.
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

beforeEach(async () => {
  await loadCatalog('uk')
})

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
  locale: 'uk',
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

function renderCard(doc: Document, cardViewer: SessionUser = viewer) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute({
    component: () => <DocumentCard doc={doc} viewer={cardViewer} />,
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
}

describe('DocumentCard — pending signature badge', () => {
  it('renders the «Очікує підпису» badge when invoicePendingSignature is true', async () => {
    renderCard(makeInvoiceDoc({ invoicePendingSignature: true }))
    const badge = await screen.findByTestId('document-card-pending-signature')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('Очікує підпису')
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

// task-i18n-stage3a (Task 2) — mutation-gate gap-fill: `sizeBytes > 0 ?
// formatBytes(...) : '—'` had no test on either branch.
describe('DocumentCard — size cell', () => {
  it('sizeBytes > 0 renders the locale-formatted size', async () => {
    renderCard(makeInvoiceDoc({ sizeBytes: 1024 }))
    const card = await screen.findByTestId('document-card')
    expect(card).toHaveTextContent('1,0 КБ')
  })

  it('sizeBytes === 0 renders the placeholder dash, not "0 Б"', async () => {
    renderCard(makeInvoiceDoc({ sizeBytes: 0 }))
    const card = await screen.findByTestId('document-card')
    expect(card).toHaveTextContent('—')
    expect(card).not.toHaveTextContent('Б')
  })
})

// ---------------------------------------------------------------------------
// task-i18n-stage3e-pr2 — copy through the catalog (uk + en)
// ---------------------------------------------------------------------------

const adminViewer: SessionUser = { ...viewer, role: 'ADMIN' }
const MID_MONTH = '2026-03-15T12:00:00.000Z'

describe('DocumentCard — i18n copy (wave e PR2)', () => {
  it('open-button aria-label carries the document name in a slot (uk)', async () => {
    renderCard(makeInvoiceDoc({ originalName: 'Договір.pdf' }))
    const open = await screen.findByTestId('document-card-open')
    expect(open).toHaveAttribute('aria-label', 'Відкрити документ «Договір.pdf»')
  })

  it('open-button aria-label in en uses curly quotes', async () => {
    await loadCatalog('en')
    renderCard(makeInvoiceDoc({ originalName: 'cv.pdf' }))
    const open = await screen.findByTestId('document-card-open')
    expect(open).toHaveAttribute('aria-label', 'Open document “cv.pdf”')
  })

  it('INVOICE label reads «Рахунок #<id>», never «Інвойс»/«Инвойс» (COPY-H-docs-5)', async () => {
    renderCard(makeInvoiceDoc())
    const label = await screen.findByTestId('document-card-invoice-label')
    expect(label).toHaveTextContent('Рахунок #12345678')
    expect(label.textContent).not.toMatch(/нвойс/)
  })

  it('INVOICE label in en reads «Invoice #<id>»', async () => {
    await loadCatalog('en')
    renderCard(makeInvoiceDoc())
    expect(await screen.findByTestId('document-card-invoice-label')).toHaveTextContent(
      'Invoice #12345678',
    )
  })

  it('RECEIPT with a projectId: chip says «Чек із Фінансів», links to /finance, prints NO id (COPY-H-docs-2)', async () => {
    const projectId = '99999999-aaaa-bbbb-cccc-dddddddddddd'
    renderCard(
      makeInvoiceDoc({ category: 'RECEIPT', name: 'r.jpg', originalName: 'r.jpg', projectId }),
    )
    const chip = await screen.findByRole('link', { name: 'Чек із Фінансів' })
    expect(chip).toHaveAttribute('href', '/finance')
    expect(chip.textContent).not.toContain(projectId.slice(-8))
    expect(chip.textContent).not.toMatch(/транзакц/i)
  })

  it('RECEIPT chip in en', async () => {
    await loadCatalog('en')
    renderCard(
      makeInvoiceDoc({
        category: 'RECEIPT',
        name: 'r.jpg',
        originalName: 'r.jpg',
        projectId: '99999999-aaaa-bbbb-cccc-dddddddddddd',
      }),
    )
    expect(await screen.findByRole('link', { name: 'Receipt from Finance' })).toBeInTheDocument()
  })

  it('soft-deleted document wears the «В архіві» badge (uk) / «Archived» (en)', async () => {
    renderCard(makeInvoiceDoc({ deletedAt: MID_MONTH }))
    const card = await screen.findByTestId('document-card')
    expect(card).toHaveTextContent('В архіві')
    expect(card.textContent).not.toMatch(/Удал.н|У кошику/)
  })

  it('en archived badge', async () => {
    await loadCatalog('en')
    renderCard(makeInvoiceDoc({ deletedAt: MID_MONTH }))
    expect(await screen.findByTestId('document-card')).toHaveTextContent('Archived')
  })

  it('disabled trash on a RECEIPT / INVOICE names its reason in aria-label (COPY-L-docs-20)', async () => {
    const { unmount } = renderCard(
      makeInvoiceDoc({ category: 'RECEIPT', name: 'r.jpg', originalName: 'r.jpg' }),
    )
    expect(
      await screen.findByRole('button', {
        name: 'Видалити не можна: чек видаляється разом із транзакцією',
      }),
    ).toBeDisabled()
    unmount()
    renderCard(makeInvoiceDoc())
    expect(await screen.findByTestId('document-delete-invoice-disabled')).toHaveAttribute(
      'aria-label',
      'Видалити не можна: рахунок видаляється разом із транзакцією',
    )
  })

  it('relative date + absolute date in the tooltip, in the active locale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-15T14:00:00.000Z'))
    try {
      renderCard(makeInvoiceDoc({ createdAt: MID_MONTH }))
      const card = await screen.findByTestId('document-card')
      expect(card).toHaveTextContent(/2 години тому|2 годин/)
      expect(screen.getByTitle(/2026.*\d{1,2}:\d{2}/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('archive confirm (owner): promises restore by an ADMIN, no storage-backend name', async () => {
    renderCard(
      makeInvoiceDoc({
        category: 'SCAN',
        name: 's.pdf',
        originalName: 's.pdf',
        ownerId: VIEWER_ID,
      }),
    )
    const trash = await screen.findByTestId('document-delete')
    expect(trash).toHaveAttribute('aria-label', 'Видалити')
    fireEvent.click(trash)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Перенести в архів?')
    expect(screen.getByRole('button', { name: 'Перенести в архів' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('Документ піде в архів. Повернути його може адмін')
    expect(dialog.textContent).not.toMatch(/можна відновити|корзин/i)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    })
  })

  it('archive confirm in en: «Move to archive?» (no article) + «Archive» verb on the button', async () => {
    await loadCatalog('en')
    renderCard(
      makeInvoiceDoc({
        category: 'SCAN',
        name: 's.pdf',
        originalName: 's.pdf',
        ownerId: VIEWER_ID,
      }),
    )
    fireEvent.click(await screen.findByTestId('document-delete'))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Move to archive?')
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument()
  })

  it('uploader deleted (no display name): neutral «Видалений користувач», never a raw id', async () => {
    renderCard(makeInvoiceDoc({ uploadedByDisplayName: null }))
    const link = await screen.findByTestId('document-card-uploader-link')
    expect(link).toHaveTextContent('Видалений користувач')
    expect(link.textContent).not.toContain(OWNER_ID.slice(-8))
  })

  it('uploader deleted in en: «Deleted user»', async () => {
    await loadCatalog('en')
    renderCard(makeInvoiceDoc({ uploadedByDisplayName: null }))
    expect(await screen.findByTestId('document-card-uploader-link')).toHaveTextContent(
      'Deleted user',
    )
  })

  it('permanent-delete confirm (ADMIN): no «S3», says the loss is irreversible', async () => {
    renderCard(makeInvoiceDoc({ deletedAt: MID_MONTH }), adminViewer)
    fireEvent.click(await screen.findByTestId('document-hard-delete'))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Видалити назавжди?')
    expect(dialog).toHaveTextContent('Файл буде видалено без можливості відновлення')
    expect(dialog.textContent).not.toMatch(/S3|баз[иі]/)
  })

  it('ADMIN sees «Відновити» + «Видалити назавжди» on an archived document; SENIOR sees neither', async () => {
    const { unmount } = renderCard(makeInvoiceDoc({ deletedAt: MID_MONTH }), adminViewer)
    expect(await screen.findByTestId('document-restore')).toHaveTextContent('Відновити')
    expect(screen.getByTestId('document-hard-delete')).toHaveTextContent('Видалити назавжди')
    unmount()
    renderCard(makeInvoiceDoc({ deletedAt: MID_MONTH }))
    await screen.findByTestId('document-card')
    expect(screen.queryByTestId('document-restore')).toBeNull()
    expect(screen.queryByTestId('document-hard-delete')).toBeNull()
  })

  it('download button reads «Завантажити» (uk) / «Download» (en)', async () => {
    const { unmount } = renderCard(makeInvoiceDoc())
    expect(await screen.findByTestId('document-download')).toHaveTextContent('Завантажити')
    unmount()
    await loadCatalog('en')
    renderCard(makeInvoiceDoc())
    expect(await screen.findByTestId('document-download')).toHaveTextContent('Download')
  })
})
