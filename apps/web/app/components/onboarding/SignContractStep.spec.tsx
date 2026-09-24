import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
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
 * WHY vi.mock factories below reference module-level `let`/`const`
 * bindings declared AFTER the `vi.mock()` call:
 *   vitest hoists the `vi.mock()` CALL to the top of the file, but the
 *   factory function's BODY only runs later, when the mocked module is
 *   first imported — by which point every top-level `const`/`let` in this
 *   file has already been initialised. Referencing such a binding is safe
 *   for either keyword; what would NOT be safe is reading it at the
 *   `vi.mock()` call site itself (temporal dead zone), which none of these
 *   factories do. Same pattern as `NotificationSettingsTab.test.tsx`'s
 *   `viewerImpersonating`.
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

/**
 * task-i18n-stage4-task3 — the onError branch reads `getApiErrorCode(err)`
 * (envelope `code`) instead of substring-matching `err.message`; mocking
 * `sonner` lets the two new tests below assert WHICH toast fired for
 * `LEGAL_NAME_REQUIRED` vs `ADMIN_DOES_NOT_SIGN_CONTRACTS` without a real
 * toast provider mounted.
 */
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

/**
 * Бэклог 212 — a STABLE object reference, mutated in place (never
 * reassigned to a new literal) via `Object.assign`. `useAuth()`'s mock used
 * to return a FRESH `{ user: {...} }` literal on every call — unlike the
 * real hook (TanStack Query caches and returns the SAME object across
 * renders until the data actually changes). `SignContractStep`'s PDF-fetch
 * `useEffect(..., [user])` sees a new `user` identity on every re-render
 * with the fresh-literal mock, so a checkbox click (which re-renders the
 * component) re-fires the effect, cancels the in-flight fetch, and never
 * lets `pdfError`/`blobUrl` settle — every `waitFor` in the isolation
 * matrix below timed out against that mock. A stable reference fixes it at
 * the root instead of working around it per test.
 */
const mockUser: {
  id: string
  displayName: string
  legalFullName: string | null
  role: 'SENIOR'
  impersonating: boolean
} = {
  id: 'test-user-id',
  displayName: 'Тестовий Користувач',
  legalFullName: 'Тестовий Користувач Іванович',
  role: 'SENIOR',
  impersonating: false,
}
/** Optional-chaining safety net (`user?.impersonating`) — see the null-user test below. */
let userIsNull = false

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: userIsNull ? null : mockUser }),
}))

// Import AFTER vi.mock declarations so hoisting resolves correctly.
import { API_ERROR_MESSAGES } from '@crm/shared'
import { toast } from 'sonner'
import { api } from '@/lib/axios'
import { SignContractStep } from './SignContractStep'

