/**
 * r5 Task 7.2 — the /job-queue page wired to the real data hook (`useJobQueue`) and the real
 * `useActiveTeams`; only the network (`api.get`), the session and the router are stubbed.
 * The router stub follows interviews/__tests__/index.test.tsx: `Route.useSearch()` answers
 * the test's own search state, `useNavigate()` records the target.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { JobQueueListResponseDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const mockNavigate = vi.fn()
let currentSearch: Record<string, unknown> = { tab: 'NEW' }

vi.mock('@tanstack/react-router', async (orig) => {
  const real = await orig<typeof import('@tanstack/react-router')>()
  return {
    ...real,
    useNavigate: () => mockNavigate,
    createFileRoute: (path: string) => (options: Record<string, unknown>) => ({
      options,
      path,
      useSearch: () => currentSearch,
    }),
  }
})

vi.mock('@/lib/axios', () => ({ api: { get: vi.fn() } }))
vi.mock('@/context/auth', () => ({ useAuth: vi.fn() }))
vi.mock('@/context/onboarding', () => ({ useOnboardingGate: () => ({ isComplete: true }) }))

import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { Route } from '../index'

const HR_ID = '99999999-9999-4999-8999-999999999999'
const TEAM_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const TEAM_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const ITEM_ID = '11111111-1111-4111-8111-111111111111'

function team(id: string, name: string) {
  return { id, name, archivedAt: null, members: [{ userId: HR_ID, leftAt: null }] }
}

function page(over: Partial<JobQueueListResponseDto> = {}): JobQueueListResponseDto {
  return {
    items: [
      {
        opportunityId: ITEM_ID,
        revision: 1,
        title: 'Senior Go Engineer',
        companyName: 'Acme',
        location: null,
        primarySource: null,
        applicationUrl: null,
        alsoSeenOnCount: 0,
        availability: 'OPEN',
        eligibility: 'TRIAGE',
        matchedSeniorCount: 2,
        submittedSeniorCount: 0,
        stopListedSeniorCount: 0,
        openedByTeam: false,
        hidden: false,
        publishedAt: null,
        firstSeenAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    nextCursor: null,
    counts: { NEW: 7, SUBMITTED: 2, HIDDEN: 1 },
    generation: { ruleVersion: 'v1', evaluatedAt: '2026-11-01T00:00:00.000Z', capped: false },
    ...over,
  }
}

const SENIOR_A = '55555555-5555-4555-8555-555555555555'
const SENIOR_B = '66666666-6666-4666-8666-666666666666'
const SENIOR_OPTIONS = [
  { id: SENIOR_A, name: 'Анна Коваль' },
  { id: SENIOR_B, name: 'Богдан Шевченко' },
]

type Call = { url: string; params?: Record<string, unknown> | undefined }
const calls: Call[] = []

function serve({
  role = 'HR',
  teams = [team(TEAM_A, 'Alpha')],
  queue = () => Promise.resolve({ data: page() }),
  teamsCall = () => Promise.resolve({ data: teams }),
  seniorsCall = () => Promise.resolve({ data: { items: SENIOR_OPTIONS } }),
}: {
  role?: 'HR' | 'ADMIN'
  teams?: unknown[]
  queue?: (params: Record<string, unknown>) => Promise<unknown>
  teamsCall?: () => Promise<unknown>
  seniorsCall?: () => Promise<unknown>
} = {}) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: HR_ID, role },
    isLoading: false,
  } as unknown as ReturnType<typeof useAuth>)
  vi.mocked(api.get).mockImplementation(((
    url: string,
    config?: { params?: Record<string, unknown> },
  ) => {
    calls.push({ url, params: config?.params })
    if (url === '/teams') return teamsCall()
    if (url === '/job-queue') return queue(config?.params ?? {})
    if (url === '/job-queue/seniors') return seniorsCall()
    return Promise.reject(new Error(`unexpected ${url}`))
  }) as unknown as typeof api.get)
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Page = Route.options.component as React.ComponentType
  const tree = () => (
    <QueryClientProvider client={qc}>
      <Page />
    </QueryClientProvider>
  )
  const { rerender } = render(tree(), { wrapper: I18nTestProvider })
  return { qc, rerender: () => rerender(tree()) }
}

/** Overrides the session served by `serve()`. */
function signIn(user: { id: string; role: string } | null, isLoading = false) {
  vi.mocked(useAuth).mockReturnValue({ user, isLoading } as unknown as ReturnType<typeof useAuth>)
}

const ITEM_2 = '22222222-2222-4222-8222-222222222222'

/** Page 1 (with a cursor) answers; page 2 (`cursor: 'c1'`) answers `second`. */
function twoPages(second: () => Promise<unknown>, first: Partial<JobQueueListResponseDto> = {}) {
  return (params: Record<string, unknown>) =>
    params['cursor'] === 'c1'
      ? second()
      : Promise.resolve({ data: page({ nextCursor: 'c1', ...first }) })
}

