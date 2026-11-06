import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import type { QueueScopeSignature } from '../use-job-queue'

const get = vi.fn()
vi.mock('@/lib/axios', () => ({ api: { get: (...args: unknown[]) => get(...args) } }))

const {
  JOB_QUEUE_PAGE_LIMIT,
  jobQueueCardQueryKey,
  jobQueueQueryKey,
  jobQueueScopeKey,
  useJobQueue,
  useJobQueueCard,
  useJobQueueSeniorOptions,
  useJobQueueSeniors,
  useJobQueueSources,
} = await import('../use-job-queue')

/**
 * r5 Task 7.1 — the queue's read hooks against a mocked `api`. Every expected value is a literal
 * (the URL, the params, the key), never recomputed from the code under test.
 */

const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_ACTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TEAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OPP = '11111111-1111-4111-8111-111111111111'
const OTHER_OPP = '44444444-4444-4444-8444-444444444444'
const SRC = '22222222-2222-4222-8222-222222222222'

const scope = { actorId: ACTOR, role: 'HR' as const, teamId: TEAM }
const studio = { actorId: ACTOR, role: 'ADMIN' as const, teamId: null }

const item = (over: Record<string, unknown> = {}) => ({
  opportunityId: OPP,
  revision: 3,
  title: 'Senior React Engineer',
  companyName: 'Acme',
  location: null,
  primarySource: { sourceRecordId: SRC, sourceType: 'DOU_RSS', url: 'https://jobs.dou.ua/1' },
  applicationUrl: null,
  alsoSeenOnCount: 0,
  availability: 'OPEN',
  eligibility: 'LEAD',
  matchedSeniorCount: 2,
  submittedSeniorCount: 0,
  stopListedSeniorCount: 0,
  openedByTeam: false,
  hidden: false,
  publishedAt: null,
  firstSeenAt: '2026-10-01T00:00:00.000Z',
  ...over,
})

const page = (nextCursor: string | null, items = [item()]) => ({
  items,
  nextCursor,
  counts: { NEW: 7, SUBMITTED: 1, HIDDEN: 0 },
  generation: { ruleVersion: 'r5', evaluatedAt: '2026-10-02T00:00:00.000Z', capped: false },
})

const senior = (n: number) => ({
  seniorId: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`,
  displayName: `Senior ${n}`,
  matchApproximate: false,
  matchedKeywords: ['react'],
  submission: null,
})

const source = (n: number) => ({
  sourceRecordId: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`,
  sourceType: 'DOU_RSS',
  url: `https://jobs.dou.ua/${n}`,
  linkedAt: '2026-10-01T00:00:00.000Z',
})

const cardBody = (over: Record<string, unknown> = {}) => ({
  ...item(),
  descriptionMd: '# Role',
  newerThanList: false,
  seniors: { items: [senior(1)], totalCount: 1, nextCursor: null },
  sources: { items: [source(1)], totalCount: 1, nextCursor: null },
  possibleDuplicates: null,
  ...over,
})

const httpError = (status: number, code: string) => ({
  isAxiosError: true,
  response: { status, data: { statusCode: status, code, message: code } },
})

let client: QueryClient
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  get.mockReset()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

describe('query keys', () => {
  it('scope every key by actor, role and team, under the non-persisted `job-queue` prefix', () => {
    expect(jobQueueScopeKey(scope)).toEqual(['job-queue', ACTOR, 'HR', TEAM])
    expect(jobQueueScopeKey(studio)).toEqual(['job-queue', ACTOR, 'ADMIN', 'default'])
    expect(jobQueueQueryKey(scope, 'NEW', { search: 'react' })).toEqual([
      'job-queue',
      ACTOR,
      'HR',
      TEAM,
      'list',
      'NEW',
      { search: 'react' },
    ])
    expect(jobQueueCardQueryKey(scope, OPP)).toEqual(['job-queue', ACTOR, 'HR', TEAM, 'card', OPP])
  })

  it('give another account a different key', () => {
    expect(jobQueueScopeKey({ ...scope, actorId: OTHER_ACTOR })).not.toEqual(jobQueueScopeKey(scope))
  })
})

