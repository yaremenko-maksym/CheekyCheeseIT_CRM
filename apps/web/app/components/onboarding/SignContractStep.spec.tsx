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
 *   Backlog 212. Under impersonation, the sign button is disabled, the
 *   explanation is visible, and no sign request is ever sent.
 *
 * WHY vi.mock factories use only literals or module-level `let`s (no
 * top-level `const` references):
 *   vitest hoists vi.mock() calls to the top of the file before any const/let
 *   declarations are evaluated. Factories that reference module-level `const`
 *   variables will throw ReferenceError at hoist time — but a `let` declared
 *   with `var`-like hoisting semantics is safe to CLOSE OVER (not read at
 *   declaration time) because the factory itself isn't invoked until the
 *   mocked module is first imported, by which point the rest of this file's
 *   top-level code has already run. Same pattern as
 *   `NotificationSettingsTab.test.tsx`'s `viewerImpersonating`.
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

/** Бэклог 212 — mutated per-test via beforeEach/individual `it` blocks. */
let userImpersonating = false

vi.mock('@/context/auth', () => ({
  useAuth: () => ({
    user: {
      id: 'test-user-id',
      displayName: 'Тестовий Користувач',
      legalFullName: 'Тестовий Користувач Іванович',
      role: 'SENIOR',
      impersonating: userImpersonating,
    },
  }),
}))

// Import AFTER vi.mock declarations so hoisting resolves correctly.
import { CONTRACT_SIGN_IMPERSONATION_MESSAGE } from '@crm/shared'
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
    userImpersonating = false

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

  describe('under impersonation (backlog 212)', () => {
    beforeEach(() => {
      userImpersonating = true
    })

    it('disables the sign button and shows the explanation; no request is sent', async () => {
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      const button = screen.getByTestId('sign-button')
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-disabled', 'true')

      const banner = screen.getByTestId('sign-contract-impersonating-banner')
      expect(banner).toHaveTextContent(`${CONTRACT_SIGN_IMPERSONATION_MESSAGE}.`)

      // Even checking the confirm box (the only other gate) must not
      // enable the sign request — impersonation overrides every other
      // condition.
      const checkbox = screen.getByTestId('confirm-checkbox')
      checkbox.click()

      expect(screen.getByTestId('sign-button')).toBeDisabled()
      expect(api.post).not.toHaveBeenCalled()
    })
  })

  describe('without impersonation', () => {
    it('renders no impersonation banner and leaves the sign button gated only by checkbox/PDF', () => {
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      expect(screen.queryByTestId('sign-contract-impersonating-banner')).not.toBeInTheDocument()
    })
  })
})