function searchInput() {
  return screen.getByTestId('job-queue-search') as HTMLInputElement
}

function queueCalls() {
  return calls.filter((c) => c.url === '/job-queue')
}

function apiError(status: number, code: string) {
  return Object.assign(new Error(code), {
    isAxiosError: true,
    response: { status, data: { statusCode: status, code, message: code } },
  })
}

/** jsdom has no IntersectionObserver: a stub whose sentinel comes into view only on `scrollToEnd()`. */
const observers: Array<{
  cb: IntersectionObserverCallback
  live: boolean
  root: IntersectionObserverInit['root']
}> = []
class StubObserver {
  /** What the initial callback reports: is the sentinel already in view when it mounts? */
  static inView = false
  private readonly entry: (typeof observers)[number]
  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.entry = { cb, live: false, root: options?.root }
    observers.push(this.entry)
  }
  observe() {
    this.entry.live = true
    this.entry.cb(
      [{ isIntersecting: StubObserver.inView } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
  }
  disconnect() {
    this.entry.live = false
  }
}

async function scrollToEnd() {
  await act(async () => {
    for (const o of observers.filter((x) => x.live)) {
      o.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    }
  })
}

describe('/job-queue page', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(async () => {
    observers.length = 0
    StubObserver.inView = false
    vi.stubGlobal('IntersectionObserver', StubObserver)
    calls.length = 0
    mockNavigate.mockReset()
    currentSearch = { tab: 'NEW' }
    vi.mocked(api.get).mockReset()
    await loadCatalog('uk')
  })

  it('renders the queue for an HR with one team, scoped to that team', async () => {
    serve()
    renderPage()
    expect(screen.getByTestId('job-queue-page')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Черга зовнішніх вакансій')
    expect(await screen.findByTestId(`job-queue-row-${ITEM_ID}`)).toHaveTextContent(
      'Senior Go Engineer',
    )
    expect(screen.getByTestId('job-queue-row-triage')).toHaveTextContent('Потребує розгляду')
    expect(screen.getByTestId('job-queue-tab-NEW')).toHaveTextContent('Нові7')
    expect(screen.getByTestId('job-queue-tab-SUBMITTED')).toHaveTextContent('Подані2')
    expect(queueCalls()[0]?.params).toEqual({ teamId: TEAM_A, tab: 'NEW', limit: 20 })
    expect(screen.queryByTestId('job-queue-team-switcher')).toBeNull()
  })

  it('asks the server for the tab in the URL', async () => {
    currentSearch = { tab: 'HIDDEN' }
    serve()
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(queueCalls()[0]?.params).toMatchObject({ tab: 'HIDDEN' })
  })

  it('a tab click writes the tab into the URL', async () => {
    serve()
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    await userEvent.click(screen.getByTestId('job-queue-tab-SUBMITTED'))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/job-queue', search: { tab: 'SUBMITTED' } })
  })

  it('a row click opens the card through the URL', async () => {
    serve()
    renderPage()
    await userEvent.click(await screen.findByTestId(`job-queue-row-${ITEM_ID}`))
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/job-queue',
      search: { tab: 'NEW', card: ITEM_ID },
    })
  })

  it('sends the URL filters to the server and shows filtered-empty', async () => {
    currentSearch = { tab: 'NEW', search: 'go', eligibility: ['TRIAGE'] }
    serve({ queue: () => Promise.resolve({ data: page({ items: [] }) }) })
    renderPage()
    expect(await screen.findByTestId('job-queue-filtered-empty')).toBeInTheDocument()
    expect(queueCalls()[0]?.params).toMatchObject({ search: 'go', eligibility: 'TRIAGE' })
    const empty = within(screen.getByTestId('job-queue-filtered-empty'))
    await userEvent.click(empty.getByRole('button', { name: 'Скинути фільтри' }))
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/job-queue',
      search: { tab: 'NEW', search: 'go' },
    })
    await userEvent.click(empty.getByRole('button', { name: 'Очистити пошук' }))
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/job-queue',
      search: { tab: 'NEW', eligibility: ['TRIAGE'] },
    })
  })

  it('filtered-empty with only a search offers only «Очистити пошук»', async () => {
    currentSearch = { tab: 'NEW', search: 'go' }
    serve({ queue: () => Promise.resolve({ data: page({ items: [] }) }) })
    renderPage()
    const empty = within(await screen.findByTestId('job-queue-filtered-empty'))
    expect(empty.getByRole('button', { name: 'Очистити пошук' })).toBeInTheDocument()
    expect(empty.queryByRole('button', { name: 'Скинути фільтри' })).toBeNull()
    expect(screen.queryByTestId('job-queue-applied')).toBeNull()
  })

  it('filtered-empty with only filters offers only «Скинути фільтри»', async () => {
    currentSearch = { tab: 'NEW', availability: ['OPEN'] }
    serve({ queue: () => Promise.resolve({ data: page({ items: [] }) }) })
    renderPage()
    const empty = within(await screen.findByTestId('job-queue-filtered-empty'))
    expect(empty.getByRole('button', { name: 'Скинути фільтри' })).toBeInTheDocument()
    expect(empty.queryByRole('button', { name: 'Очистити пошук' })).toBeNull()
  })

  it('an HR without a team sees the no-team state and no queue request is made', async () => {
    serve({ teams: [] })
    renderPage()
    expect(await screen.findByTestId('job-queue-no-team')).toHaveTextContent(
      'Вам не призначено жодної команди',
    )
    expect(queueCalls()).toHaveLength(0)
  })

  it('an HR whose teams request fails gets an error with a retry, not an endless skeleton (QA-M-2)', async () => {
    let fail = true
    serve({
      teamsCall: () =>
        fail
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ data: [team(TEAM_A, 'Alpha')] }),
    })
    renderPage()
    const error = await screen.findByTestId('job-queue-error')
    expect(error).toHaveAttribute('role', 'alert')
    expect(error).toHaveTextContent('Не вдалося завантажити чергуСпробуйте ще раз.')
    expect(screen.queryByTestId('job-queue-loading')).toBeNull()
    expect(queueCalls()).toHaveLength(0)
    fail = false
    await userEvent.click(within(error).getByRole('button', { name: 'Спробувати ще раз' }))
    expect(await screen.findByTestId(`job-queue-row-${ITEM_ID}`)).toBeInTheDocument()
    expect(calls.filter((c) => c.url === '/teams')).toHaveLength(2)
  })

  // CR-M-1: a never-loaded query goes back to `pending` on refetch, so the error block (and its
  // button) is replaced by the skeleton at once; a disabled/aria-busy button could never render
  it('replaces the teams error with the loading skeleton while the retry is in flight (CR-M-1)', async () => {
    let fail = true
    let release: (v: { data: unknown }) => void = () => {}
    serve({
      teamsCall: () =>
        fail
          ? Promise.reject(new Error('boom'))
          : new Promise<{ data: unknown }>((resolve) => {
              release = resolve
            }),
    })
    renderPage()
    const error = await screen.findByTestId('job-queue-error')
    const retry = within(error).getByRole('button', { name: 'Спробувати ще раз' })
    expect(retry).toBeEnabled()
    expect(retry).not.toHaveAttribute('aria-busy')
    fail = false
    await userEvent.click(retry)
    const loading = await screen.findByTestId('job-queue-loading')
    expect(retry).not.toBeInTheDocument()
    // UX-M-6: the unmounted button hands focus to the page body, not to <body>
    expect(screen.getByTestId('job-queue-body')).toHaveFocus()
    expect(screen.getByTestId('job-queue-body')).toHaveAttribute('tabindex', '-1')
    // UX-L-9: the teams skeleton announces itself
    expect(loading).toHaveAttribute('role', 'status')
    expect(loading).toHaveAttribute('aria-busy', 'true')
    expect(loading).toHaveTextContent('Завантажуємо чергу…')
    release({ data: [team(TEAM_A, 'Alpha')] })
    expect(await screen.findByTestId(`job-queue-row-${ITEM_ID}`)).toBeInTheDocument()
    expect(screen.queryByTestId('job-queue-error')).toBeNull()
  })

  it('keeps search and the icon-only filter button on one row; only the team switcher stacks (UX-L-5)', async () => {
    serve({ teams: [team(TEAM_A, 'Alpha'), team(TEAM_B, 'Beta')] })
    renderPage()
    const switcher = await screen.findByTestId('job-queue-team-switcher')
    const row = screen.getByTestId('job-queue-search-row')
    expect(row).toContainElement(screen.getByRole('search'))
    expect(row).toContainElement(screen.getByTestId('job-queue-filters-button'))
    expect(row).toHaveClass('flex', 'items-center', 'gap-2')
    expect(row).not.toHaveClass('flex-col')
    // the switcher is outside that row: it is the only toolbar part that stacks
    expect(row).not.toContainElement(switcher)
  })

  it('hides the native search cancel so only the custom clear button shows (UX-M-2)', async () => {
    serve()
    renderPage()
    expect(await screen.findByTestId('job-queue-search')).toHaveClass(
      '[&::-webkit-search-cancel-button]:appearance-none',
    )
  })

  it('an HR with several teams gets a switcher and the URL team is used', async () => {
    currentSearch = { tab: 'NEW', teamId: TEAM_B }
    serve({ teams: [team(TEAM_A, 'Alpha'), team(TEAM_B, 'Beta')] })
    renderPage()
    expect(await screen.findByTestId('job-queue-team-switcher')).toHaveTextContent('Beta')
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(queueCalls()[0]?.params).toMatchObject({ teamId: TEAM_B })
  })

  it('an unknown URL team falls back to the first team', async () => {
    currentSearch = { tab: 'NEW', teamId: '00000000-0000-4000-8000-000000000000' }
    serve({ teams: [team(TEAM_A, 'Alpha'), team(TEAM_B, 'Beta')] })
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(queueCalls()[0]?.params).toMatchObject({ teamId: TEAM_A })
  })

  it('ADMIN reads the default (studio) scope without a team param and no switcher', async () => {
    serve({ role: 'ADMIN', teams: [team(TEAM_A, 'Alpha'), team(TEAM_B, 'Beta')] })
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(queueCalls()[0]?.params).toEqual({ tab: 'NEW', limit: 20 })
    expect(screen.getByTestId('job-queue-row-matched')).toHaveTextContent(
      '2 сеньйори мають збіг стеку',
    )
    expect(screen.queryByTestId('job-queue-team-switcher')).toBeNull()
  })

  it('shows the partial notice when the generation hit its cap', async () => {
    serve({
      queue: () =>
        Promise.resolve({
          data: page({
            generation: {
              ruleVersion: 'v1',
              evaluatedAt: '2026-11-01T00:00:00.000Z',
              capped: true,
            },
          }),
        }),
    })
    renderPage()
    expect(await screen.findByTestId('job-queue-partial')).toHaveTextContent(
      'Список може бути неповним',
    )
  })

  it('has no partial notice for an uncapped generation', async () => {
    serve()
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(screen.queryByTestId('job-queue-partial')).toBeNull()
  })

  it('offers a refresh when the server says the list changed, and restarts on click', async () => {
    let n = 0
    serve({
      queue: () =>
        n++ === 0
          ? Promise.reject(apiError(409, 'JOB_QUEUE_REFRESH_REQUIRED'))
          : Promise.resolve({ data: page() }),
    })
    renderPage()
    const notice = await screen.findByTestId('job-queue-refresh')
    expect(notice).toHaveAttribute('role', 'status')
    expect(notice).toHaveTextContent('Список змінився')
    expect(screen.queryByTestId('job-queue-error')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Показати оновлений список' }))
    expect(await screen.findByTestId(`job-queue-row-${ITEM_ID}`)).toBeInTheDocument()
    expect(screen.queryByTestId('job-queue-refresh')).toBeNull()
  })

  it('the refresh notice includes «З’явилися оновлення.» (CR-L-4)', async () => {
    serve({ queue: () => Promise.reject(apiError(409, 'JOB_QUEUE_REFRESH_REQUIRED')) })
    renderPage()
    const notice = await screen.findByTestId('job-queue-refresh')
    expect(notice).toHaveTextContent('З’явилися оновлення.')
    expect(screen.getByText('З’явилися оновлення.')).toHaveClass('text-foreground/70')
    expect(screen.getByRole('button', { name: 'Показати оновлений список' })).toHaveClass(
      'border-yellow-muted/40',
      'bg-background',
    )
    // the icon sits with the text, so the narrow stack holds two items: that group and the button
    // eslint-disable-next-line testing-library/no-node-access -- an aria-hidden icon has no role or name to query by
    const icon = notice.querySelector('svg')
    expect(icon).toHaveClass('text-primary')
    // eslint-disable-next-line testing-library/no-node-access -- the assertion is about the icon's own wrapper
    expect(icon?.parentElement).toHaveClass('flex-1', 'items-start')
  })

  it('the refresh notice button parks focus on the list body (CR-L-4)', async () => {
    let n = 0
    serve({
      queue: () =>
        n++ === 0
          ? Promise.reject(apiError(409, 'JOB_QUEUE_REFRESH_REQUIRED'))
          : Promise.resolve({ data: page() }),
    })
    renderPage()
    await screen.findByTestId('job-queue-refresh')
    await userEvent.click(screen.getByRole('button', { name: 'Показати оновлений список' }))
    expect(screen.getByTestId('job-queue-body')).toHaveFocus()
  })

  it('drops the rows and explains when access to the scope is lost', async () => {
    serve({ queue: () => Promise.reject(apiError(403, 'FORBIDDEN')) })
    renderPage()
    expect(await screen.findByTestId('job-queue-access-lost')).toHaveTextContent(
      'Немає доступу до цієї черги',
    )
    expect(screen.queryByTestId('job-queue-list')).toBeNull()
    expect(screen.queryByTestId('job-queue-error')).toBeNull()
  })

  it('shows the error state on a server failure', async () => {
    serve({ queue: () => Promise.reject(apiError(500, 'INTERNAL')) })
    renderPage()
    expect(await screen.findByTestId('job-queue-error')).toBeInTheDocument()
  })

  it('retries the first page from the error state', async () => {
    serve({ queue: () => Promise.reject(apiError(500, 'INTERNAL')) })
    renderPage()
    const error = await screen.findByTestId('job-queue-error')
    expect(queueCalls()).toHaveLength(1)
    await userEvent.click(within(error).getByRole('button', { name: 'Спробувати ще раз' }))
    await waitFor(() => expect(queueCalls()).toHaveLength(2))
    expect(queueCalls()[1]?.params).toEqual({ teamId: TEAM_A, tab: 'NEW', limit: 20 })
  })

  it.each([
    ['JUNIOR', '/project'],
    ['SENIOR', '/'],
    ['ACCOUNTANT', '/'],
  ])('renders nothing for %s and sends them home', async (role, home) => {
    serve()
    signIn({ id: HR_ID, role })
    renderPage()
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({ to: home, replace: true }))
    expect(screen.queryByTestId('job-queue-page')).toBeNull()
  })

  it('renders nothing for an outside role while the session is still loading', () => {
    serve()
    signIn({ id: HR_ID, role: 'JUNIOR' }, true)
    renderPage()
    expect(screen.queryByTestId('job-queue-page')).toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('renders nothing without a user', () => {
    serve()
    signIn(null)
    renderPage()
    expect(screen.queryByTestId('job-queue-page')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('scopes the HR queue query to the HR role and the team', async () => {
    serve()
    const { qc } = renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(
      qc.getQueryCache().findAll({ queryKey: ['job-queue', HR_ID, 'HR', TEAM_A] }),
    ).not.toEqual([])
  })

  it('keeps the queue when a later teams refetch fails', async () => {
    let fail = false
    serve({
      teamsCall: () =>
        fail
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ data: [team(TEAM_A, 'Alpha')] }),
    })
    const { qc } = renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    fail = true
    await act(() => qc.refetchQueries({ queryKey: ['teams'] }))
    expect(calls.filter((c) => c.url === '/teams')).toHaveLength(2)
    expect(qc.getQueryState(['teams', { archived: 'active' }])?.status).toBe('error')
    expect(screen.getByTestId(`job-queue-row-${ITEM_ID}`)).toBeInTheDocument()
    expect(screen.queryByTestId('job-queue-error')).toBeNull()
  })

  it('has no partial notice and no crash without generation facts', async () => {
    serve({ queue: () => Promise.resolve({ data: page({ generation: null }) }) })
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(screen.queryByTestId('job-queue-partial')).toBeNull()
  })

  it('labels the search box', async () => {
    serve()
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(searchInput()).toHaveAttribute('aria-label', 'Пошук за назвою або компанією')
    expect(searchInput()).toHaveAttribute('placeholder', 'Назва або компанія')
  })

  it('shows the tab count as the total before more pages load', async () => {
    serve({ queue: twoPages(() => new Promise(() => {})) })
    renderPage()
    await screen.findByTestId('job-queue-sentinel')
    expect(screen.queryByTestId('job-queue-retry')).toBeNull()
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent(/^Показано 1 із 7$/)
  })

  // `main` in the authenticated layout is `overflow-hidden`: without this box the page cannot scroll.
  it.each([
    ['the list', () => serve(), `job-queue-row-${ITEM_ID}`],
    ['the no-team state', () => serve({ teams: [] }), 'job-queue-no-team'],
    [
      'the failed team list',
      () => serve({ teamsCall: () => Promise.reject(apiError(500, 'INTERNAL')) }),
      'job-queue-error',
    ],
  ])('wraps %s in the page scroller', async (_label, arrange, testId) => {
    arrange()
    renderPage()
    await screen.findByTestId(testId)
    const scroller = screen.getByTestId('job-queue-scroll')
    expect(scroller).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto')
    expect(scroller).toContainElement(screen.getByTestId('job-queue-page'))
  })

  it('observes the sentinel against the page scroller', async () => {
    serve({ queue: twoPages(() => new Promise(() => {})) })
    renderPage()
    await screen.findByTestId('job-queue-sentinel')
    const live = observers.filter((o) => o.live)
    expect(live).toHaveLength(1)
    expect(live[0]!.root).toBe(screen.getByTestId('job-queue-scroll'))
  })

  it('a short first page already in view loads the next page without a scroll', async () => {
    StubObserver.inView = true
    serve({ queue: twoPages(() => new Promise(() => {})) })
    renderPage()
    await screen.findByTestId('job-queue-appending')
    expect(queueCalls().map((c) => c.params?.['cursor'])).toEqual([undefined, 'c1'])
  })

  it('does not arm the sentinel during a background refetch', async () => {
    const answer = { data: page({ nextCursor: 'c1' }) }
    let settle = () => {}
    let firstPages = 0
    serve({
      queue: () => {
        firstPages += 1
        return firstPages === 1
          ? Promise.resolve(answer)
          : new Promise((resolve) => {
              settle = () => resolve(answer)
            })
      },
    })
    const { qc } = renderPage()
    await screen.findByTestId('job-queue-sentinel')
    act(() => {
      void qc.invalidateQueries({ queryKey: ['job-queue'] })
    })
    await waitFor(() => expect(screen.queryByTestId('job-queue-sentinel')).toBeNull())
    expect(firstPages).toBe(2)
    act(() => settle())
    expect(await screen.findByTestId('job-queue-sentinel')).toBeInTheDocument()
  })

  // CR-H-1: TanStack Query keeps `data` and flips `status` to 'error' when a later page fails.
  it('a failed next page keeps the loaded rows and shows the append error', async () => {
    serve({ queue: twoPages(() => Promise.reject(apiError(500, 'INTERNAL'))) })
    renderPage()
    await screen.findByTestId('job-queue-sentinel')
    await scrollToEnd()
    expect(await screen.findByTestId('job-queue-append-error')).toHaveTextContent(
      'Не вдалося завантажити ще',
    )
    expect(screen.getByTestId(`job-queue-row-${ITEM_ID}`)).toBeInTheDocument()
    expect(screen.queryByTestId('job-queue-error')).toBeNull()
    expect(screen.getByTestId('job-queue-retry')).toHaveTextContent('Спробувати ще раз')
    // no auto-retry loop: the sentinel is gone until the user retries
    expect(screen.queryByTestId('job-queue-sentinel')).toBeNull()
    await scrollToEnd()
    expect(queueCalls()).toHaveLength(2)
  })

  it('a refresh-required next page keeps the rows, shows the refresh notice over the partial one and offers no retry', async () => {
    serve({
      queue: twoPages(() => Promise.reject(apiError(409, 'JOB_QUEUE_REFRESH_REQUIRED')), {
        generation: { ruleVersion: 'v1', evaluatedAt: '2026-11-01T00:00:00.000Z', capped: true },
      }),
    })
    renderPage()
    expect(await screen.findByTestId('job-queue-partial')).toBeInTheDocument()
    await screen.findByTestId('job-queue-sentinel')
    await scrollToEnd()
    expect(await screen.findByTestId('job-queue-refresh')).toHaveTextContent('Список змінився')
    expect(screen.queryByTestId('job-queue-partial')).toBeNull()
    expect(screen.getByTestId(`job-queue-row-${ITEM_ID}`)).toBeInTheDocument()
    expect(screen.queryByTestId('job-queue-error')).toBeNull()
    expect(screen.queryByTestId('job-queue-append-error')).toBeNull()
    expect(screen.queryByTestId('job-queue-retry')).toBeNull()
  })

  it('the foot refresh returns to the top of the list and parks focus on its body', async () => {
    serve({
      queue: twoPages(() => Promise.reject(apiError(409, 'JOB_QUEUE_REFRESH_REQUIRED'))),
    })
    renderPage()
    await screen.findByTestId('job-queue-sentinel')
    await scrollToEnd()
    const foot = await screen.findByTestId('job-queue-refresh-foot')
    const scroller = screen.getByTestId('job-queue-scroll')
    scroller.scrollTop = 2400
    const before = queueCalls().length
    await userEvent.click(foot)
    expect(scroller.scrollTop).toBe(0)
    expect(screen.getByTestId('job-queue-body')).toHaveFocus()
    await waitFor(() => expect(queueCalls().length).toBeGreaterThan(before))
    expect(await screen.findByTestId(`job-queue-row-${ITEM_ID}`)).toBeInTheDocument()
    expect(screen.queryByTestId('job-queue-refresh-foot')).toBeNull()
    expect(screen.queryByTestId('job-queue-refresh')).toBeNull()
  })

  it('the scroller is a focusable region named by the page heading, without taking focus on load', async () => {
    serve()
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    const scroller = screen.getByTestId('job-queue-scroll')
    expect(scroller).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('region', { name: 'Черга зовнішніх вакансій' })).toBe(scroller)
    // inset: the layout's `main` is `overflow-hidden` and would clip an outer ring
    expect(scroller).toHaveClass(
      'focus-visible:ring-2',
      'focus-visible:ring-inset',
      'focus-visible:ring-ring',
    )
    expect(scroller).not.toHaveFocus()
  })

  it('a loaded next page is appended and announced', async () => {
    serve({
      queue: twoPages(() =>
        Promise.resolve({
          data: page({
            items: [{ ...page().items[0]!, opportunityId: ITEM_2, title: 'Rust Lead' }],
          }),
        }),
      ),
    })
    renderPage()
    await screen.findByTestId('job-queue-sentinel')
    await scrollToEnd()
    // a scroll append never steals focus
    expect(await screen.findByTestId(`job-queue-row-${ITEM_2}`)).not.toHaveFocus()
    expect(screen.getByTestId('job-queue-live')).toHaveTextContent('Завантажено ще 1')
    expect(queueCalls()[1]?.params).toEqual({ teamId: TEAM_A, tab: 'NEW', limit: 20, cursor: 'c1' })
  })

  // CR-M-2: every URL write, with the exact target.
  it('a search submit trims the text and keeps tab, team and card', async () => {
    currentSearch = { tab: 'SUBMITTED', teamId: TEAM_B, card: ITEM_ID }
    serve({ teams: [team(TEAM_A, 'Alpha'), team(TEAM_B, 'Beta')] })
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    await userEvent.type(searchInput(), '  rust  {Enter}')
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/job-queue',
      search: { tab: 'SUBMITTED', teamId: TEAM_B, card: ITEM_ID, search: 'rust' },
    })
  })

  it('a blank search submit removes the search from the URL', async () => {
    currentSearch = { tab: 'NEW', search: 'go' }
    serve()
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    await userEvent.clear(searchInput())
    await userEvent.type(searchInput(), '   {Enter}')
    expect(mockNavigate).toHaveBeenLastCalledWith({ to: '/job-queue', search: { tab: 'NEW' } })
  })

  it('the clear-search button drops only the search', async () => {
    currentSearch = { tab: 'NEW', search: 'go', source: ['DOU_RSS'] }
    serve()
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    await userEvent.click(screen.getByRole('button', { name: 'Очистити пошук' }))
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/job-queue',
      search: { tab: 'NEW', source: ['DOU_RSS'] },
    })
  })

  it('applying filters keeps tab, team and search and drops the open card', async () => {
    currentSearch = { tab: 'HIDDEN', teamId: TEAM_B, search: 'go', card: ITEM_ID }
    serve({ teams: [team(TEAM_A, 'Alpha'), team(TEAM_B, 'Beta')] })
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    await userEvent.click(screen.getByTestId('job-queue-filters-button'))
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Відкрита' }))
    await userEvent.click(screen.getByTestId('job-queue-filters-apply'))
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/job-queue',
      search: { tab: 'HIDDEN', teamId: TEAM_B, search: 'go', availability: ['OPEN'] },
    })
  })

  it('switching team keeps the tab and drops search and filters', async () => {
    currentSearch = {
      tab: 'SUBMITTED',
      teamId: TEAM_A,
      search: 'go',
      source: ['DOU_RSS'],
      seniorIds: [SENIOR_A],
    }
    serve({ teams: [team(TEAM_A, 'Alpha'), team(TEAM_B, 'Beta')] })
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    await userEvent.click(screen.getByTestId('job-queue-team-switcher'))
    await userEvent.click(
      within(await screen.findByRole('listbox')).getByRole('option', { name: 'Beta' }),
    )
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/job-queue',
      search: { tab: 'SUBMITTED', teamId: TEAM_B },
    })
  })

  it('shows the applied filters and resets them, keeping the search', async () => {
    currentSearch = {
      tab: 'NEW',
      search: 'go',
      source: ['DOU_RSS', 'LEVER_ATS'],
      availability: ['OPEN'],
    }
    serve()
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    const applied = screen.getByTestId('job-queue-applied')
    expect(applied).toHaveTextContent('Застосовано: DOU, Lever · Відкрита')
    expect(screen.getByTestId('job-queue-filters-button')).toHaveTextContent('Фільтри2')
    await userEvent.click(within(applied).getByRole('button', { name: 'Скинути фільтри' }))
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/job-queue',
      search: { tab: 'NEW', search: 'go' },
    })
  })

  it('picks seniors into the URL, keeping tab, team and search', async () => {
    currentSearch = { tab: 'HIDDEN', teamId: TEAM_B, search: 'go', card: ITEM_ID }
    serve({ teams: [team(TEAM_A, 'Alpha'), team(TEAM_B, 'Beta')] })
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(calls).toContainEqual({ url: '/job-queue/seniors', params: { teamId: TEAM_B } })
    await userEvent.click(screen.getByTestId('job-queue-filters-button'))
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Анна Коваль' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Богдан Шевченко' }))
    await userEvent.click(screen.getByTestId('job-queue-filters-apply'))
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/job-queue',
      search: { tab: 'HIDDEN', teamId: TEAM_B, search: 'go', seniorIds: [SENIOR_A, SENIOR_B] },
    })
  })

  it('sends the URL seniors to the list and names them in the summary, never the id', async () => {
    currentSearch = { tab: 'NEW', seniorIds: [SENIOR_B, SENIOR_A] }
    serve()
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(queueCalls().at(-1)?.params).toEqual({
      teamId: TEAM_A,
      tab: 'NEW',
      limit: 20,
      seniorIds: '66666666-6666-4666-8666-666666666666,55555555-5555-4555-8555-555555555555',
    })
    const applied = await screen.findByTestId('job-queue-applied')
    expect(applied).toHaveTextContent('Застосовано: Богдан Шевченко, Анна Коваль')
    expect(applied).not.toHaveTextContent(SENIOR_A)
    expect(screen.getByTestId('job-queue-filters-button')).toHaveTextContent('Фільтри1')
  })

  it('resetting the filters drops the seniors', async () => {
    currentSearch = { tab: 'NEW', search: 'go', seniorIds: [SENIOR_A] }
    serve()
    renderPage()
    const applied = await screen.findByTestId('job-queue-applied')
    await userEvent.click(within(applied).getByRole('button', { name: 'Скинути фільтри' }))
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/job-queue',
      search: { tab: 'NEW', search: 'go' },
    })
  })

  it('a failed picker leaves the list and the rest of the panel working', async () => {
    currentSearch = { tab: 'NEW' }
    serve({ seniorsCall: () => Promise.reject(new Error('down')) })
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    await userEvent.click(screen.getByTestId('job-queue-filters-button'))
    const group = await screen.findByRole('group', { name: 'Сеньйори' })
    expect(await within(group).findByRole('alert')).toHaveTextContent(
      'Не вдалося завантажити сеньйорів',
    )
    await userEvent.click(screen.getByRole('checkbox', { name: 'Відкрита' }))
    await userEvent.click(screen.getByTestId('job-queue-filters-apply'))
    expect(mockNavigate).toHaveBeenLastCalledWith({
      to: '/job-queue',
      search: { tab: 'NEW', availability: ['OPEN'] },
    })
  })

  it('retries a failed picker from the panel', async () => {
    currentSearch = { tab: 'NEW' }
    const seniorsCall = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ data: { items: SENIOR_OPTIONS } })
    serve({ seniorsCall })
    renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    await userEvent.click(screen.getByTestId('job-queue-filters-button'))
    const group = await screen.findByRole('group', { name: 'Сеньйори' })
    await within(group).findByRole('alert')
    await userEvent.click(within(group).getByRole('button', { name: 'Спробувати ще раз' }))
    expect(await within(group).findByRole('checkbox', { name: 'Анна Коваль' })).toBeInTheDocument()
  })

  // CR-M-1: the box shows the applied search, also after the URL changes under it.
  it('the search box follows the URL search', async () => {
    currentSearch = { tab: 'NEW', search: 'go' }
    serve()
    const { rerender } = renderPage()
    await screen.findByTestId(`job-queue-row-${ITEM_ID}`)
    expect(searchInput()).toHaveValue('go')
    currentSearch = { tab: 'NEW' }
    rerender()
    expect(searchInput()).toHaveValue('')
    currentSearch = { tab: 'NEW', search: 'rust' }
    rerender()
    expect(searchInput()).toHaveValue('rust')
  })
})

