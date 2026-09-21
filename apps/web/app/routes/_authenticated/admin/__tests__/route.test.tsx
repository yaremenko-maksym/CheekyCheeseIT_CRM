/**
 * routes/_authenticated/admin/route.tsx — unit tests for `AdminTemplatesRoot`
 * (the ADMIN tab-bar shell that wraps `/admin/*` — contracts / ToS /
 * company / login-as).
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). This file had
 * ZERO tests before this round — flagged in "Remaining gap, itemized"
 * (0 survived / 29 no-coverage on a scoped `mutation:changed` run) as
 * pre-existing debt from Steps 1-7.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, waitFor, type RenderOptions } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

beforeEach(async () => {
  await loadCatalog('uk')
})

const navigateMock = vi.fn()
let routerLocationPathname = '/admin/contracts'

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useRouterState: () => ({ pathname: routerLocationPathname }),
    Outlet: () => <div data-testid="mock-admin-outlet" />,
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const useAuthMock = vi.fn()
vi.mock('@/context/auth', () => ({
  useAuth: () => useAuthMock(),
}))

import { toast } from 'sonner'
import { Route } from '../route'

const AdminTemplatesRoot = Route.options.component!

const ADMIN_USER = { id: 'admin-1', role: 'ADMIN' as const }
const SENIOR_USER = { id: 'senior-1', role: 'SENIOR' as const }

describe('AdminTemplatesRoot — loading / RBAC redirect', () => {
  beforeEach(() => {
    navigateMock.mockClear()
    routerLocationPathname = '/admin/contracts'
  })

  it('renders skeletons while auth is loading, no tab nav yet', () => {
    useAuthMock.mockReturnValue({ user: null, isLoading: true })
    render(<AdminTemplatesRoot />)

    expect(screen.queryByTestId('admin-tabs-nav')).not.toBeInTheDocument()
  })

  it('redirects to /login when there is no user (not just loading)', async () => {
    useAuthMock.mockReturnValue({ user: null, isLoading: false })
    render(<AdminTemplatesRoot />)

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({ to: '/login' })
    })
  })

  // MUT-1: `toast.error(t\`Розділ доступний лише для ролі «${roleLabel}»\`)`
  // — StringLiteral AND the useRoleLabel('ADMIN') StringLiteral argument.
  it('non-ADMIN user is redirected to / with a catalog toast naming the required role', async () => {
    useAuthMock.mockReturnValue({ user: SENIOR_USER, isLoading: false })
    render(<AdminTemplatesRoot />)

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith({ to: '/' })
    })
    expect(toast.error).toHaveBeenCalledWith('Розділ доступний лише для ролі «Адміністратор»')
  })

  it('renders nothing (null) for a non-ADMIN user — no tab nav, no outlet', () => {
    useAuthMock.mockReturnValue({ user: SENIOR_USER, isLoading: false })
    const { container } = render(<AdminTemplatesRoot />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('AdminTemplatesRoot — ADMIN tab bar', () => {
  beforeEach(() => {
    navigateMock.mockClear()
    routerLocationPathname = '/admin/contracts'
    useAuthMock.mockReturnValue({ user: ADMIN_USER, isLoading: false })
  })

  it('renders the four ADMIN_TABS with their catalog labels (visible text, not just aria-label) + a11y nav landmark', () => {
    render(<AdminTemplatesRoot />)

    const nav = screen.getByTestId('admin-tabs-nav')
    expect(nav).toHaveAttribute('aria-label', 'Розділи адміністратора')
    // MUT-1: `label` and `ariaLabel` are two SEPARATE `t\`...\`` calls per
    // tab — `getByRole(..., { name })` resolves via `aria-label` alone
    // (AnimatedTabs sets it unconditionally), so it cannot tell a mutated
    // `label` (empty visible text, intact aria-label) from the real thing.
    // `toHaveTextContent` reads the actual rendered `<span>` instead.
    expect(screen.getByRole('button', { name: 'Контракти' })).toHaveTextContent('Контракти')
    expect(screen.getByRole('button', { name: 'Умови використання' })).toHaveTextContent(
      'Умови використання',
    )
    expect(screen.getByRole('button', { name: 'Компанія' })).toHaveTextContent('Компанія')
    expect(screen.getByRole('button', { name: 'Увійти як' })).toHaveTextContent('Увійти як')
  })

  it('renders the Outlet for child routes', () => {
    render(<AdminTemplatesRoot />)
    expect(screen.getByTestId('mock-admin-outlet')).toBeInTheDocument()
  })

  // MUT-1: each tab's OWN `value` string, observed through the real
  // onChange → navigate wiring (AnimatedTabs calls `onChange(tab.value)` on
  // click) — a mutated `value: ''` would navigate to `/admin/` instead of
  // the real path.
  it.each([
    ['contracts', 'Контракти'],
    ['tos', 'Умови використання'],
    ['wallet', 'Компанія'],
    ['login-as', 'Увійти як'],
  ])('clicking the %s tab navigates to /admin/%s', async (value, label) => {
    const user = userEvent.setup()
    render(<AdminTemplatesRoot />)

    await user.click(screen.getByRole('button', { name: label }))
    expect(navigateMock).toHaveBeenCalledWith({ to: `/admin/${value}` })
  })

  // MUT-1: `ADMIN_TABS.find((tab) => location.pathname.startsWith(\`/admin/${tab.value}\`))
  // ?.value ?? 'contracts'` — the ACTIVE tab (AnimatedTabs' own
  // `text-primary-foreground` class, applied to exactly one button) is
  // derived from the current path. Exercising three non-default paths (not
  // just 'contracts', where several of the mutants below coincide with the
  // real result) is what actually distinguishes each mutator:
  //   - `??` → `&&`: for a truthy match (e.g. 'tos'), `&&` evaluates to the
  //     FALLBACK operand instead of the match — always resolves 'contracts'.
  //   - the `.find()` predicate replaced by `() => undefined`: `.find()`
  //     never matches anything — same always-'contracts' effect.
  //   - `startsWith` → `endsWith`: identical result on an EXACT path match
  //     (both true) — needs a NESTED path (below) to differ.
  it.each([
    ['/admin/tos', 'Умови використання'],
    ['/admin/wallet', 'Компанія'],
    ['/admin/login-as', 'Увійти як'],
  ])(
    'marks the tab matching %s as active (text-primary-foreground), others not',
    (path, activeLabel) => {
      routerLocationPathname = path
      render(<AdminTemplatesRoot />)

      expect(screen.getByRole('button', { name: activeLabel })).toHaveClass(
        'text-primary-foreground',
      )
      for (const label of ['Контракти', 'Умови використання', 'Компанія', 'Увійти як']) {
        if (label === activeLabel) continue
        expect(screen.getByRole('button', { name: label })).not.toHaveClass(
          'text-primary-foreground',
        )
      }
    },
  )

  // MUT-1: `startsWith` vs `endsWith` — a path ending in "contracts"
  // itself (an exact `/admin/contracts`) satisfies BOTH, and the fallback
  // ('contracts') masks the difference on any nested path that happens to
  // fall back to the SAME default tab. Real nested route `tos.new.tsx`
  // (`/admin/tos/new`) is what actually distinguishes them: under
  // `startsWith`, "tos" stays active; under `endsWith` (mutant), NO tab's
  // `/admin/<value>` matches the END of `/admin/tos/new` at all, so the
  // mutant falls all the way through to the 'contracts' default instead —
  // a different, observable tab.
  it('marks "Умови використання" active for the real nested route /admin/tos/new (startsWith, not endsWith)', () => {
    routerLocationPathname = '/admin/tos/new'
    render(<AdminTemplatesRoot />)

    expect(screen.getByRole('button', { name: 'Умови використання' })).toHaveClass(
      'text-primary-foreground',
    )
  })

  // MUT-1: the `?? 'contracts'` fallback itself — a pathname matching NONE
  // of the four tab values must still highlight "Контракти" as active, not
  // leave every tab un-highlighted (the `'contracts'` → `''` mutant: no tab
  // has `value === ''`, so NO button would carry the active class).
  it('falls back to "Контракти" as the active tab when the pathname matches none of the tab values', () => {
    routerLocationPathname = '/admin/unknown-subroute'
    render(<AdminTemplatesRoot />)

    expect(screen.getByRole('button', { name: 'Контракти' })).toHaveClass('text-primary-foreground')
  })

  // MUT-1: the hidden E2E-compat links — each carries its OWN catalog
  // string (or, for `tos`, a deliberately English placeholder — see the
  // source's own comment) as its data-testid target text.
  it('renders the hidden E2E-testid-compat links with their catalog/placeholder text', () => {
    render(<AdminTemplatesRoot />)

    expect(screen.getByTestId('admin-templates-tab-contracts')).toHaveTextContent('Контракти')
    expect(screen.getByTestId('admin-templates-tab-tos')).toHaveTextContent('Terms of Service')
    expect(screen.getByTestId('admin-templates-tab-wallet')).toHaveTextContent('Компанія')
    expect(screen.getByTestId('admin-templates-tab-login-as')).toHaveTextContent('Увійти як')
  })
})
