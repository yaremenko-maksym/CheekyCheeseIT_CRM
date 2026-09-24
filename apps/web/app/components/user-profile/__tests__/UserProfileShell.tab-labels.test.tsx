/**
 * UserProfileShell.tab-labels.test.tsx — task-i18n-stage3b (Task 1),
 * mutation-gate coverage.
 *
 * `TAB_LABELS` / `PROJECTS_TAB_JUNIOR_LABEL` (module-level `msg` map) and the
 * dirty-guard title's interpolation (`i18n._(TAB_LABELS[dirtyGuardTab ?? ...])`)
 * had zero unit assertion pinning their RESOLVED text before this file —
 * every existing UserProfileShell test either stubs the tab bodies without
 * asserting every tab's own label, or never triggers the dirty guard at all.
 * Each `it` below asserts a specific uk string, so an empty/garbled `msg`
 * template fails it (mutation-gate `StringLiteral` survivors on
 * UserProfileShell.tsx lines 43-53 / 215 / 342).
 *
 * Pattern mirrors UserProfileShell.notifications-tab.test.tsx (same mocks).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ViewPermissions } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'viewer-1', role: 'ADMIN' } }),
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
vi.mock('../tabs/FinanceTab', () => ({ FinanceTab: () => <div data-testid="stub-finance" /> }))
vi.mock('../tabs/ProjectsTab', () => ({ ProjectsTab: () => <div data-testid="stub-projects" /> }))
vi.mock('../tabs/TeamTab', () => ({ TeamTab: () => <div data-testid="stub-team" /> }))
vi.mock('../tabs/InterviewsTab', () => ({
  InterviewsTab: () => <div data-testid="stub-interviews" />,
}))
vi.mock('../tabs/RequisitesTab', () => ({
  RequisitesTab: () => <div data-testid="stub-requisites" />,
}))
vi.mock('../tabs/DocumentsTab', () => ({
  DocumentsTab: () => <div data-testid="stub-documents" />,
}))
vi.mock('../tabs/NotificationSettingsTab', () => ({
  NotificationSettingsTab: () => <div data-testid="stub-notifications" />,
}))
vi.mock('../resume/ResumeTab', () => ({ ResumeTab: () => <div data-testid="stub-resume" /> }))
// The dirty-guard flow needs a REAL `onDirtyChange` call — this stub fires it
// synchronously on mount (unconditionally dirty) so a tab switch away from
// 'contract' opens the guard without pulling in ContractTab's own deep
// dependency tree (axios queries, CodeMirror, etc.).
vi.mock('../contract/ContractTab', () => ({
  ContractTab: ({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) => {
    onDirtyChange(true)
    return <div data-testid="stub-contract" />
  },
}))
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

function makeData(role: string, tabs: ViewPermissions['tabs']) {
  return {
    user: { id: 'target-1', role, avatarDocumentId: null, avatarUrl: null },
    permissions: { tabs, actions: [], fields: {} },
    data: {},
  }
}

function renderShell(tab: string, onTabChange = vi.fn()) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <UserProfileShell mode="view" userId="target-1" tab={tab} onTabChange={onTabChange} />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

beforeEach(async () => {
  queryData = undefined
  await loadCatalog('uk')
})

describe('UserProfileShell — TAB_LABELS resolve to the exact uk catalog text', () => {
  // Every TAB_LABELS key at once — a SENIOR viewed by ADMIN gets all of
  // them except 'notifications' (self-only) and 'audit' (unrouted).
  it('renders every backend-eligible tab with its own exact label', () => {
    queryData = makeData('SENIOR', [
      'overview',
      'finance',
      'projects',
      'team',
      'interviews',
      'requisites',
      'documents',
      'contract',
      'resume',
    ])
    renderShell('overview')
    expect(screen.getByRole('button', { name: 'Огляд' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Фінанси' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Проєкти' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Команда' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Співбесіди' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Реквізити' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Документи' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Контракт' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Резюме' })).toBeInTheDocument()
  })

  // JUNIOR gets the singular override — pins PROJECTS_TAB_JUNIOR_LABEL is
  // actually consulted (not just declared) AND that it wins over the plural
  // TAB_LABELS.projects entry for this one role.
  it('JUNIOR profile: the projects tab reads "Проєкт" (singular), not "Проєкти"', () => {
    queryData = makeData('JUNIOR', ['overview', 'projects'])
    renderShell('overview')
    expect(screen.getByRole('button', { name: 'Проєкт' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Проєкти' })).not.toBeInTheDocument()
  })

  // Non-JUNIOR still gets the plural — the other half of the same branch.
  it('SENIOR profile: the projects tab reads "Проєкти" (plural)', () => {
    queryData = makeData('SENIOR', ['overview', 'projects'])
    renderShell('overview')
    expect(screen.getByRole('button', { name: 'Проєкти' })).toBeInTheDocument()
  })
})

describe('UserProfileShell — dirty-guard title interpolates the LEAVING tab’s own label', () => {
  it('leaving a dirty "contract" tab shows the guard titled with "Контракт", not a blank/generic string', async () => {
    const onTabChange = vi.fn()
    queryData = makeData('SENIOR', ['overview', 'contract'])
    renderShell('contract', onTabChange)
    expect(screen.getByTestId('stub-contract')).toBeInTheDocument()

    // Attempt to switch to 'overview' — ContractTab's stub already marked
    // itself dirty on mount, so this must open the guard instead of calling
    // onTabChange directly.
    fireEvent.click(screen.getByRole('button', { name: 'Огляд' }))

    const dialog = await screen.findByTestId('contract-dirty-guard-dialog')
    expect(dialog).toHaveTextContent('Покинути вкладку «Контракт»?')
    expect(onTabChange).not.toHaveBeenCalled()
  })
})
