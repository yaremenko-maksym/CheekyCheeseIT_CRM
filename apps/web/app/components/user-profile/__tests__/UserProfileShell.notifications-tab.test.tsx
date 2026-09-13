/**
 * UserProfileShell.notifications-tab.test.tsx — task-notification-settings-ui
 * (position 7b), AC1.
 *
 * AC1: the "Уведомления" tab exists in `mode === 'self'`; it does NOT exist
 * in `mode === 'view'`, and `?tab=notifications` there falls back to
 * "Обзор" — the SAME fallback path already exercised for any other
 * unavailable tab (`visibleTabs.includes(tab) ? tab : visibleTabs[0]`).
 *
 * Strategy: mirrors `UserProfileShell.drop-redirect.test.tsx` — mock the
 * data hooks + useAuth + useActiveTeam + react-router's useNavigate, plus
 * `@/lib/axios` (descendants like RejoinTeamDialog/AvatarUploadDialog mount
 * unconditionally on a self profile and carry their own `useQuery`s) and the
 * heavy tab bodies (OverviewTab / NotificationSettingsTab), so the shell
 * renders deterministically without a live backend.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ViewPermissions } from '@crm/shared'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'viewer-1', role: 'SENIOR' } }),
}))

vi.mock('@/hooks/use-active-team', () => ({
  useActiveTeam: () => ({ isTeamless: false }),
}))

vi.mock('@/lib/axios', () => ({
  api: {
    get: () => Promise.reject(new Error('not mocked')),
    post: () => Promise.reject(new Error('not mocked')),
    patch: () => Promise.reject(new Error('not mocked')),
    put: () => Promise.reject(new Error('not mocked')),
    delete: () => Promise.reject(new Error('not mocked')),
  },
}))

vi.mock('../tabs/OverviewTab', () => ({ OverviewTab: () => <div data-testid="stub-overview" /> }))
vi.mock('../tabs/NotificationSettingsTab', () => ({
  NotificationSettingsTab: () => <div data-testid="stub-notifications" />,
}))
// UserProfileHeader / AvatarUploadDialog carry their own deep dependency
// tree (react-router `Link`, upload hooks) irrelevant to this tab-list AC —
// stubbed like the heavy tab bodies above.
vi.mock('../UserProfileHeader', () => ({
  UserProfileHeader: () => <div data-testid="stub-header" />,
}))
vi.mock('../AvatarUploadDialog', () => ({ AvatarUploadDialog: () => null }))

let queryData:
  | {
      user: { id: string; role: string; avatarDocumentId: null; avatarUrl: null }
      permissions: ViewPermissions
      data: Record<string, unknown>
    }
  | undefined

vi.mock('@/hooks/use-user-profile', () => ({
  useMe: () => ({ data: queryData, isLoading: false, isError: false, error: null }),
  useUser: () => ({ data: queryData, isLoading: false, isError: false, error: null }),
}))

// Import AFTER mocks are registered.
import { UserProfileShell } from '../UserProfileShell'

function makeData(tabs: ViewPermissions['tabs']) {
  return {
    user: { id: 'target-1', role: 'SENIOR', avatarDocumentId: null, avatarUrl: null },
    permissions: { tabs, actions: [], fields: {} },
    data: {},
  }
}

function renderShell(mode: 'self' | 'view', tab: string, onTabChange = vi.fn()) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <UserProfileShell mode={mode} userId="target-1" tab={tab} onTabChange={onTabChange} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  queryData = undefined
})

describe('UserProfileShell — "Уведомления" tab (AC1)', () => {
  it('mode=self: the tab bar includes "Уведомления", and its body is NOT active by default', () => {
    queryData = makeData(['overview', 'requisites'])
    renderShell('self', 'overview')
    expect(screen.getByText('Уведомления')).toBeInTheDocument()
    // Pins `activeTab === 'notifications'` as a genuine equality check, not
    // an always-true gate — a mutant that renders the tab body regardless of
    // which tab is active must fail this on the DEFAULT ('overview') tab.
    expect(screen.queryByTestId('stub-notifications')).not.toBeInTheDocument()
  })

  it('mode=self: SELF_ALLOWED_TABS still filters out a backend tab the self-view allow-list excludes', () => {
    // 'finance'/'team' are real backend tabs (e.g. for a SENIOR/HR self-view)
    // that SELF_ALLOWED_TABS deliberately does not include — pins that the
    // `.filter(...)` call survives next to the unconditional 'notifications'
    // concat, i.e. the concat is additive, not a replacement of the filter.
    queryData = makeData(['overview', 'finance', 'team', 'requisites'])
    renderShell('self', 'overview')
    expect(screen.getByText('Обзор')).toBeInTheDocument()
    expect(screen.getByText('Уведомления')).toBeInTheDocument()
    expect(screen.queryByText('Финансы')).not.toBeInTheDocument()
    expect(screen.queryByText('Команда')).not.toBeInTheDocument()
  })

  it('mode=self + tab=notifications: renders the NotificationSettingsTab body', () => {
    queryData = makeData(['overview', 'requisites'])
    renderShell('self', 'notifications')
    expect(screen.getByTestId('stub-notifications')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-overview')).not.toBeInTheDocument()
  })

  it('mode=view: the tab bar does NOT include "Уведомления" (backend never sends it there)', () => {
    // view-mode permissions.tabs come straight from the backend with no
    // client-side SELF_ALLOWED_TABS filter — 'notifications' is never
    // among them (see UsersAccessService — verified no such string exists).
    queryData = makeData(['overview', 'finance', 'projects', 'team', 'requisites', 'documents'])
    renderShell('view', 'overview')
    expect(screen.queryByText('Уведомления')).not.toBeInTheDocument()
  })

  it('mode=view + ?tab=notifications: falls back to "Обзор" (same path as any other unavailable tab)', () => {
    queryData = makeData(['overview', 'finance', 'projects', 'team', 'requisites', 'documents'])
    renderShell('view', 'notifications')
    expect(screen.getByTestId('stub-overview')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-notifications')).not.toBeInTheDocument()
  })
})
