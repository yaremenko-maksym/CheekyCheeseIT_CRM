/**
 * DocumentDetailDialog — copy + metadata tests (task-i18n-stage3e-pr2, AC1).
 *
 * Pinned against the real compiled catalog on both locales:
 *   - categories come from the `document-labels.ts` hub (one word per
 *     category; the dialog's own local label map is gone);
 *   - the «Format» row shows a human format, the raw MIME lives only in the
 *     row's `title` (COPY-M-docs-10);
 *   - the «Project» row shows the project NAME, the id only in the link's
 *     `title`; without access it degrades to a generic label (visible text is never an id)
 *     (COPY-M-docs-11);
 *   - dates go through `@crm/shared` formatters, not `date-fns/locale/ru`;
 *   - delete confirmations use the hub canon (no storage-backend name).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Document, SessionUser } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const apiGet = vi.hoisted(() => vi.fn())

vi.mock('@/lib/axios', () => ({ api: { get: apiGet } }))
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
vi.mock('@/hooks/use-document-blob', () => ({
  useDocumentBlob: () => ({ blobUrl: null, isLoading: false, hasError: false }),
}))
vi.mock('@/components/user-profile/contract/useEmployeeContract', () => ({
  fetchContractPdfBlob: vi.fn().mockRejectedValue(new Error('no pdf in unit test')),
}))
// The preview panes have their own tests (and their own copy, wave (e) PR3).
vi.mock('../pdf-preview', () => ({ PdfPreview: () => <div data-testid="pdf-stub" /> }))
vi.mock('../document-image', () => ({ DocumentImage: () => <div data-testid="image-stub" /> }))

import { DocumentDetailDialog } from '../document-detail-dialog'

beforeEach(async () => {
  apiGet.mockReset()
  apiGet.mockRejectedValue(new Error('403'))
  await loadCatalog('uk')
})

const VIEWER_ID = '00000000-0000-0000-0000-000000000001'
const OWNER_ID = '00000000-0000-0000-0000-000000000002'
const PROJECT_ID = '12345678-aaaa-bbbb-cccc-ddddeeeeffff'
const MID_MONTH = '2026-03-15T12:00:00.000Z'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

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
const admin: SessionUser = { ...viewer, role: 'ADMIN' }

function makeDoc(overrides: Partial<Document> = {}): Document {
  return {
    id: '00000000-0000-0000-0000-000000000003',
    ownerId: OWNER_ID,
    projectId: null,
    category: 'SCAN',
    name: 'scan.pdf',
    originalName: 'Scan.pdf',
    thumbnailS3Key: null,
    sizeBytes: 2048,
    mimeType: 'application/pdf',
    uploadedBy: OWNER_ID,
    uploadedByDisplayName: 'Owner',
    deletedAt: null,
    deletedBy: null,
    createdAt: MID_MONTH,
    ...overrides,
  }
}

function renderDialog(doc: Document, who: SessionUser = viewer) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <DocumentDetailDialog open onOpenChange={() => undefined} doc={doc} viewer={who} />
    ),
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const utils = render(
    <I18nTestProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
  return { ...utils, qc }
}

async function dialogText(): Promise<string> {
  const dialog = await screen.findByRole('dialog')
  return dialog.textContent ?? ''
}

describe('DocumentDetailDialog — categories from the hub (AC1)', () => {
  it('SCAN → «Скан», INVOICE → «Рахунок» (never «Инвойс»), RECEIPT → «Чек»', async () => {
    const scan = renderDialog(makeDoc({ category: 'SCAN' }))
    expect(await dialogText()).toContain('Скан')
    scan.unmount()
    const invoice = renderDialog(makeDoc({ category: 'INVOICE' }))
    const text = await dialogText()
    expect(text).toContain('Рахунок')
    expect(text).not.toMatch(/нвойс/)
    invoice.unmount()
    renderDialog(makeDoc({ category: 'RECEIPT' }))
    expect(await dialogText()).toContain('Чек')
  })

  it('virtual employee contract wears the «Договір» badge, not «Контракт»', async () => {
    renderDialog(makeDoc({ category: 'CONTRACT', source: 'employee_contract' }))
    const text = await dialogText()
    expect(text).toContain('Договір')
    expect(text).not.toContain('Контракт')
  })

  it('en: category word comes from the en catalog', async () => {
    await loadCatalog('en')
    renderDialog(makeDoc({ category: 'INVOICE' }))
    expect(await dialogText()).toContain('Invoice')
  })
})

describe('DocumentDetailDialog — metadata rows', () => {
  it('uk labels: uploader / date / size / format', async () => {
    renderDialog(makeDoc())
    const text = await dialogText()
    for (const label of ['Хто завантажив', 'Дата', 'Розмір', 'Формат']) {
      expect(text).toContain(label)
    }
    expect(text).not.toMatch(/Загрузил|Размер/)
  })

  it('en labels', async () => {
    await loadCatalog('en')
    renderDialog(makeDoc())
    const text = await dialogText()
    for (const label of ['Uploaded by', 'Date', 'Size', 'Format']) {
      expect(text).toContain(label)
    }
  })

  it('Format row: PDF and images get a human name, MIME only in title (M-10)', async () => {
    const pdf = renderDialog(makeDoc({ mimeType: 'application/pdf' }))
    await dialogText()
    expect(screen.getByTitle('application/pdf')).toHaveTextContent('PDF')
    pdf.unmount()
    const jpeg = renderDialog(makeDoc({ mimeType: 'image/jpeg' }))
    await dialogText()
    expect(screen.getByTitle('image/jpeg')).toHaveTextContent('Зображення JPEG')
    jpeg.unmount()
    const heic = renderDialog(makeDoc({ mimeType: 'image/heic' }))
    await dialogText()
    expect(screen.getByTitle('image/heic')).toHaveTextContent('Зображення HEIC')
    heic.unmount()
    const png = renderDialog(makeDoc({ mimeType: 'image/png' }))
    await dialogText()
    expect(screen.getByTitle('image/png')).toHaveTextContent('Зображення PNG')
    png.unmount()
    renderDialog(makeDoc({ mimeType: 'image/webp' }))
    await dialogText()
    expect(screen.getByTitle('image/webp')).toHaveTextContent('Зображення WebP')
  })

  it('Format row: an unknown MIME never leaks as text', async () => {
    renderDialog(makeDoc({ mimeType: DOCX }))
    const text = await dialogText()
    expect(text).toContain('Інший формат')
    expect(text).not.toContain('openxmlformats')
    expect(screen.getByTitle(DOCX)).toBeInTheDocument()
  })

  it('en format names', async () => {
    await loadCatalog('en')
    renderDialog(makeDoc({ mimeType: 'image/jpeg' }))
    await dialogText()
    expect(screen.getByTitle('image/jpeg')).toHaveTextContent('JPEG image')
  })

  it('signed virtual contract shows signer + signing date in the active locale (no date-fns/ru)', async () => {
    const doc = makeDoc({
      category: 'CONTRACT',
      source: 'employee_contract',
      signedByName: 'Іван Петренко',
      signedAt: MID_MONTH,
    })
    const uk = renderDialog(doc)
    const ukText = await dialogText()
    expect(ukText).toContain('Підписант')
    expect(ukText).toContain('Іван Петренко')
    expect(ukText).toContain('Дата підписання')
    expect(ukText).toMatch(/15 березня 2026/)
    uk.unmount()
    await loadCatalog('en')
    renderDialog(doc)
    const enText = await dialogText()
    expect(enText).toContain('Signing date')
    expect(enText).toMatch(/15 March 2026/)
  })

  it('signing-date row carries the absolute date + time in its tooltip, same as the upload-date row', async () => {
    renderDialog(
      makeDoc({
        category: 'CONTRACT',
        source: 'employee_contract',
        signedByName: 'Іван Петренко',
        signedAt: MID_MONTH,
      }),
    )
    await dialogText()
    // upload-date row + signing-date row (both MID_MONTH)
    expect(screen.getAllByTitle(/2026.*\d{1,2}:\d{2}/)).toHaveLength(2)
  })

  it('a virtual contract without signedAt has no signing-date row', async () => {
    renderDialog(makeDoc({ category: 'CONTRACT', source: 'employee_contract', signedAt: null }))
    const text = await dialogText()
    expect(text).not.toContain('Дата підписання')
  })

  it('upload date: relative text + absolute date in the tooltip', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-15T14:00:00.000Z'))
    try {
      renderDialog(makeDoc())
      const text = await dialogText()
      expect(text).toMatch(/2 години тому|2 годин/)
      expect(screen.getByTitle(/2026.*\d{1,2}:\d{2}/)).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DocumentDetailDialog — project row (M-11)', () => {
  it('shows the project NAME; the id is only in the link title', async () => {
    apiGet.mockResolvedValue({ data: { id: PROJECT_ID, name: 'Alpha Platform' } })
    renderDialog(makeDoc({ projectId: PROJECT_ID }))
    const link = await screen.findByRole('link', { name: 'Alpha Platform' })
    expect(link).toHaveAttribute('title', PROJECT_ID)
    expect(link.textContent).not.toContain('#')
    expect(apiGet).toHaveBeenCalledWith(`/projects/${PROJECT_ID}`)
    expect(await dialogText()).toContain('Проєкт')
  })

  it('when the project cannot be read: generic label, never `#<id>`', async () => {
    const { qc } = renderDialog(makeDoc({ projectId: PROJECT_ID }))
    const link = await screen.findByTestId('document-detail-project-link')
    expect(link).toHaveTextContent('Відкрити проєкт')
    expect(link.textContent).not.toContain(PROJECT_ID.slice(-8))
    expect(link.textContent).not.toContain('#')
    // One failed attempt settles into `error` — no silent retry loop on a 403.
    await waitFor(() => expect(qc.getQueryState(['projects', PROJECT_ID])?.status).toBe('error'))
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('shares the project page cache key: the name lands under ["projects", id]', async () => {
    apiGet.mockResolvedValue({ data: { id: PROJECT_ID, name: 'Alpha Platform' } })
    const { qc } = renderDialog(makeDoc({ projectId: PROJECT_ID }))
    await screen.findByRole('link', { name: 'Alpha Platform' })
    expect(qc.getQueryData(['projects', PROJECT_ID])).toEqual({
      id: PROJECT_ID,
      name: 'Alpha Platform',
    })
  })

  it('does not fetch while the dialog is closed', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rootRoute = createRootRoute({
      component: () => (
        <DocumentDetailDialog
          open={false}
          onOpenChange={() => undefined}
          doc={makeDoc({ projectId: PROJECT_ID })}
          viewer={viewer}
        />
      ),
    })
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(
      <I18nTestProvider>
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nTestProvider>,
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('en generic label', async () => {
    await loadCatalog('en')
    renderDialog(makeDoc({ projectId: PROJECT_ID }))
    expect(await screen.findByTestId('document-detail-project-link')).toHaveTextContent(
      'Open project',
    )
  })

  it('no projectId → no project row and no request', async () => {
    renderDialog(makeDoc({ projectId: null }))
    await dialogText()
    expect(screen.queryByTestId('document-detail-project-link')).toBeNull()
    expect(apiGet).not.toHaveBeenCalled()
  })
})

describe('DocumentDetailDialog — no document', () => {
  it('doc=null renders nothing and requests nothing', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const rootRoute = createRootRoute({
      component: () => (
        <DocumentDetailDialog open onOpenChange={() => undefined} doc={null} viewer={viewer} />
      ),
    })
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(
      <I18nTestProvider>
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nTestProvider>,
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The router's default error boundary would also leave no dialog behind —
    // make sure the component simply rendered nothing instead of throwing.
    expect(screen.queryByText(/something went wrong/i)).toBeNull()
    expect(apiGet).not.toHaveBeenCalled()
  })
})

describe('DocumentDetailDialog — status, preview fallback, actions', () => {
  it('archived document: «В архіві» badge, not «В корзине»', async () => {
    renderDialog(makeDoc({ deletedAt: MID_MONTH }))
    const text = await dialogText()
    expect(text).toContain('В архіві')
    expect(text).not.toMatch(/корзин/)
  })

  it('non-previewable format: fallback sentence names the download action', async () => {
    renderDialog(makeDoc({ mimeType: DOCX }))
    expect(await dialogText()).toContain(
      'Попередній перегляд недоступний — натисніть «Завантажити», щоб відкрити файл',
    )
  })

  it('footer buttons: «Закрити» + «Завантажити»', async () => {
    renderDialog(makeDoc())
    await dialogText()
    expect(screen.getByTestId('document-detail-close')).toHaveTextContent('Закрити')
    expect(screen.getByTestId('document-detail-download')).toHaveTextContent('Завантажити')
  })

  it('uploader deleted (no display name): neutral «Видалений користувач» / «Deleted user», never an id', async () => {
    renderDialog(makeDoc({ uploadedByDisplayName: null }))
    expect(await screen.findByTestId('document-detail-uploader-link')).toHaveTextContent(
      'Видалений користувач',
    )
    await loadCatalog('en')
    renderDialog(makeDoc({ uploadedByDisplayName: null }))
    expect(
      (await screen.findAllByTestId('document-detail-uploader-link')).map((e) => e.textContent),
    ).toContain('Deleted user')
  })

  it('owner archive confirm uses the hub canon', async () => {
    renderDialog(makeDoc({ ownerId: VIEWER_ID }))
    fireEvent.click(await screen.findByTestId('document-detail-delete'))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Перенести в архів?')
    expect(screen.getByRole('button', { name: 'Перенести в архів' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('Документ піде в архів. Повернути його може адмін')
    expect(dialog.textContent).not.toMatch(/можна відновити|корзин/i)
  })

  it('ADMIN on an archived doc: restore + permanent delete, confirm without «S3»', async () => {
    renderDialog(makeDoc({ deletedAt: MID_MONTH }), admin)
    expect(await screen.findByTestId('document-detail-restore')).toHaveTextContent('Відновити')
    const hard = screen.getByTestId('document-detail-hard-delete')
    expect(hard).toHaveTextContent('Видалити назавжди')
    fireEvent.click(hard)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Видалити назавжди?')
    expect(dialog).toHaveTextContent('Файл буде видалено без можливості відновлення')
    expect(dialog.textContent).not.toMatch(/S3|баз[иі]/)
  })
})
