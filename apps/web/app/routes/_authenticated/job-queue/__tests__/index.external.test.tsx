/**
 * /job-queue wiring of the «Записати зовнішню подачу» dialog: the stashed hand-off, the button, the
 * teams it may register for, and where it goes after. The dialog has its own suite
 * (components/job-queue/__tests__/ExternalSubmissionDialog.test.tsx); here it is a stub that shows
 * the props it got and calls back on demand. Router and network are stubbed as in index.test.tsx.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ExternalVacancyPrefill, TeamDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import {
  BOOKMARKLET_USED_KEY,
  bookmarkletUsed,
  encodePrefill,
  hasStashedPrefill,
  PREFILL_STASH_KEY,
} from '@/lib/external-prefill'

const mockNavigate = vi.fn()
let currentSearch: Record<string, unknown> = { tab: 'NEW' }
const gate = vi.hoisted(() => ({ isComplete: true }))

vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useSearch: () => currentSearch,
  }),
}))
vi.mock('@/lib/axios', () => ({ api: { get: vi.fn() } }))
vi.mock('@/context/auth', () => ({ useAuth: vi.fn() }))
vi.mock('@/context/onboarding', () => ({ useOnboardingGate: () => gate }))
vi.mock('@/components/job-queue/JobQueueCard', () => ({ JobQueueCard: () => null }))
vi.mock('@/components/job-queue/ExternalSubmissionDialog', () => ({
  ExternalSubmissionDialog: (p: {
    open: boolean
    prefill: ExternalVacancyPrefill | null | undefined
    teams: readonly TeamDto[]
    onOpenChange: (open: boolean) => void
    onSubmitted: (id: string) => void
    onOpenCard: (id: string) => void
  }) => (
    <div
      data-testid="dialog-stub"
      data-open={String(p.open)}
      data-prefill={p.prefill === undefined ? 'undefined' : (p.prefill?.title ?? 'null')}
      data-teams={p.teams.map((t) => (typeof t === 'object' ? t.id : String(t))).join(',')}
    >
      <button type="button" onClick={() => p.onOpenChange(false)}>
        stub-close
      </button>
      <button type="button" onClick={() => p.onOpenChange(true)}>
        stub-reopen
      </button>
      <button type="button" onClick={() => p.onSubmitted('opp-1')}>
        stub-submitted
      </button>
      <button type="button" onClick={() => p.onOpenCard('opp-2')}>
        stub-open-card
      </button>
    </div>
  ),
}))

import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { Route } from '../index'

const USER = '99999999-9999-4999-8999-999999999999'
const TEAM_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TEAM_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const TEAM_OLD = 'cccccccc-0000-4000-8000-000000000003'
const team = (
  id: string,
  archivedAt: string | null = null,
  type: 'SENIOR' | 'DROP' = 'SENIOR',
  seniorId: string | null = `senior-${id}`,
) => ({
  id,
  name: id.slice(0, 4),
  type,
  archivedAt,
  members: [
    { userId: USER, leftAt: null, role: 'HR' as const },
    ...(seniorId ? [{ userId: seniorId, leftAt: null, role: 'SENIOR' as const }] : []),
  ],
})

const prefill: ExternalVacancyPrefill = {
  v: 1,
  recognition: 'recognized',
  url: 'https://jobs.example.com/1',
  title: 'Go Engineer',
  company: 'Acme',
  description: 'Build.',
  status: { url: 'found', title: 'found', company: 'found', description: 'found' },
}

const emptyPage = {
  items: [],
  nextCursor: null,
  counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0 },
  generation: null,
  sourcingNotice: null,
}

/** `teams` is what `/teams` answers; a never-settling promise keeps the list loading. */
function serve(role: 'HR' | 'ADMIN' | 'SENIOR', teams: Promise<unknown>) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: USER, role },
    isLoading: false,
  } as unknown as ReturnType<typeof useAuth>)
  vi.mocked(api.get).mockImplementation(((url: string) => {
    if (url === '/teams') return teams.then((data) => ({ data }))
    if (url === '/job-queue') return Promise.resolve({ data: emptyPage })
    if (url === '/job-queue/seniors') return Promise.resolve({ data: { items: [] } })
    if (url === '/job-sourcing/sources') return Promise.resolve({ data: { items: [] } })
    return Promise.reject(new Error(`unexpected ${url}`))
  }) as unknown as typeof api.get)
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Page = Route.options.component as React.ComponentType
  render(
    <QueryClientProvider client={qc}>
      <Page />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

const stub = () => screen.getByTestId('dialog-stub')
const stash = () => sessionStorage.setItem(PREFILL_STASH_KEY, `#external=${encodePrefill(prefill)}`)
const never = new Promise<unknown>(() => {})

beforeEach(async () => {
  // the install dialog opens by itself on a first visit; its own describe clears this
  localStorage.setItem(BOOKMARKLET_USED_KEY, '1')
  currentSearch = { tab: 'NEW' }
  gate.isComplete = true
  mockNavigate.mockReset()
  vi.mocked(api.get).mockReset()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  await loadCatalog('uk')
})
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

describe('/job-queue: external submission', () => {
  it('a stashed hand-off opens the dialog prefilled once the queue mounts, and is consumed', async () => {
    stash()
    serve('HR', Promise.resolve([team(TEAM_A)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-open', 'true'))
    expect(stub()).toHaveAttribute('data-prefill', 'Go Engineer')
    expect(hasStashedPrefill()).toBe(false)
  })

  it('without a hand-off the dialog is closed until the button opens it empty', async () => {
    serve('HR', Promise.resolve([team(TEAM_A)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-open', 'false'))
    await userEvent.click(screen.getByTestId('job-queue-external-open'))
    expect(stub()).toHaveAttribute('data-open', 'true')
    expect(stub()).toHaveAttribute('data-prefill', 'null')
  })

  it('closing keeps the hand-off: reopening shows it again', async () => {
    stash()
    serve('HR', Promise.resolve([team(TEAM_A)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-open', 'true'))
    await userEvent.click(screen.getByRole('button', { name: 'stub-close' }))
    expect(stub()).toHaveAttribute('data-open', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'stub-reopen' }))
    expect(stub()).toHaveAttribute('data-open', 'true')
    expect(stub()).toHaveAttribute('data-prefill', 'Go Engineer')
  })

  it('a registered submission closes the dialog, clears the hand-off and opens the SUBMITTED tab', async () => {
    currentSearch = { tab: 'NEW', card: 'old-card' }
    stash()
    serve('HR', Promise.resolve([team(TEAM_A)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-open', 'true'))
    await userEvent.click(screen.getByRole('button', { name: 'stub-submitted' }))
    expect(stub()).toHaveAttribute('data-open', 'false')
    expect(stub()).toHaveAttribute('data-prefill', 'null')
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/job-queue',
      search: { tab: 'SUBMITTED' },
    })
  })

  it('«open the existing card» closes the dialog, clears the hand-off and opens that card', async () => {
    stash()
    serve('HR', Promise.resolve([team(TEAM_A)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-open', 'true'))
    await userEvent.click(screen.getByRole('button', { name: 'stub-open-card' }))
    expect(stub()).toHaveAttribute('data-open', 'false')
    expect(stub()).toHaveAttribute('data-prefill', 'null')
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/job-queue',
      search: { tab: 'NEW', card: 'opp-2' },
    })
  })

  it('an HR of several teams may register for any of them (the queue has no team switcher)', async () => {
    serve('HR', Promise.resolve([team(TEAM_A), team(TEAM_B)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', `${TEAM_A},${TEAM_B}`))
  })

  it('an HR may register for a DROP team with an active senior, like a SENIOR team', async () => {
    serve('HR', Promise.resolve([team(TEAM_A), team(TEAM_B, null, 'DROP')]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', `${TEAM_A},${TEAM_B}`))
  })

  it('a DROP-only HR gets the queue and registers for their drop team', async () => {
    serve('HR', Promise.resolve([team(TEAM_B, null, 'DROP')]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', TEAM_B))
    expect(screen.queryByTestId('job-queue-no-team')).toBeNull()
  })

  it('a drop team whose only non-HR member is the DROP owner is not a team to register for', async () => {
    const ownerOnly = team(TEAM_B, null, 'DROP', null)
    serve(
      'HR',
      Promise.resolve([
        team(TEAM_A),
        {
          ...ownerOnly,
          members: [...ownerOnly.members, { userId: 'drop', leftAt: null, role: 'DROP' as const }],
        },
      ]),
    )
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', TEAM_A))
  })

  it('an HR with one team that has seniors and one SENIOR team with no senior is offered only the first team', async () => {
    serve('HR', Promise.resolve([team(TEAM_A), team(TEAM_B, null, 'SENIOR', null)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', TEAM_A))
  })

  it('a senior who left the team does not make it a team to register for', async () => {
    const left = team(TEAM_B)
    serve(
      'HR',
      Promise.resolve([
        team(TEAM_A),
        {
          ...left,
          members: left.members.map((m) => ({
            ...m,
            leftAt: m.role === 'SENIOR' ? '2026-11-01T00:00:00.000Z' : null,
          })),
        },
      ]),
    )
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', TEAM_A))
  })

  it('an HR none of whose teams has a senior gets no «record an external submission» button', async () => {
    serve('HR', Promise.resolve([team(TEAM_A, null, 'SENIOR', null)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', ''))
    expect(screen.queryByTestId('job-queue-external-open')).toBeNull()
    expect(screen.getByTestId('external-sources')).toBeInTheDocument()
    expect(screen.queryByTestId('external-sources-register')).toBeNull()
  })

  it('an ADMIN may register for every live team, never an archived one', async () => {
    serve('ADMIN', Promise.resolve([team(TEAM_A), team(TEAM_OLD, '2026-01-01T00:00:00.000Z')]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', TEAM_A))
  })

  it('an ADMIN is offered a live team even when it has no senior (the senior filter is HR-only)', async () => {
    serve('ADMIN', Promise.resolve([team(TEAM_A), team(TEAM_B, null, 'SENIOR', null)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', `${TEAM_A},${TEAM_B}`))
    expect(screen.getByTestId('job-queue-external-open')).toBeInTheDocument()
  })

  it('an ADMIN keeps the «record an external submission» button with no live team (the hide is HR-only)', async () => {
    serve('ADMIN', Promise.resolve([team(TEAM_OLD, '2026-01-01T00:00:00.000Z')]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', ''))
    expect(screen.getByTestId('job-queue-external-open')).toBeInTheDocument()
  })

  it('an ADMIN has no teams to offer while the list loads', () => {
    serve('ADMIN', never)
    renderPage()
    expect(stub()).toHaveAttribute('data-teams', '')
  })

  it('an ADMIN reads the team list itself, not through the membership gate', async () => {
    gate.isComplete = false
    serve('ADMIN', Promise.resolve([team(TEAM_A)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-teams', TEAM_A))
  })

  it('an HR with no team drops the hand-off once the empty list is in', async () => {
    stash()
    serve('HR', Promise.resolve([]))
    renderPage()
    await screen.findByTestId('job-queue-no-team')
    await waitFor(() => expect(hasStashedPrefill()).toBe(false))
  })

  it('a role the page refuses leaves the hand-off alone, even without a team', async () => {
    stash()
    serve('SENIOR', Promise.resolve([]))
    renderPage()
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled())
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/teams'))
    expect(hasStashedPrefill()).toBe(true)
  })

  it('an HR whose team list is still loading keeps the hand-off for the queue', async () => {
    stash()
    serve('HR', never)
    renderPage()
    await screen.findByTestId('job-queue-loading')
    expect(hasStashedPrefill()).toBe(true)
  })
})

describe('/job-queue: bookmarklet install dialog', () => {
  const install = () => screen.queryByTestId('bookmarklet-install-dialog')

  beforeEach(() => localStorage.clear())

  it('opens by itself for an HR who has not used the bookmarklet yet', async () => {
    serve('HR', Promise.resolve([team(TEAM_A)]))
    renderPage()
    await waitFor(() => expect(install()).toBeInTheDocument())
  })

  it('stays closed once the bookmarklet was used, until a button opens it', async () => {
    localStorage.setItem(BOOKMARKLET_USED_KEY, '1')
    serve('HR', Promise.resolve([team(TEAM_A)]))
    renderPage()
    await waitFor(() => expect(stub()).toBeInTheDocument())
    expect(install()).toBeNull()
    await userEvent.click(screen.getByTestId('job-queue-bookmarklet-open'))
    expect(install()).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(install()).toBeNull())
    const help = screen.getByTestId('job-queue-bookmarklet-help')
    expect(help).toHaveAccessibleName('Як працює закладка «До CRM»')
    await userEvent.click(help)
    expect(install()).toBeInTheDocument()
  })

  it('does not open over a hand-off, and the hand-off marks the bookmarklet used', async () => {
    stash()
    serve('HR', Promise.resolve([team(TEAM_A)]))
    renderPage()
    await waitFor(() => expect(stub()).toHaveAttribute('data-open', 'true'))
    expect(install()).toBeNull()
    expect(bookmarkletUsed()).toBe(true)
  })

  it('does not open by itself for an ADMIN', async () => {
    serve('ADMIN', Promise.resolve([team(TEAM_A)]))
    renderPage()
    await waitFor(() => expect(stub()).toBeInTheDocument())
    expect(install()).toBeNull()
  })
})
