import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { Toaster } from 'sonner'
import type { InvoiceDto, SessionUser } from '@crm/shared'
import { InvoiceDetailDialog } from '../invoice-detail-dialog'

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
vi.mock('@/hooks/use-documents', () => ({
  useDocumentDownloadUrl: () => ({
    data: { url: 'about:blank' },
    isLoading: false,
  }),
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
}

const otherUser: SessionUser = {
  ...counterpartyUser,
  id: '00000000-0000-0000-0000-00000000000b',
  role: 'ADMIN',
  displayName: 'Admin',
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
})

describe('InvoiceDetailDialog', () => {
  it('renders PDF iframe with the presigned URL', async () => {
    renderDialog({ invoice: pendingInvoice })
    const iframe = (await screen.findByTitle('Инвойс PDF')) as HTMLIFrameElement
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
      'Ожидает подписи',
    )
  })

  it('shows the "Подписать инвойс" button for the counterparty when no COUNTERPARTY sig exists', async () => {
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
    expect(screen.getByText('Документ подписан')).toBeInTheDocument()
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
})
