import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Fix-раунд 3 (task-680, SR-M-3). Same shape as `SignContractStep.spec.tsx`'s
 * impersonation coverage — under «войти как» the accept button is disabled,
 * the explanation is visible, and no accept request is ever sent.
 *
 * WHY vi.mock factories below reference module-level `const` bindings
 * declared AFTER the `vi.mock()` call — same rationale as
 * `SignContractStep.spec.tsx`: vitest hoists the `vi.mock()` CALL, not the
 * factory BODY, which only runs on first import (after every top-level
 * binding in this file is already initialised).
 */

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

const mockUser: { id: string; role: 'SENIOR'; impersonating: boolean } = {
  id: 'test-user-id',
  role: 'SENIOR',
  impersonating: false,
}
let userIsNull = false

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: userIsNull ? null : mockUser }),
}))

// Import AFTER vi.mock declarations so hoisting resolves correctly.
import { TOS_ACCEPT_IMPERSONATION_MESSAGE } from '@crm/shared'
import { api } from '@/lib/axios'
import { AcceptTosStep } from './AcceptTosStep'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

const TOS_VERSION = { id: 'tos-1', version: 1, bodyMarkdown: '# Terms', isActive: true }

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AcceptTosStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mockUser, { impersonating: false })
    userIsNull = false
    vi.mocked(api.get).mockResolvedValue({ data: TOS_VERSION })
  })

  it('renders the accept button and checkbox once ToS loads', async () => {
    render(<AcceptTosStep onSuccess={vi.fn()} />, { wrapper })

    await waitFor(() => expect(screen.getByTestId('accept-tos-button')).toBeInTheDocument())
    expect(screen.getByTestId('accept-tos-checkbox')).toBeInTheDocument()
  })

  describe('under impersonation (backlog 212)', () => {
    beforeEach(() => {
      mockUser.impersonating = true
    })

    it('disables the accept button and shows the explanation; no request is sent', async () => {
      render(<AcceptTosStep onSuccess={vi.fn()} />, { wrapper })

      const button = await screen.findByTestId('accept-tos-button')
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).toHaveAttribute('aria-describedby', 'accept-tos-explain-impersonating')

      const banner = screen.getByTestId('accept-tos-impersonating-banner')
      expect(banner).toHaveTextContent(`${TOS_ACCEPT_IMPERSONATION_MESSAGE}.`)
      expect(banner).toHaveAttribute('id', 'accept-tos-explain-impersonating')

      // Even checking the confirm box (the only other gate) must not enable
      // the accept request — impersonation overrides every other condition.
      const checkbox = screen.getByTestId('accept-tos-checkbox')
      checkbox.click()

      expect(screen.getByTestId('accept-tos-button')).toBeDisabled()
      // A disabled button does not fire its onClick handler in the DOM.
      button.click()
      expect(api.post).not.toHaveBeenCalled()
    })
  })

  describe('without impersonation', () => {
    it('renders no impersonation banner and gates the button only by the checkbox', async () => {
      render(<AcceptTosStep onSuccess={vi.fn()} />, { wrapper })

      await screen.findByTestId('accept-tos-button')
      expect(screen.queryByTestId('accept-tos-impersonating-banner')).not.toBeInTheDocument()
      expect(screen.getByTestId('accept-tos-button')).toBeDisabled()

      const checkbox = screen.getByTestId('accept-tos-checkbox')
      checkbox.click()

      await waitFor(() => expect(screen.getByTestId('accept-tos-button')).not.toBeDisabled())
    })

    it('handles a null user without throwing (optional-chaining safety, backlog 212)', async () => {
      userIsNull = true

      expect(() => render(<AcceptTosStep onSuccess={vi.fn()} />, { wrapper })).not.toThrow()
      await screen.findByTestId('accept-tos-button')
      // No impersonation is possible without a session user.
      expect(screen.queryByTestId('accept-tos-impersonating-banner')).not.toBeInTheDocument()
    })
  })

  /**
   * Backlog 212 mutation coverage — `aria-disabled` mirrors the `disabled`
   * prop through a SEPARATE JSX expression (same source condition, two AST
   * nodes) — Stryker mutates them independently, so an assertion on
   * `disabled` alone does not kill a mutant that only changes
   * `aria-disabled`. Each test below asserts `aria-disabled` explicitly.
   */
  describe('aria-disabled — one-gate-at-a-time isolation (backlog 212)', () => {
    it('disabled while unconfirmed, even without impersonation (isolates !accepted)', async () => {
      render(<AcceptTosStep onSuccess={vi.fn()} />, { wrapper })

      const button = await screen.findByTestId('accept-tos-button')
      // Checkbox left unchecked.
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-disabled', 'true')
    })

    it('enabled once accepted and not impersonating (aria-disabled reflects the enabled state)', async () => {
      render(<AcceptTosStep onSuccess={vi.fn()} />, { wrapper })

      const button = await screen.findByTestId('accept-tos-button')
      const checkbox = screen.getByTestId('accept-tos-checkbox')
      checkbox.click()

      await waitFor(() => expect(button).not.toBeDisabled())
      expect(button).toHaveAttribute('aria-disabled', 'false')
    })
  })
})
