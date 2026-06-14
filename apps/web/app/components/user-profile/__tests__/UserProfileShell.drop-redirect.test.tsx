import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * task-drop-profile-rbac-r2 (Finding B2): a DROP viewer hitting a 403 must be
 * redirected to /crm/dashboard instead of seeing the "Нет доступа" screen.
 * Other roles keep the access-denied message.
 *
 * Strategy: mock the data hooks + useAuth + useActiveTeam + react-router's
 * useNavigate so the UserProfileShell renders its error branch deterministically.
 */

const navigateMock = vi.fn()

// ── Mutable mock state, set per-test ─────────────────────────────────────────
let viewerRole: string | null = 'DROP'
let queryError: unknown = null
let isErrorFlag = false

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: viewerRole ? { id: 'viewer-1', role: viewerRole } : null }),
}))

vi.mock('@/hooks/use-active-team', () => ({
  useActiveTeam: () => ({ isTeamless: false }),
}))

vi.mock('@/hooks/use-user-profile', () => ({
  useMe: () => ({ data: undefined, isLoading: false, isError: isErrorFlag, error: queryError }),
  useUser: () => ({ data: undefined, isLoading: false, isError: isErrorFlag, error: queryError }),
}))

// Import AFTER mocks are registered.
import { UserProfileShell } from '../UserProfileShell'

function make403(): unknown {
  return { response: { status: 403 } }
}
function make404(): unknown {
  return { response: { status: 404 } }
}

function renderShell() {
  return render(
    <UserProfileShell mode="view" userId="target-1" tab="overview" onTabChange={() => {}} />,
  )
}

describe('UserProfileShell — DROP 403 redirect (Finding B2)', () => {
  beforeEach(() => {
    navigateMock.mockReset()
    viewerRole = 'DROP'
    queryError = null
    isErrorFlag = false
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('DROP + 403 → navigates to /crm/dashboard and does NOT render "Нет доступа"', () => {
    viewerRole = 'DROP'
    isErrorFlag = true
    queryError = make403()

    renderShell()

    expect(navigateMock).toHaveBeenCalledWith({ to: '/crm/dashboard', replace: true })
    expect(screen.queryByText('Нет доступа')).toBeNull()
  })

  it('SENIOR + 403 → shows "Нет доступа", does NOT redirect', () => {
    viewerRole = 'SENIOR'
    isErrorFlag = true
    queryError = make403()

    renderShell()

    expect(navigateMock).not.toHaveBeenCalled()
    expect(screen.getByText('Нет доступа')).toBeInTheDocument()
  })

  it('HR + 403 → shows "Нет доступа", does NOT redirect', () => {
    viewerRole = 'HR'
    isErrorFlag = true
    queryError = make403()

    renderShell()

    expect(navigateMock).not.toHaveBeenCalled()
    expect(screen.getByText('Нет доступа')).toBeInTheDocument()
  })

  it('DROP + 404 (not 403) → does NOT redirect, shows "Профиль не найден"', () => {
    viewerRole = 'DROP'
    isErrorFlag = true
    queryError = make404()

    renderShell()

    expect(navigateMock).not.toHaveBeenCalled()
    expect(screen.getByText('Профиль не найден')).toBeInTheDocument()
  })

  it('ACCOUNTANT + 403 → shows "Нет доступа", does NOT redirect', () => {
    viewerRole = 'ACCOUNTANT'
    isErrorFlag = true
    queryError = make403()

    renderShell()

    expect(navigateMock).not.toHaveBeenCalled()
    expect(screen.getByText('Нет доступа')).toBeInTheDocument()
  })
})