// COPY-H-1 (PR #702 fix-round 1): the sign-mutation onError branches now
// call `getApiErrorMessage(err)` (catalog translation by `code`) instead of
// a hardcoded Russian literal — `translateApiError` (axios-utils.ts) throws
// if no locale is activated, same requirement as `axios-utils.spec.ts`'s
// identical setup for the same reason.
beforeAll(() => {
  i18n.load('uk', {})
  i18n.activate('uk')
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>
  )
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SignContractStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mockUser, {
      legalFullName: 'Тестовий Користувач Іванович',
      impersonating: false,
    })
    userIsNull = false

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
    expect(label.textContent).toContain('персонального контракту')
    expect(label.textContent).not.toContain('MSA')
  })

  it('T4c. no "MSA" text is visible anywhere in the rendered output', () => {
    const { container } = render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

    // All visible text + attributes (aria-label, title) must not contain "MSA".
    expect(container.innerHTML).not.toContain('MSA')
  })

  // COPY-M-16 (PR #702 fix-round 3): COPY-M-15 fixed the raw `ADMIN` enum in
  // the legalNameMissing alert but left an identical leak three lines above
  // it, in the unconditional "Info alert" paragraph — that one renders on
  // EVERY open of this step, unlike the alert above it (which only renders
  // when the admin left legalFullName blank), so it was the more visible of
  // the two. Scoping the assertion to the whole rendered step (not one
  // testid) is what COPY-M-15's narrower assertion missed.
  it('no raw role enum anywhere in the rendered step (COPY-M-16)', () => {
    render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

    expect(screen.queryByText(/\b(ADMIN|SENIOR|JUNIOR|ACCOUNTANT|DROP)\b/)).toBeNull()
  })

  it('T4d. renders sign button and confirm checkbox', () => {
    render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

    expect(screen.getByTestId('sign-button')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-checkbox')).toBeInTheDocument()
  })

  describe('under impersonation (backlog 212)', () => {
    beforeEach(() => {
      mockUser.impersonating = true
    })

    it('disables the sign button and shows the explanation; no request is sent', async () => {
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      const button = screen.getByTestId('sign-button')
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('aria-disabled', 'true')
      // Exact id (not just "some" describedby) — pins the shared literal's
      // id constant against the StringLiteral mutant that empties it.
      expect(button).toHaveAttribute('aria-describedby', 'sign-contract-explain-impersonating')

      const banner = screen.getByTestId('sign-contract-impersonating-banner')
      expect(banner).toHaveTextContent(i18n._(API_ERROR_MESSAGES.CONTRACT_SIGN_IMPERSONATION))
      expect(banner).toHaveAttribute('id', 'sign-contract-explain-impersonating')

      // Even checking the confirm box (the only other gate) must not
      // enable the sign request — impersonation overrides every other
      // condition.
      const checkbox = screen.getByTestId('confirm-checkbox')
      checkbox.click()

      expect(screen.getByTestId('sign-button')).toBeDisabled()
      expect(api.post).not.toHaveBeenCalled()
    })

    it('stays disabled purely because of impersonation, even with every other gate satisfied', async () => {
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      // Clear every OTHER gate: PDF loaded, box checked, legal name present
      // (set by the outer beforeEach), pdfError false (default) — isolates
      // the `impersonating` OR-term from the rest of `isSignDisabled`.
      // PDF "loaded" signal: happy-dom's iframe never fires a real onLoad
      // (disableIframePageLoading), so isLoadingPdf never flips — but
      // isSignDisabled only reads `blobUrl`, and createObjectURL is called
      // synchronously right before setBlobUrl once the fetch resolves.
      await waitFor(() => expect(globalThis.URL.createObjectURL).toHaveBeenCalled())
      const checkbox = screen.getByTestId('confirm-checkbox')
      checkbox.click()

      expect(screen.getByTestId('sign-button')).toBeDisabled()
    })
  })

  describe('without impersonation', () => {
    it('renders no impersonation banner and leaves the sign button gated only by checkbox/PDF', () => {
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      expect(screen.queryByTestId('sign-contract-impersonating-banner')).not.toBeInTheDocument()
    })

    it('handles a null user without throwing (optional-chaining safety, backlog 212)', () => {
      userIsNull = true

      expect(() => render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })).not.toThrow()
      // No impersonation is possible without a session user.
      expect(screen.queryByTestId('sign-contract-impersonating-banner')).not.toBeInTheDocument()
    })
  })

  /**
   * Бэклог 212 mutation coverage — `isSignDisabled` (SignContractStep.tsx)
   * ORs six independent gates together. Each test below flips EXACTLY ONE
   * gate away from "all clear" (confirmed + PDF loaded + no pdfError + legal
   * name present + not impersonating) and asserts the button is disabled —
   * isolating that gate's contribution kills both the OR↔AND
   * (LogicalOperator) and the literal-replacement (BooleanLiteral /
   * ConditionalExpression) mutants Stryker generates for this line.
   */
  describe('isSignDisabled — one-gate-at-a-time isolation (backlog 212)', () => {
    it('enabled once every gate clears: confirmed + PDF loaded + legal name present + not impersonating', async () => {
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      // PDF "loaded" signal: happy-dom's iframe never fires a real onLoad
      // (disableIframePageLoading), so isLoadingPdf never flips — but
      // isSignDisabled only reads `blobUrl`, and createObjectURL is called
      // synchronously right before setBlobUrl once the fetch resolves.
      await waitFor(() => expect(globalThis.URL.createObjectURL).toHaveBeenCalled())
      const checkbox = screen.getByTestId('confirm-checkbox')
      checkbox.click()

      await waitFor(() => expect(screen.getByTestId('sign-button')).not.toBeDisabled())
    })

    it('disabled while unconfirmed, even after the PDF has loaded (isolates !confirmed)', async () => {
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      // PDF "loaded" signal: happy-dom's iframe never fires a real onLoad
      // (disableIframePageLoading), so isLoadingPdf never flips — but
      // isSignDisabled only reads `blobUrl`, and createObjectURL is called
      // synchronously right before setBlobUrl once the fetch resolves.
      await waitFor(() => expect(globalThis.URL.createObjectURL).toHaveBeenCalled())
      // Checkbox left unchecked.
      expect(screen.getByTestId('sign-button')).toBeDisabled()
    })

    it('disabled while the PDF has not loaded yet, even when confirmed (isolates !blobUrl)', () => {
      // Never resolves within this test — blobUrl stays null.
      vi.mocked(api.get).mockReturnValue(new Promise(() => {}))
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      const checkbox = screen.getByTestId('confirm-checkbox')
      checkbox.click()

      expect(screen.getByTestId('sign-button')).toBeDisabled()
    })

    it('disabled when the PDF preview fails to load, even when confirmed (isolates pdfError)', async () => {
      vi.mocked(api.get).mockRejectedValue(new Error('boom'))
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      await waitFor(() => expect(screen.getByTestId('pdf-error')).toBeInTheDocument())
      const checkbox = screen.getByTestId('confirm-checkbox')
      checkbox.click()

      expect(screen.getByTestId('sign-button')).toBeDisabled()
    })

    it('disabled when legalFullName is missing, even when confirmed + PDF loaded (isolates legalNameMissing)', async () => {
      mockUser.legalFullName = null
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      // PDF "loaded" signal: happy-dom's iframe never fires a real onLoad
      // (disableIframePageLoading), so isLoadingPdf never flips — but
      // isSignDisabled only reads `blobUrl`, and createObjectURL is called
      // synchronously right before setBlobUrl once the fetch resolves.
      await waitFor(() => expect(globalThis.URL.createObjectURL).toHaveBeenCalled())
      const checkbox = screen.getByTestId('confirm-checkbox')
      checkbox.click()

      expect(screen.getByTestId('sign-button')).toBeDisabled()
    })

    // COPY-M-15 (PR #702 fix-round 2): the legalNameMissing alert used to
    // read "...Обратитесь к ADMIN." — a raw role enum leaking into text
    // meant for a human. It must read the role as a word, matching the
    // pdf-error alert and the tooltip, which already said "администратору"
    // before this fix. (The Info-alert paragraph above it still said
    // "ADMIN" at the time this test was written — that leak is COPY-M-16,
    // fixed separately, see the whole-step assertion below.)
    it('legalNameMissing alert reads the role as a word, no raw "ADMIN" enum (COPY-M-15)', async () => {
      mockUser.legalFullName = null
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      const alert = await screen.findByTestId('legal-name-missing-alert')
      expect(alert).toHaveTextContent('заповнить адміністратор')
      expect(alert.textContent).not.toMatch(/\bADMIN\b/)
    })
  })

  /**
   * task-i18n-stage4-task3 — the sign mutation's onError branches on
   * `getApiErrorCode(err)` (server envelope `code`) instead of
   * `err.message.includes(...)`. These pin the two codes the server
   * actually throws (`signed-contracts.service.ts`) to their toast.
   */
  describe('sign mutation onError — branches on envelope code (task-i18n-stage4-task3)', () => {
    async function clickSign() {
      await waitFor(() => expect(globalThis.URL.createObjectURL).toHaveBeenCalled())
      const checkbox = screen.getByTestId('confirm-checkbox')
      checkbox.click()
      await waitFor(() => expect(screen.getByTestId('sign-button')).not.toBeDisabled())
      const signButton = screen.getByTestId('sign-button')
      signButton.click()
    }

    it('LEGAL_NAME_REQUIRED shows the legal-name error toast', async () => {
      vi.mocked(api.post).mockRejectedValue({
        response: {
          status: 400,
          data: { statusCode: 400, code: 'LEGAL_NAME_REQUIRED', message: 'x' },
        },
      })
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      await clickSign()

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(i18n._(API_ERROR_MESSAGES.LEGAL_NAME_REQUIRED)),
      )
      expect(toast.info).not.toHaveBeenCalled()
    })

    it('ADMIN_DOES_NOT_SIGN_CONTRACTS shows the admin-info toast, not the generic error', async () => {
      vi.mocked(api.post).mockRejectedValue({
        response: {
          status: 400,
          data: { statusCode: 400, code: 'ADMIN_DOES_NOT_SIGN_CONTRACTS', message: 'x' },
        },
      })
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      await clickSign()

      await waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith(
          i18n._(API_ERROR_MESSAGES.ADMIN_DOES_NOT_SIGN_CONTRACTS),
        ),
      )
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('an unrelated code falls through to the generic failure toast', async () => {
      vi.mocked(api.post).mockRejectedValue({
        response: {
          status: 500,
          data: { statusCode: 500, code: 'GENERIC', message: 'x' },
        },
      })
      render(<SignContractStep onSuccess={vi.fn()} />, { wrapper })

      await clickSign()

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не вдалося підписати контракт'))
    })
  })
})
