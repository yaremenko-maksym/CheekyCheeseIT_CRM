import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * Unit tests for SignContractStep — A3-4 Task 4.
 *
 * Verifies:
 *   T4a. PDF is fetched from `/onboarding/contract/pdf` (not the old
 *        `/contracts/preview-pdf` which was the A2-era endpoint).
 *   T4b. Checkbox label says "персональний контракт" (not "MSA-контракт").
 *   T4c. No "MSA" text surfaces to the user (brand-accurate copy).
 *   T4d. Component renders the sign button and confirm checkbox.
 *
 * WHY vi.mock factories use only literals (no top-level var references):
 *   vitest hoists vi.mock() calls to the top of the file before any const/let
 *   declarations are evaluated. Factories that reference module-level variables
 *   will throw ReferenceError at hoist time. Use vi.fn() inline in factories
 *   and access the mocked module's exports after import to get spy references.
 */

// ---------------------------------------------------------------------------
// Module mocks — factories use only vi.fn() literals (no hoisting issue).
// ---------------------------------------------------------------------------

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

vi.mock('@/context/auth', () => ({
  useAuth: () => ({
    user: {
      id: 'test-user-id',
      displayName: 'Тестовий Користувач',
      legalFullName: 'Тестовий Користувач Іванович',
      role: 'SENIOR',
    },
  }),
}))

// Import AFTER vi.mock declarations so hoisting resolves correctly.
import { api } from '@/lib/axios'
import { SignContractStep } from './SignContractStep'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  )
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SignContractStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: api.get resolves with a Blob — component won't enter error state.
    vi.mocked(api.get).mockResolvedValue({
      data: new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
    })

    // URL.createObjectURL / revokeObjectURL not available in happy-dom.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
    globalThis.URL.revokeObjectURL = vi.fn()
  })

  it('T4a. fetches PDF from /onboarding/contract/pdf (not /contracts/preview-pdf)', () => {
    render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

    expect(api.get).toHaveBeenCalledWith('/onboarding/contract/pdf', { responseType: 'blob' })
    expect(api.get).not.toHaveBeenCalledWith(
      expect.stringContaining('/contracts/preview-pdf'),
      expect.anything(),
    )
  })

  it('T4b. checkbox label says "персональний контракт" (not MSA)', () => {
    render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

    const label = screen.getByTestId('confirm-checkbox-label')
    expect(label.textContent).toContain('персонального контракта')
    expect(label.textContent).not.toContain('MSA')
  })

  it('T4c. no "MSA" text is visible anywhere in the rendered output', () => {
    const { container } = render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

    // All visible text + attributes (aria-label, title) must not contain "MSA".
    expect(container.innerHTML).not.toContain('MSA')
  })

  it('T4d. renders sign button and confirm checkbox', () => {
    render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

    expect(screen.getByTestId('sign-button')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-checkbox')).toBeInTheDocument()
  })
})
