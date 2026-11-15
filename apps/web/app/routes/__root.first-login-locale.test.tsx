/**
 * __root.first-login-locale.test.tsx — first login in a locale other than the pre-login one.
 *
 * `client.tsx` activates the pre-login locale (cookie / navigator.language) before first paint;
 * `/auth/me` then answers with the session's own `locale` and `AuthProvider` activates it. The
 * activation changes `LocaleScopedApp`'s `<Fragment key={locale}>`, which remounts the whole tree
 * (on purpose: see `__root.locale-remount.test.tsx`). Whatever the authenticated tree had rendered
 * in the old locale is torn down at that moment, with any state the user gave it.
 *
 * The real `LocaleScopedApp`, the real `AuthProvider` on a real `QueryClient`; only the network
 * (`/auth/me`) and the catalog chunk load (held open, to make the window observable) are faked.
 * `Outlet` renders `AuthProvider` around a probe that branches on `useAuth().isLoading` the way
 * `CrmLayout` (`routes/_authenticated/route.tsx`) does: pending UI while loading, the page after.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

let interactiveMounts = 0
let catalogGate: Promise<void> | null = null

vi.mock('@/lib/axios', () => ({ api: { get: vi.fn() } }))

// The catalog chunk load is the slow I/O between `/auth/me` answering and the locale being active;
// holding it open is what makes that window observable in a test. The real loader runs afterwards.
vi.mock('@/lib/i18n', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/i18n')>()
  return {
    ...original,
    activateLocale: vi.fn(async (locale: Parameters<typeof original.activateLocale>[0]) => {
      if (catalogGate) await catalogGate
      return original.activateLocale(locale)
    }),
  }
})

function Interactive() {
  useEffect(() => {
    interactiveMounts += 1
  }, [])
  return <input data-testid="probe-input" aria-label="probe" />
}

function Probe() {
  const { user, isLoading } = useAuth()
  if (isLoading || !user) return <div data-testid="probe-pending" />
  return <Interactive />
}

vi.mock('@tanstack/react-router', async () => {
  const { AuthProvider } = await import('@/context/auth')
  return {
    createRootRouteWithContext: () => (options: unknown) => options,
    Outlet: () => (
      <AuthProvider>
        <Probe />
      </AuthProvider>
    ),
  }
})

vi.mock('sonner', () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }))

import { api } from '@/lib/axios'
import { activateLocale, i18n, resetLocaleConfirmation } from '@/lib/i18n'
import { useAuth } from '@/context/auth'
import { LocaleScopedApp } from './__root'

const sessionUser = {
  id: 'a0000000-0000-4000-8000-000000000001',
  email: 'admin@cheekycheese.dev',
  displayName: 'Admin User',
  role: 'ADMIN',
  locale: 'uk',
}

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nTestProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </I18nTestProvider>
  )
  render(<LocaleScopedApp />, { wrapper })
}

beforeEach(async () => {
  catalogGate = null
  interactiveMounts = 0
  resetLocaleConfirmation()
  // Warm the `uk` chunk first: a cold transform of it can outlast `waitFor`'s timeout, and a
  // late activation would then leak into the next test.
  await loadCatalog('uk')
  await loadCatalog('en') // the pre-login locale `client.tsx` picked
  vi.mocked(activateLocale).mockClear()
  vi.mocked(api.get).mockResolvedValue({ status: 200, data: sessionUser })
})

describe('first login — the server locale applies without destroying user state', () => {
  it('shows nothing interactive until the session locale is active, then mounts the page once', async () => {
    let release = () => {}
    catalogGate = new Promise<void>((resolve) => {
      release = resolve
    })
    renderApp()

    // `/auth/me` answered with `uk`; its catalog is still loading. Anything the user can reach now
    // would be torn down by the remount the activation causes.
    await waitFor(() => expect(activateLocale).toHaveBeenCalledWith('uk'))
    expect(screen.queryByTestId('probe-input')).toBeNull()
    expect(screen.getByTestId('probe-pending')).toBeInTheDocument()

    await act(async () => {
      release()
    })
    await waitFor(() => expect(i18n.locale).toBe('uk'))
    const input = await screen.findByTestId('probe-input')
    fireEvent.change(input, { target: { value: 'typed by the user' } })

    // Only an activation changes the `<Fragment key>`, and the effect that would start a second one
    // has already run with the commit that showed the input: one call means no remount is coming.
    expect(activateLocale).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId<HTMLInputElement>('probe-input').value).toBe('typed by the user')
    expect(interactiveMounts).toBe(1)
  })

  it('renders the page at once, with no activation, when the session locale already matches', async () => {
    vi.mocked(api.get).mockResolvedValue({ status: 200, data: { ...sessionUser, locale: 'en' } })
    renderApp()

    await screen.findByTestId('probe-input')
    expect(activateLocale).not.toHaveBeenCalled()
    expect(interactiveMounts).toBe(1)
  })

  it('releases the pending UI when the session catalog fails to load, keeping the old locale', async () => {
    vi.mocked(activateLocale).mockRejectedValueOnce(new Error('chunk load failed'))
    renderApp()

    await screen.findByTestId('probe-input')
    expect(i18n.locale).toBe('en')
    expect(interactiveMounts).toBe(1)
  })
})