describe('useJobQueueSeniorOptions', () => {
  const options = { items: [{ id: OPP, name: 'Анна Коваль' }] }

  it('reads the picker of the team under the scope key', async () => {
    get.mockResolvedValueOnce({ data: options })
    const { result } = renderHook(() => useJobQueueSeniorOptions(scope), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith('/job-queue/seniors', { params: { teamId: TEAM } })
    expect(result.current.data).toEqual(options)
    expect(client.getQueryData(['job-queue', ACTOR, 'HR', TEAM, 'senior-options'])).toEqual(options)
  })

  it('sends no teamId for the studio scope', async () => {
    get.mockResolvedValueOnce({ data: { items: [] } })
    const { result } = renderHook(() => useJobQueueSeniorOptions(studio), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith('/job-queue/seniors', { params: {} })
  })

  it('refuses a body with more than id and name', async () => {
    get.mockResolvedValueOnce({
      data: { items: [{ id: OPP, name: 'Анна Коваль', email: 'a@example.test' }] },
    })
    const { result } = renderHook(() => useJobQueueSeniorOptions(scope), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ZodError)
  })
})

describe('useJobQueue', () => {
  it('reads 20 per page with the scope, tab and comma-joined filters, then follows nextCursor', async () => {
    get.mockResolvedValueOnce({ data: page('c-2') }).mockResolvedValueOnce({ data: page(null) })

    const filters = {
      search: 'react',
      source: ['DOU_RSS' as const, 'REMOTEOK_API' as const],
      eligibility: [] as ('LEAD' | 'TRIAGE')[],
    }
    const { result } = renderHook(() => useJobQueue(scope, 'SUBMITTED', filters), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(JOB_QUEUE_PAGE_LIMIT).toBe(20)
    expect(get).toHaveBeenNthCalledWith(1, '/job-queue', {
      params: { teamId: TEAM, tab: 'SUBMITTED', search: 'react', source: 'DOU_RSS,REMOTEOK_API', limit: 20 },
    })
    expect(result.current.hasNextPage).toBe(true)
    expect(result.current.data?.pages[0]?.counts).toEqual({ NEW: 7, SUBMITTED: 1, HIDDEN: 0 })

    await act(() => result.current.fetchNextPage())
    expect(get).toHaveBeenNthCalledWith(2, '/job-queue', {
      params: {
        teamId: TEAM,
        tab: 'SUBMITTED',
        search: 'react',
        source: 'DOU_RSS,REMOTEOK_API',
        limit: 20,
        cursor: 'c-2',
      },
    })
    await waitFor(() => expect(result.current.hasNextPage).toBe(false))
    expect(result.current.data?.pages).toHaveLength(2)
  })

  it('comma-joins the selected seniors on the wire', async () => {
    get.mockResolvedValueOnce({ data: page(null) })
    const { result } = renderHook(
      () => useJobQueue(scope, 'NEW', { seniorIds: [ACTOR, OTHER_ACTOR] }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith('/job-queue', {
      params: {
        teamId: TEAM,
        tab: 'NEW',
        seniorIds: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        limit: 20,
      },
    })
  })

  it('sends no teamId for the default (studio) scope', async () => {
    get.mockResolvedValueOnce({ data: page(null) })
    const { result } = renderHook(() => useJobQueue(studio, 'NEW', {}), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith('/job-queue', { params: { tab: 'NEW', limit: 20 } })
  })

  it('refuses a `javascript:` source URL at parse time', async () => {
    const evil = item({
      primarySource: { sourceRecordId: SRC, sourceType: 'DOU_RSS', url: 'javascript:alert(1)' },
    })
    get.mockResolvedValueOnce({ data: page(null, [evil]) })
    const { result } = renderHook(() => useJobQueue(scope, 'NEW', {}), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
    expect(result.current.refreshRequired).toBe(false)
  })

  it('flags an expired cursor as refresh-required and restarts from a clean first page', async () => {
    get
      .mockResolvedValueOnce({ data: page('c-2') })
      .mockRejectedValueOnce(httpError(409, 'JOB_QUEUE_REFRESH_REQUIRED'))
      .mockResolvedValueOnce({ data: page(null, [item({ title: 'Fresh' })]) })

    const { result } = renderHook(() => useJobQueue(scope, 'NEW', {}), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await act(() => result.current.fetchNextPage())
    await waitFor(() => expect(result.current.refreshRequired).toBe(true))

    await act(() => result.current.restart())
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1))
    expect(result.current.data?.pages[0]?.items[0]?.title).toBe('Fresh')
    expect(result.current.refreshRequired).toBe(false)
    expect(get).toHaveBeenLastCalledWith('/job-queue', {
      params: { teamId: TEAM, tab: 'NEW', limit: 20 },
    })
  })

  it('restarts only its own list: a longer key and a card of the scope keep their data', async () => {
    const extra = ['job-queue', ACTOR, 'HR', TEAM, 'list', 'NEW', {}, 'extra']
    client.setQueryData(extra, { kept: true })
    client.setQueryData(jobQueueCardQueryKey(scope, OPP), cardBody())
    get
      .mockResolvedValueOnce({ data: page(null) })
      .mockResolvedValueOnce({ data: page(null, [item({ title: 'Fresh' })]) })
    const { result } = renderHook(() => useJobQueue(scope, 'NEW', {}), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    await act(() => result.current.restart())
    await waitFor(() => expect(result.current.data?.pages[0]?.items[0]?.title).toBe('Fresh'))
    expect(client.getQueryData(extra)).toEqual({ kept: true })
    expect(client.getQueryData(jobQueueCardQueryKey(scope, OPP))).toEqual(cardBody())
  })

  it('does not call an error without an API code refresh-required', async () => {
    get.mockRejectedValueOnce(new Error('Network Error'))
    const { result } = renderHook(() => useJobQueue(scope, 'NEW', {}), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.refreshRequired).toBe(false)
  })

  it('treats a malformed cursor as refresh-required too', async () => {
    get.mockRejectedValueOnce(httpError(400, 'JOB_QUEUE_CURSOR_MALFORMED'))
    const { result } = renderHook(() => useJobQueue(scope, 'NEW', {}), { wrapper })
    await waitFor(() => expect(result.current.refreshRequired).toBe(true))
  })

  it('does not call any other error refresh-required or access-lost', async () => {
    get.mockRejectedValueOnce(httpError(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    const { result } = renderHook(() => useJobQueue(scope, 'NEW', {}), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.refreshRequired).toBe(false)
    expect(result.current.accessLost).toBe(false)
  })

  it('on 403 hides the last pages and drops the scope cache no screen observes', async () => {
    client.setQueryData(jobQueueCardQueryKey(scope, OPP), cardBody())
    get.mockResolvedValueOnce({ data: page(null) })
    const { result } = renderHook(() => useJobQueue(scope, 'NEW', {}), { wrapper })
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1))

    get.mockRejectedValueOnce(httpError(403, 'FORBIDDEN'))
    await act(() => result.current.refetch())
    await waitFor(() => expect(result.current.accessLost).toBe(true))
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(client.getQueryState(jobQueueCardQueryKey(scope, OPP))).toBeUndefined())
    expect(client.getQueryState(jobQueueQueryKey(scope, 'NEW', {}))).toBeDefined()
  })

  it('starts a filter change from a first page under its own key', async () => {
    get.mockResolvedValue({ data: page(null) })
    const { result, rerender } = renderHook(
      ({ search }: { search?: string }) => useJobQueue(scope, 'NEW', search ? { search } : {}),
      { wrapper, initialProps: {} },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    rerender({ search: 'go' })
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith('/job-queue', {
        params: { teamId: TEAM, tab: 'NEW', search: 'go', limit: 20 },
      }),
    )
  })

  it('evicts every other scope (account switch, team switch, authorization change)', async () => {
    client.setQueryData(jobQueueCardQueryKey({ ...scope, actorId: OTHER_ACTOR }, OPP), cardBody())
    client.setQueryData(jobQueueCardQueryKey({ ...scope, teamId: null }, OPP), cardBody())
    client.setQueryData(jobQueueCardQueryKey({ ...scope, role: 'ADMIN' }, OPP), cardBody())
    client.setQueryData(jobQueueCardQueryKey(scope, OPP), cardBody())
    client.setQueryData(['hr', 'summary'], { kept: true })
    get.mockResolvedValue({ data: page(null) })

    renderHook(() => useJobQueue(scope, 'NEW', {}), { wrapper })

    await waitFor(() =>
      expect(client.getQueryData(jobQueueCardQueryKey({ ...scope, actorId: OTHER_ACTOR }, OPP))).toBeUndefined(),
    )
    expect(client.getQueryData(jobQueueCardQueryKey({ ...scope, teamId: null }, OPP))).toBeUndefined()
    expect(client.getQueryData(jobQueueCardQueryKey({ ...scope, role: 'ADMIN' }, OPP))).toBeUndefined()
    expect(client.getQueryData(jobQueueCardQueryKey(scope, OPP))).toBeDefined()
    expect(client.getQueryData(['hr', 'summary'])).toEqual({ kept: true })
  })

  it('evicts the previous scope when the same mounted list switches team', async () => {
    get.mockResolvedValue({ data: page(null) })
    const { result, rerender } = renderHook(
      ({ s }: { s: QueueScopeSignature }) => useJobQueue(s, 'NEW', {}),
      { wrapper, initialProps: { s: scope as QueueScopeSignature } },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    client.setQueryData(jobQueueCardQueryKey(scope, OPP), cardBody())

    rerender({ s: { ...scope, teamId: null } })

    await waitFor(() =>
      expect(client.getQueryData(['job-queue', ACTOR, 'HR', TEAM, 'card', OPP])).toBeUndefined(),
    )
    expect(client.getQueryData(['job-queue', ACTOR, 'HR', TEAM, 'list', 'NEW', {}])).toBeUndefined()
  })
})

describe('useJobQueueCard', () => {
  it('stays idle without an id', () => {
    const { result } = renderHook(() => useJobQueueCard(scope, null), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
    expect(get).not.toHaveBeenCalled()
  })

  it('reads the card in the scope and parses it', async () => {
    get.mockResolvedValueOnce({ data: cardBody() })
    const { result } = renderHook(() => useJobQueueCard(scope, OPP), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith(`/job-queue/${OPP}`, { params: { teamId: TEAM } })
    expect(result.current.data?.title).toBe('Senior React Engineer')
    expect(result.current.accessLost).toBe(false)
  })

  it('caches the card under its own id and, on success, leaves the scope lists alone', async () => {
    const list = ['job-queue', ACTOR, 'HR', TEAM, 'list', 'NEW', {}]
    client.setQueryData(list, { pages: [page(null)], pageParams: [null] })
    get.mockResolvedValueOnce({ data: cardBody() })
    const { result } = renderHook(() => useJobQueueCard(scope, OPP), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await act(() => new Promise((r) => setTimeout(r, 50)))

    expect(client.getQueryData(['job-queue', ACTOR, 'HR', TEAM, 'card', OPP])).toMatchObject({
      title: 'Senior React Engineer',
    })
    expect(client.getQueryState(list)?.isInvalidated).toBe(false)
    expect(client.getQueryData(list)).toEqual({ pages: [page(null)], pageParams: [null] })
  })

  it('encodes the id into the path', async () => {
    get.mockResolvedValueOnce({ data: cardBody() })
    renderHook(() => useJobQueueCard(scope, 'a/b?c'), { wrapper })
    await waitFor(() => expect(get).toHaveBeenCalledWith('/job-queue/a%2Fb%3Fc', { params: { teamId: TEAM } }))
  })

  it('refuses a card carrying a field outside the contract with a ZodError', async () => {
    get.mockResolvedValueOnce({ data: cardBody({ takenByTeam: 'Other team' }) })
    const { result } = renderHook(() => useJobQueueCard(scope, OPP), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ZodError)
    expect(result.current.data).toBeUndefined()
  })

  it('on a revoked authorization (404) hides the card, drops its continuations and refreshes the open list', async () => {
    const continuation = [...jobQueueCardQueryKey(scope, OPP), 'seniors', 's-200']
    const listCalls = () => get.mock.calls.filter((c) => c[0] === '/job-queue').length
    const cardCalls = () => get.mock.calls.filter((c) => c[0] === `/job-queue/${OPP}`).length
    get.mockImplementation((url: string) =>
      Promise.resolve({ data: url === '/job-queue' ? page(null) : cardBody() }),
    )
    const { result } = renderHook(
      () => ({ list: useJobQueue(scope, 'NEW', {}), card: useJobQueueCard(scope, OPP) }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.card.data?.title).toBe('Senior React Engineer'))
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true))
    client.setQueryData(continuation, { pages: [], pageParams: [] })

    get.mockImplementation((url: string) =>
      url === '/job-queue'
        ? Promise.resolve({ data: page(null) })
        : Promise.reject(httpError(404, 'JOB_OPPORTUNITY_NOT_FOUND')),
    )
    await act(() => result.current.card.refetch())
    await waitFor(() => expect(result.current.card.accessLost).toBe(true))
    expect(result.current.card.data).toBeUndefined()
    await waitFor(() => expect(client.getQueryState(continuation)).toBeUndefined())
    await waitFor(() => expect(listCalls()).toBe(2))
    // Let the queue settle: a late refetch loop would push either count past 2.
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(listCalls()).toBe(2)
    expect(cardCalls()).toBe(2)
    expect(client.getQueryState(jobQueueQueryKey(scope, 'NEW', {}))).toBeDefined()
  })

  it('on 403 hides the card and drops the scope cache no screen observes', async () => {
    client.setQueryData(jobQueueCardQueryKey(scope, OTHER_OPP), cardBody())
    client.setQueryData(jobQueueCardQueryKey({ ...scope, actorId: OTHER_ACTOR }, OTHER_OPP), cardBody())
    get.mockRejectedValueOnce(httpError(403, 'FORBIDDEN'))
    const { result } = renderHook(() => useJobQueueCard(scope, OPP), { wrapper })
    await waitFor(() => expect(result.current.accessLost).toBe(true))
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(client.getQueryState(jobQueueCardQueryKey(scope, OTHER_OPP))).toBeUndefined())
    expect(
      client.getQueryState(jobQueueCardQueryKey({ ...scope, actorId: OTHER_ACTOR }, OTHER_OPP)),
    ).toBeDefined()
  })

  it('keeps the data and the cache on any other error', async () => {
    client.setQueryData(jobQueueCardQueryKey(scope, OTHER_OPP), cardBody())
    get.mockResolvedValueOnce({ data: cardBody() })
    const { result } = renderHook(() => useJobQueueCard(scope, OPP), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    get.mockRejectedValueOnce(httpError(503, 'JOB_QUEUE_POLICY_UNAVAILABLE'))
    await act(() => result.current.refetch())
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.accessLost).toBe(false)
    expect(result.current.data?.title).toBe('Senior React Engineer')
    expect(client.getQueryState(jobQueueCardQueryKey(scope, OTHER_OPP))).toBeDefined()
  })
})

describe('card continuations', () => {
  it('continue the 200-senior preview from its cursor (201 seniors)', async () => {
    get.mockResolvedValueOnce({ data: { items: [senior(201)], totalCount: 201, nextCursor: null } })
    const { result } = renderHook(() => useJobQueueSeniors(scope, OPP, 's-200'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith(`/job-queue/${OPP}/seniors`, {
      params: { teamId: TEAM, cursor: 's-200' },
    })
    expect(result.current.data?.pages[0]?.totalCount).toBe(201)
    expect(result.current.data?.pages[0]?.items[0]?.displayName).toBe('Senior 201')
    expect(result.current.hasNextPage).toBe(false)
  })

  it('continue the 20-source preview and keep the server denominator (21 sources)', async () => {
    get
      .mockResolvedValueOnce({ data: { items: [source(21)], totalCount: 21, nextCursor: 'x-2' } })
      .mockResolvedValueOnce({ data: { items: [source(22)], totalCount: 21, nextCursor: null } })
    const { result } = renderHook(() => useJobQueueSources(studio, OPP, 'x-1'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith(`/job-queue/${OPP}/sources`, { params: { cursor: 'x-1' } })
    expect(result.current.data?.pages[0]?.totalCount).toBe(21)
    expect(result.current.hasNextPage).toBe(true)
    await act(() => result.current.fetchNextPage())
    expect(get).toHaveBeenLastCalledWith(`/job-queue/${OPP}/sources`, { params: { cursor: 'x-2' } })
  })

  it('refuse a `javascript:` URL in a source continuation', async () => {
    get.mockResolvedValueOnce({
      data: { items: [{ ...source(21), url: 'javascript:alert(1)' }], totalCount: 21, nextCursor: null },
    })
    const { result } = renderHook(() => useJobQueueSources(scope, OPP, 'x-1'), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  it('stay idle without a cursor or without an id', () => {
    renderHook(() => useJobQueueSeniors(scope, OPP, null), { wrapper })
    renderHook(() => useJobQueueSources(scope, null, 'x-1'), { wrapper })
    expect(get).not.toHaveBeenCalled()
  })

  it('live under the card key, so invalidating the card refreshes them', async () => {
    get.mockResolvedValue({ data: { items: [senior(201)], totalCount: 201, nextCursor: null } })
    const { result } = renderHook(() => useJobQueueSeniors(scope, OPP, 's-200'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledTimes(1)

    await act(() => client.invalidateQueries({ queryKey: jobQueueCardQueryKey(scope, OPP) }))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    expect(get).toHaveBeenLastCalledWith(`/job-queue/${OPP}/seniors`, {
      params: { teamId: TEAM, cursor: 's-200' },
    })
  })

  it.each([
    ['seniors', useJobQueueSeniors],
    ['sources', useJobQueueSources],
  ] as const)('%s: on 403 hide the page and drop the scope cache no screen observes', async (_part, hook) => {
    client.setQueryData(jobQueueCardQueryKey(scope, OTHER_OPP), cardBody())
    get.mockRejectedValueOnce(httpError(403, 'FORBIDDEN'))
    const { result } = renderHook(() => hook(scope, OPP, 'c-1'), { wrapper })
    await waitFor(() => expect(result.current.accessLost).toBe(true))
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(client.getQueryState(jobQueueCardQueryKey(scope, OTHER_OPP))).toBeUndefined())
  })

  it('keep a page on a non-access error', async () => {
    get.mockRejectedValueOnce(httpError(503, 'JOB_QUEUE_POLICY_UNAVAILABLE'))
    const { result } = renderHook(() => useJobQueueSeniors(scope, OPP, 'c-1'), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.accessLost).toBe(false)
  })
})
