/**
 * routes/_authenticated/route.tsx — unit tests for `CrmLayout`'s header
 * (mobile-menu button, user-menu trigger, profile/logout links).
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). This file had ZERO
 * tests before this round — flagged in "Remaining gap, itemized" (0 survived
 * / 6 no-coverage on a scoped `mutation:changed` run). Covers only what this
 * round's diff touches: the four migrated i18n strings in the header. Heavy
 * dependencies (sidebar, notifications bell, onboarding banner, avatar) are
 * stubbed so this isolates `CrmLayout`'s OWN render logic — each has its own
 * dedicated test file already.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SessionUser } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

function render(ui: ReactElement, options?: RenderOptions) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <I18nTestProvider>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </I18nTestProvider>
    ),
    ...options,
  })
}

beforeEach(async () => {
  await loadCatalog('uk')
})

const MOCK_USER: SessionUser = {
  id: 'admin-uuid',
  email: 'admin@test.com',
  displayName: 'Admin Testovych',
  role: 'ADMIN',
  avatarUrl: null,
  avatarDocumentId: null,
  legalFullName: null,
  seniorSharePercent: 0,
  locale: 'uk',
  impersonating: false,
}

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: MOCK_USER, isLoading: false }),
  AuthProvider: ({ children }: React.PropsWithChildren) => children,
}))

vi.mock('@/context/notifications', () => ({
  NotificationsProvider: ({ children }: React.PropsWithChildren) => children,
}))

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useRouterState: () => ({ pathname: '/' }),
    Outlet: () => <div data-testid="mock-outlet" />,
    Link: ({
      children,
      to,
      ...props
    }: React.PropsWithChildren<{ to: string } & Record<string, unknown>>) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  }
})

vi.mock('@/lib/use-logout', () => ({
  useLogout: () => vi.fn(),
}))

vi.mock('@/context/onboarding', () => ({
  useOnboardingGate: () => ({ isComplete: true }),
}))

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({
      data: {
        requiresContract: false,
        requiresTos: false,
        contractReady: false,
        contractTemplate: null,
        tosVersion: null,
        tosUpdateAvailable: false,
        latestTosVersion: null,
      },
    }),
  },
}))

// Heavy siblings — each has its own dedicated test file; stub so this file
// exercises only CrmLayout's own header markup.
vi.mock('@/components/crm/nav-sidebar', () => ({
  NavSidebar: () => <div data-testid="mock-nav-sidebar" />,
}))
vi.mock('@/components/layout/notifications-bell', () => ({
  NotificationsBell: () => <div data-testid="mock-notifications-bell" />,
}))
vi.mock('@/components/onboarding/TosUpdateBanner', () => ({
  TosUpdateBanner: () => null,
}))
vi.mock('@/components/layout/ImpersonationBanner', () => ({
  ImpersonationBanner: () => null,
}))
vi.mock('@/components/users/UserAvatar', () => ({
  UserAvatar: () => <div data-testid="mock-user-avatar" />,
}))
vi.mock('@/components/brand-mark', () => ({
  BrandMark: () => <div data-testid="mock-brand-mark" />,
}))

import { Route } from '../route'

const CrmRoot = Route.options.component!

describe('CrmLayout header (routes/_authenticated/route.tsx)', () => {
  it('mobile-menu button names its own action in aria-label', () => {
    render(<CrmRoot />)
    expect(screen.getByLabelText('Відкрити меню')).toBeInTheDocument()
  })

  it('user-menu trigger names its own action in aria-label', () => {
    render(<CrmRoot />)
    expect(screen.getByTestId('header-user-menu-trigger')).toHaveAttribute(
      'aria-label',
      'Меню користувача',
    )
  })

  it('opening the user menu shows «Профіль» and «Вийти»', async () => {
    const user = userEvent.setup()
    render(<CrmRoot />)
    await user.click(screen.getByTestId('header-user-menu-trigger'))
    expect(screen.getByTestId('header-user-menu-profile')).toHaveTextContent('Профіль')
    expect(screen.getByTestId('header-user-menu-logout')).toHaveTextContent('Вийти')
  })
})