// CR-M-3: `validateSearch` is the real schema (the stub keeps `options`).
describe('/job-queue search params', () => {
  const parse = (raw: Record<string, unknown>) =>
    (Route.options.validateSearch as { parse: (v: unknown) => unknown }).parse(raw)

  it('keeps valid values', () => {
    expect(
      parse({
        tab: 'HIDDEN',
        search: ' go ',
        source: ['DOU_RSS', 'LEVER_ATS'],
        availability: ['OPEN', 'CLOSED'],
        seniorIds: [SENIOR_A, SENIOR_B],
        teamId: TEAM_A,
        card: ITEM_ID,
      }),
    ).toEqual({
      tab: 'HIDDEN',
      search: 'go',
      source: ['DOU_RSS', 'LEVER_ATS'],
      availability: ['OPEN', 'CLOSED'],
      seniorIds: [SENIOR_A, SENIOR_B],
      teamId: TEAM_A,
      card: ITEM_ID,
    })
  })

  it('is the /_authenticated/job-queue/ file route', () => {
    expect((Route as unknown as { path: string }).path).toBe('/_authenticated/job-queue/')
  })

  it('degrades every bad value to its default', () => {
    expect(
      parse({
        tab: 'IN_PROGRESS',
        search: '   ',
        source: ['BOGUS'],
        eligibility: [],
        availability: 'OPEN',
        seniorIds: ['nope'],
        teamId: 'x',
        card: 'nope',
      }),
    ).toEqual({ tab: 'NEW' })
  })

  it('drops an empty or over-limit senior selection', () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(parse({ seniorIds: [] })).toEqual({ tab: 'NEW' })
    expect(parse({ seniorIds: ids(51) })).toEqual({ tab: 'NEW' })
    expect(parse({ seniorIds: ids(50) })).toEqual({ tab: 'NEW', seniorIds: ids(50) })
  })

  it('drops a search longer than 200 characters and defaults a missing tab', () => {
    expect(parse({ search: 'a'.repeat(201) })).toEqual({ tab: 'NEW' })
    expect(parse({ search: 'a'.repeat(200) })).toEqual({ tab: 'NEW', search: 'a'.repeat(200) })
  })
})
