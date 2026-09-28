import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest'
import {
  render as rtlRender,
  screen,
  fireEvent,
  waitFor,
  within,
  type RenderResult,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { Toaster } from 'sonner'
import {
  formatDate,
  INVOICE_SIGN_IMPERSONATION_MESSAGE,
  type InvoiceDto,
  type SessionUser,
} from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { InvoiceDetailDialog } from '../invoice-detail-dialog'

beforeAll(async () => {
  await loadCatalog('uk')
})

// `InvoiceDetailDialog` calls `useLingui()` now — wrap every render (same
// pattern as `cascade-impact-panel.test.tsx`).
function render(ui: ReactElement): RenderResult {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

// ---------------------------------------------------------------------------
// Mocks — invoice + document hooks (network-free tests).
// ---------------------------------------------------------------------------

const mockSign = vi.fn()
const mockUseInvoice = vi.fn()

vi.mock('@/hooks/use-invoices', async (orig) => {
  const real = await orig<typeof import('@/hooks/use-invoices')>()
  return {
    ...real,
    useInvoice: (id: string | undefined) => mockUseInvoice(id),
    useSignInvoice: () => ({ mutate: mockSign, isPending: false }),
  }
})

// Use `about:blank` so happy-dom does not attempt a real DNS lookup for the
// iframe `src` — the URL is observable on the iframe element either way.
// InvoicePdfPreview uses useDocumentPreviewUrl (inline disposition) — keep
// useDocumentDownloadUrl in the mock so other callers don't break.
const mockUseDocumentPreviewUrl = vi.fn(
  (
    _documentId: string | undefined,
    _opts?: unknown,
  ): {
    data: { url: string } | undefined
    isLoading: boolean
    isError: boolean
    isRefetching: boolean
    refetch: () => void
  } => ({
    data: { url: 'about:blank' },
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  }),
)

vi.mock('@/hooks/use-documents', () => ({
  useDocumentDownloadUrl: () => ({
    data: { url: 'about:blank' },
    isLoading: false,
  }),
  useDocumentPreviewUrl: (documentId: string | undefined, opts?: unknown) =>
    mockUseDocumentPreviewUrl(documentId, opts),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const counterpartyUser: SessionUser = {
  id: '00000000-0000-0000-0000-00000000000a',
  email: 'employee@example.com',
  displayName: 'Иван Иванов',
  role: 'JUNIOR',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
  locale: 'uk',
}

const otherUser: SessionUser = {
  ...counterpartyUser,
  id: '00000000-0000-0000-0000-00000000000b',
  role: 'ADMIN',
  displayName: 'Admin',
}

/** Бэклог 212 (task-680 SR-M-4) — an ADMIN viewing AS the counterparty. */
const impersonatedCounterpartyUser: SessionUser = {
  ...counterpartyUser,
  impersonating: true,
}

const pendingInvoice: InvoiceDto = {
  transactionId: '00000000-0000-0000-0000-000000000001',
  documentId: '00000000-0000-0000-0000-0000000000d0',
  status: 'PENDING',
  type: 'SALARY',
  amount: '1500.00',
  currency: 'USDT',
  counterpartyId: counterpartyUser.id,
  counterpartyName: counterpartyUser.displayName,
  projectName: null,
  salaryMonth: '2026-05',
  createdAt: new Date('2026-05-26T10:00:00Z').toISOString(),
  signatures: [
    {
      id: 'sig-1',
      transactionId: '00000000-0000-0000-0000-000000000001',
      signerRole: 'COMPANY',
      signerId: 'admin-id',
      signerName: 'Maksym Y.',
      signedAt: new Date('2026-05-26T10:01:00Z').toISOString(),
      pdfHashShort: 'a1b2c3d4',
      method: 'AUTO_COMPANY',
    },
  ],
}

const signedInvoice: InvoiceDto = {
  ...pendingInvoice,
  status: 'SIGNED',
  signatures: [
    ...pendingInvoice.signatures,
    {
      id: 'sig-2',
      transactionId: pendingInvoice.transactionId,
      signerRole: 'COUNTERPARTY',
      signerId: counterpartyUser.id,
      signerName: counterpartyUser.displayName,
      signedAt: new Date('2026-05-26T11:00:00Z').toISOString(),
      pdfHashShort: 'a1b2c3d4',
      method: 'MANUAL_CLICK',
    },
  ],
}

// ---------------------------------------------------------------------------
// Render helper — minimal TanStack Router with createMemoryHistory so the
// `<Link>` inside InvoiceDetailDialog has a router context.
// ---------------------------------------------------------------------------

function renderDialog({
  invoice,
  viewer = counterpartyUser,
}: {
  invoice: InvoiceDto
  viewer?: SessionUser
}) {
  mockUseInvoice.mockReturnValue({ data: invoice, isLoading: false, error: null })

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Toaster />
        <InvoiceDetailDialog
          open
          onOpenChange={() => {}}
          transactionId={invoice.transactionId}
          viewer={viewer}
        />
      </>
    ),
  })
  // Stub child route for /invoice/v/$transactionId so the <Link /> resolves
  // to a real, registered path within the test router. Component is unused
  // (the test does not navigate).
  const childRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/invoice/v/$transactionId',
    component: () => null,
  })
  rootRoute.addChildren([childRoute])

  const memoryHistory = createMemoryHistory({ initialEntries: ['/'] })
  const router = createRouter({
    routeTree: rootRoute,
    history: memoryHistory,
  }) as unknown as Parameters<typeof RouterProvider>[0]['router']

  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSign.mockReset()
  mockUseInvoice.mockReset()
  mockUseDocumentPreviewUrl.mockClear()
})

