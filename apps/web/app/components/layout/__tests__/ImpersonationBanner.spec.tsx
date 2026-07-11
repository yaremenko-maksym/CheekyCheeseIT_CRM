import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Unit tests for ImpersonationBanner component (admin-impersonation feature).
 *
 * Covers:
 *   B1. Renders when user.impersonating is true
 *   B2. Shows impersonated user's name and role
 *   B3. Shows return button with correct testid
 *   B4. Calls POST /auth/stop-impersonating on button click
 *   B5. Shows pending state while mutation is in-flight
 *   B6. Shows error toast on failure
 */

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/axios', () => ({
  api: {
    post: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}))

// Framer-motion: render children without animation to avoid timer issues
vi.mock('framer-motion', () => ({
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'
import { ImpersonationBanner } from '../ImpersonationBanner'
import type { SessionUser } from '@crm/shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const MOCK_USER: SessionUser = {
  id: 'senior-uuid',
  email: 'senior@test.com',
  displayName: 'Иван Старший',
  role: 'SENIOR',
  avatarUrl: null,
  avatarDocumentId: null,
  legalFullName: null,
  seniorSharePercent: 26,
  impersonating: true,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImpersonationBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset window.location.href assignments
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { href: '/' },
    })
  })

  it('B1. renders the banner with correct testid', () => {
    render(<ImpersonationBanner user={MOCK_USER} onStopped={vi.fn()} />, { wrapper })
    expect(screen.getByTestId('impersonation-banner')).toBeInTheDocument()
  })

  it('B2. shows impersonated user displayName and role label', () => {
    render(<ImpersonationBanner user={MOCK_USER} onStopped={vi.fn()} />, { wrapper })
    expect(screen.getByText(/«Иван Старший»/)).toBeInTheDocument()
    expect(screen.getByText(/Синьор/)).toBeInTheDocument()
  })

  it('B3. shows return button with correct testid and aria-label', () => {
    render(<ImpersonationBanner user={MOCK_USER} onStopped={vi.fn()} />, { wrapper })
    const btn = screen.getByTestId('impersonation-banner-return')
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-label', 'Вернуться в свой профиль')
  })

  it('B4. calls POST /auth/stop-impersonating when return button clicked', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    render(<ImpersonationBanner user={MOCK_USER} onStopped={vi.fn()} />, { wrapper })

    await user.click(screen.getByTestId('impersonation-banner-return'))

    expect(api.post).toHaveBeenCalledWith('/auth/stop-impersonating')
  })

  it('B5. button shows pending text while mutation is in-flight', async () => {
    // Never resolve so we can observe pending state
    vi.mocked(api.post).mockImplementation(() => new Promise(() => {}))
    const user = userEvent.setup()
    render(<ImpersonationBanner user={MOCK_USER} onStopped={vi.fn()} />, { wrapper })

    await user.click(screen.getByTestId('impersonation-banner-return'))

    expect(screen.getByTestId('impersonation-banner-return')).toBeDisabled()
    expect(screen.getByText('Возврат...')).toBeInTheDocument()
  })

  it('B6. shows error toast on stop-impersonating failure', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('Network error'))
    const onStopped = vi.fn()
    const user = userEvent.setup()
    render(<ImpersonationBanner user={MOCK_USER} onStopped={onStopped} />, { wrapper })

    await user.click(screen.getByTestId('impersonation-banner-return'))

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Network error'))
    expect(onStopped).toHaveBeenCalled()
  })

  it('B7. banner has role=alert for accessibility', () => {
    render(<ImpersonationBanner user={MOCK_USER} onStopped={vi.fn()} />, { wrapper })
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('B8. shows correct label for HR role', () => {
    render(
      <ImpersonationBanner
        user={{ ...MOCK_USER, role: 'HR', displayName: 'Олена HR' }}
        onStopped={vi.fn()}
      />,
      { wrapper },
    )
    expect(screen.getByText(/«Олена HR»/)).toBeInTheDocument()
    // The role span shows "(HR)" — check it's present as a parenthesised label
    expect(screen.getByText(/\(HR\)/)).toBeInTheDocument()
  })
})