describe('InvoiceDetailDialog', () => {
  it('renders PDF iframe with the presigned URL', async () => {
    renderDialog({ invoice: pendingInvoice })
    const iframe = (await screen.findByTitle('PDF рахунку')) as HTMLIFrameElement
    expect(iframe).toBeInTheDocument()
    expect(iframe.src).toContain('about:blank')
  })

  it('renders both signature rows with COMPANY signed and COUNTERPARTY pending', async () => {
    renderDialog({ invoice: pendingInvoice })
    expect(await screen.findByText('Maksym Y.')).toBeInTheDocument()
    // Round 4 fix #3 — pending COUNTERPARTY row shows the explicit
    // «Ожидает подписи» copy in a colSpan cell. The same string also
    // appears as the status badge label when invoice.status === 'PENDING'
    // (matching `STATUS_LABEL.PENDING`), so we assert ≥1 occurrence via
    // the data-testid for the pending signature row specifically.
    expect(screen.getByTestId('signature-row-counterparty-pending')).toHaveTextContent(
      'Очікує підпису',
    )
    // Fix-round 4 (task-680) — the method tooltip text was renamed from
    // «…инвойса» to «…счёта»; assert the exact string so a mutation to it
    // (e.g. StringLiteral -> "") fails the test instead of surviving.
    expect(
      within(screen.getByTestId('signature-row-company')).getByTitle(
        'Автоматичний електронний підпис компанії під час випуску рахунку',
      ),
    ).toBeInTheDocument()
  })

  it('shows the "Подписать счёт" button for the counterparty when no COUNTERPARTY sig exists', async () => {
    renderDialog({ invoice: pendingInvoice, viewer: counterpartyUser })
    expect(await screen.findByTestId('invoice-detail-sign-button')).toBeInTheDocument()
  })

  it('HIDES the «Подписать» button when viewer is NOT the counterparty', async () => {
    renderDialog({ invoice: pendingInvoice, viewer: otherUser })
    // Wait for the dialog to render then assert the button is absent.
    await screen.findByTestId('invoice-detail-status')
    expect(screen.queryByTestId('invoice-detail-sign-button')).not.toBeInTheDocument()
  })

  it('HIDES the «Подписать» button when a COUNTERPARTY signature already exists', async () => {
    renderDialog({ invoice: signedInvoice, viewer: counterpartyUser })
    await screen.findByTestId('invoice-detail-status')
    expect(screen.queryByTestId('invoice-detail-sign-button')).not.toBeInTheDocument()
    expect(screen.getByText('Документ підписано')).toBeInTheDocument()
  })

  it('opens the confirm dialog when «Подписать» is clicked', async () => {
    renderDialog({ invoice: pendingInvoice, viewer: counterpartyUser })
    const btn = await screen.findByTestId('invoice-detail-sign-button')
    await userEvent.click(btn)
    expect(await screen.findByTestId('invoice-sign-confirm-dialog')).toBeInTheDocument()
  })

  it('keeps Submit DISABLED until the agree checkbox is checked', async () => {
    renderDialog({ invoice: pendingInvoice, viewer: counterpartyUser })
    const btn = await screen.findByTestId('invoice-detail-sign-button')
    await userEvent.click(btn)
    const submit = await screen.findByTestId('invoice-sign-submit-button')
    expect(submit).toBeDisabled()
    const checkbox = screen.getByTestId('invoice-sign-agree-checkbox') as HTMLInputElement
    fireEvent.click(checkbox)
    await waitFor(() => expect(submit).not.toBeDisabled())
  })

  it('calls the sign mutation with the transactionId after confirmation', async () => {
    renderDialog({ invoice: pendingInvoice, viewer: counterpartyUser })
    const btn = await screen.findByTestId('invoice-detail-sign-button')
    await userEvent.click(btn)
    const checkbox = await screen.findByTestId('invoice-sign-agree-checkbox')
    fireEvent.click(checkbox)
    const submit = screen.getByTestId('invoice-sign-submit-button')
    await waitFor(() => expect(submit).not.toBeDisabled())
    await userEvent.click(submit)
    expect(mockSign).toHaveBeenCalledTimes(1)
    expect(mockSign).toHaveBeenCalledWith(pendingInvoice.transactionId, expect.any(Object))
  })

  describe('under impersonation (backlog 212, task-680 SR-M-4)', () => {
    it('shows the sign button DISABLED with the explanation banner; no request is sent on click', async () => {
      renderDialog({ invoice: pendingInvoice, viewer: impersonatedCounterpartyUser })

      const btn = await screen.findByTestId('invoice-detail-sign-button')
      expect(btn).toBeDisabled()
      expect(btn).toHaveAttribute('aria-disabled', 'true')
      expect(btn).toHaveAttribute('aria-describedby', 'invoice-sign-explain-impersonating')

      const banner = screen.getByTestId('invoice-sign-impersonating-banner')
      expect(banner).toHaveTextContent(`${INVOICE_SIGN_IMPERSONATION_MESSAGE}.`)
      expect(banner).toHaveAttribute('id', 'invoice-sign-explain-impersonating')

      // Neither the ordinary "signed" nor "counterparty-only" badge shows —
      // this is a THIRD, distinct state.
      expect(screen.queryByTestId('invoice-detail-signed-badge')).not.toBeInTheDocument()
      expect(screen.queryByTestId('invoice-detail-counterparty-only-badge')).not.toBeInTheDocument()

      // A disabled button does not fire its onClick handler in the DOM.
      fireEvent.click(btn)
      expect(screen.queryByTestId('invoice-sign-confirm-dialog')).not.toBeInTheDocument()
      expect(mockSign).not.toHaveBeenCalled()
    })

    it('renders no impersonation banner when NOT impersonating (isolates the impersonating gate)', async () => {
      renderDialog({ invoice: pendingInvoice, viewer: counterpartyUser })
      await screen.findByTestId('invoice-detail-sign-button')
      expect(screen.queryByTestId('invoice-sign-impersonating-banner')).not.toBeInTheDocument()
    })

    it('shows the counterparty-only badge, not the disabled sign button, for a non-counterparty impersonated viewer', async () => {
      const impersonatedNonCounterparty: SessionUser = { ...otherUser, impersonating: true }
      renderDialog({ invoice: pendingInvoice, viewer: impersonatedNonCounterparty })

      await screen.findByTestId('invoice-detail-status')
      expect(screen.queryByTestId('invoice-detail-sign-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('invoice-sign-impersonating-banner')).not.toBeInTheDocument()
      expect(screen.getByTestId('invoice-detail-counterparty-only-badge')).toBeInTheDocument()
    })

    it('shows the signed badge, not the disabled sign button, when impersonating after the invoice is already signed', async () => {
      renderDialog({ invoice: signedInvoice, viewer: impersonatedCounterpartyUser })

      await screen.findByTestId('invoice-detail-status')
      expect(screen.queryByTestId('invoice-detail-sign-button')).not.toBeInTheDocument()
      expect(screen.queryByTestId('invoice-sign-impersonating-banner')).not.toBeInTheDocument()
      expect(screen.getByTestId('invoice-detail-signed-badge')).toBeInTheDocument()
    })
  })

  describe('status/role/method/section labels (mutation-gate hardening)', () => {
    it('the status pill reads the PENDING label exactly', async () => {
      renderDialog({ invoice: pendingInvoice })
      expect(await screen.findByTestId('invoice-detail-status')).toHaveTextContent('Очікує підпису')
    })

    it('the status pill reads the SIGNED label exactly', async () => {
      renderDialog({ invoice: signedInvoice })
      expect(await screen.findByTestId('invoice-detail-status')).toHaveTextContent(
        'Підписано всіма',
      )
    })

    it('COMPANY/COUNTERPARTY role labels and the AUTO_COMPANY/MANUAL_CLICK short method + tooltip render exactly', async () => {
      renderDialog({ invoice: signedInvoice })
      const companyRow = await screen.findByTestId('signature-row-company')
      expect(companyRow).toHaveTextContent('Компанія')
      expect(companyRow).toHaveTextContent('Автоматично')
      expect(
        within(companyRow).getByTitle(
          'Автоматичний електронний підпис компанії під час випуску рахунку',
        ),
      ).toBeInTheDocument()

      const counterpartyRow = await screen.findByTestId('signature-row-counterparty')
      expect(counterpartyRow).toHaveTextContent('Контрагент')
      expect(counterpartyRow).toHaveTextContent('Вручну')
      expect(
        within(counterpartyRow).getByTitle('Підписано контрагентом вручну'),
      ).toBeInTheDocument()

      // The signed-at timestamp uses the 'dateTimeWithYear' formatDate style —
      // exact rendered string, so a StringLiteral mutant on the style key
      // (which would silently switch formats) fails.
      expect(counterpartyRow).toHaveTextContent(
        formatDate(signedInvoice.signatures[1]!.signedAt, 'uk', 'dateTimeWithYear'),
      )
    })

    it('the pending COUNTERPARTY row shows the COUNTERPARTY role label from the SAME map', async () => {
      renderDialog({ invoice: pendingInvoice })
      expect(await screen.findByTestId('signature-row-counterparty-pending')).toHaveTextContent(
        'Контрагент',
      )
    })

    it('the signature-list and public-verify sections expose their aria-labels', async () => {
      renderDialog({ invoice: pendingInvoice })
      await screen.findByTestId('invoice-detail-status')
      expect(screen.getByRole('region', { name: 'Підписи' })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Публічна верифікація' })).toBeInTheDocument()
    })

    it('passes the documentId and an enabled option derived from it to useDocumentPreviewUrl', async () => {
      renderDialog({ invoice: pendingInvoice })
      await screen.findByTestId('invoice-detail-status')
      expect(mockUseDocumentPreviewUrl).toHaveBeenCalledWith(pendingInvoice.documentId, {
        enabled: true,
      })
    })

    it('shows the retry fallback (not a broken iframe) when the PDF preview errors', async () => {
      mockUseDocumentPreviewUrl.mockReturnValueOnce({
        data: undefined,
        isLoading: false,
        isError: true,
        isRefetching: false,
        refetch: vi.fn(),
      })
      renderDialog({ invoice: pendingInvoice })
      expect(await screen.findByText('Не вдалося завантажити PDF')).toBeInTheDocument()
      expect(screen.getByTestId('invoice-pdf-retry')).toBeInTheDocument()
      expect(screen.queryByTitle('PDF рахунку')).not.toBeInTheDocument()
    })
  })
})
