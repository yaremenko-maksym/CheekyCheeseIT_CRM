/**
 * Task 7.6c — the session cookie can change under an open page (a sign-in in another tab). The
 * `_authenticated` route revalidates the cached `auth/me` user on each pathname change; when the user
 * id differs, every other query and the persisted copy are purged BEFORE the next route renders, so
 * the new account never paints the previous account's cached rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { persistQueryClientSubscribe } from '@tanstack/react-query-persist-client'

const { apiGet, idbDel, idbGet, idbSet } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  idbDel: vi.fn(),
  idbGet: vi.fn(),
  idbSet: vi.fn(),
}))
vi.mock('../../lib/axios', () => ({ api: { get: apiGet } }))
vi.mock('idb-keyval', () => ({ del: idbDel, get: idbGet, set: idbSet }))

import { AuthProvider, createSessionRevalidator } from '../auth'
import { PERSIST_KEY, persister } from '../../lib/persister'

const anna = { id: 'user-anna', role: 'HR' }
const kateryna = { id: 'user-kateryna', role: 'HR' }
const QUEUE_KEY = ['job-queue', 'user-anna', 'HR', 'team-kovalenko', 'list']

function seeded(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['auth', 'me'], anna)
  qc.setQueryData(QUEUE_KEY, { rows: ['anna-only-row'] })
  return qc
}

const meReturns = (user: unknown) => apiGet.mockResolvedValue({ status: 200, data: user })

beforeEach(() => {
  apiGet.mockReset()
  idbDel.mockReset().mockResolvedValue(undefined)
})

describe('createSessionRevalidator', () => {
  it('purges the other queries and the persisted copy when the session user id changes', async () => {
    const qc = seeded()
    meReturns(kateryna)

    await createSessionRevalidator(qc)('/job-queue')

    expect(apiGet).toHaveBeenCalledWith('/auth/me', expect.anything())
    expect(qc.getQueryData(['auth', 'me'])).toEqual(kateryna)
    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
    expect(idbDel).toHaveBeenCalledWith(PERSIST_KEY)
  })

  it('does not reuse an auth/me answer already in flight under the previous cookie', async () => {
    const qc = seeded()
    // the previous navigation's request left before the cookie changed and answers late, as Anna
    let answerAsAnna: (v: unknown) => void = () => {}
    apiGet.mockReturnValueOnce(new Promise((resolve) => (answerAsAnna = resolve)))
    const revalidate = createSessionRevalidator(qc)
    const stale = revalidate('/projects')
    meReturns(kateryna)

    const current = revalidate('/job-queue')
    answerAsAnna({ status: 200, data: anna })
    await Promise.all([stale, current])

    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
    expect(qc.getQueryData(['auth', 'me'])).toEqual(kateryna)
    expect(idbDel).toHaveBeenCalledWith(PERSIST_KEY)
  })

  it('purges every query but exactly auth/me, including keys sharing one segment with it', async () => {
    const qc = seeded()
    qc.setQueryData(['auth', 'other'], 'anna-auth-data')
    qc.setQueryData(['x', 'me'], 'anna-x-data')
    meReturns(kateryna)

    await createSessionRevalidator(qc)('/job-queue')

    expect(qc.getQueryData(['auth', 'me'])).toEqual(kateryna)
    expect(qc.getQueryData(['auth', 'other'])).toBeUndefined()
    expect(qc.getQueryData(['x', 'me'])).toBeUndefined()
  })

  it('cancels only the exact auth/me request, not other requests in flight', async () => {
    const qc = seeded()
    const inFlight = (queryKey: string[]) => {
      let answer: (v: string) => void = () => {}
      const result = qc.fetchQuery({
        queryKey,
        queryFn: () => new Promise<string>((resolve) => (answer = resolve)),
      })
      return { result, answer: (v: string) => answer(v) }
    }
    const projects = inFlight(['projects'])
    const nested = inFlight(['auth', 'me', 'extra'])
    meReturns(anna)

    await createSessionRevalidator(qc)('/job-queue')

    expect(qc.getQueryState(['projects'])?.fetchStatus).toBe('fetching')
    expect(qc.getQueryState(['auth', 'me', 'extra'])?.fetchStatus).toBe('fetching')
    projects.answer('projects-data')
    nested.answer('nested-data')
    await expect(projects.result).resolves.toBe('projects-data')
    await expect(nested.result).resolves.toBe('nested-data')
  })

  it("drops AuthProvider's own auth/me request still in flight from before the cookie change", async () => {
    const qc = seeded()
    let answerAsAnna: (v: unknown) => void = () => {}
    const late = qc
      .fetchQuery({
        queryKey: ['auth', 'me'],
        queryFn: () => new Promise((resolve) => (answerAsAnna = resolve)),
        staleTime: 0,
      })
      .catch(() => {})
    meReturns(kateryna)

    await createSessionRevalidator(qc)('/job-queue')
    answerAsAnna(anna)
    await late

    expect(qc.getQueryData(['auth', 'me'])).toEqual(kateryna)
    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
  })

  it('a repeat of the same path waits for the revalidation in flight (hover preload, then click)', async () => {
    const qc = seeded()
    let answerAsKateryna: (v: unknown) => void = () => {}
    apiGet.mockReturnValueOnce(new Promise((resolve) => (answerAsKateryna = resolve)))
    const revalidate = createSessionRevalidator(qc)
    void revalidate('/job-queue') // the router runs the layout's beforeLoad on hover preload too

    let clickSettled = false
    const click = revalidate('/job-queue').then(() => (clickSettled = true))
    await Promise.resolve()
    expect(clickSettled).toBe(false)

    answerAsKateryna({ status: 200, data: kateryna })
    await click
    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('a superseded check waits for the newer one instead of letting its navigation render unpurged', async () => {
    const qc = seeded()
    let answerAsAnna: (v: unknown) => void = () => {}
    let answerAsKateryna: (v: unknown) => void = () => {}
    apiGet
      .mockReturnValueOnce(new Promise((resolve) => (answerAsAnna = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (answerAsKateryna = resolve)))
    const revalidate = createSessionRevalidator(qc)
    let navigationSettled = false
    const navigation = revalidate('/job-queue').then(() => (navigationSettled = true))
    void revalidate('/projects') // a hover preload of another link while the navigation waits

    answerAsAnna({ status: 200, data: anna }) // the older request, sent under the old cookie
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(navigationSettled).toBe(false)

    answerAsKateryna({ status: 200, data: kateryna })
    await navigation
    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
  })

  it('a settled check of the same path is reused only briefly (hover, then click); later it asks again', async () => {
    const qc = seeded()
    meReturns(anna)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const revalidate = createSessionRevalidator(qc)
    await revalidate('/job-queue')
    await revalidate('/job-queue')
    expect(apiGet).toHaveBeenCalledTimes(1)

    // the cookie changes; a filter change on the same path a while later must still see it
    meReturns(kateryna)
    now.mockReturnValue(1_000_000 + 5_000)
    await revalidate('/job-queue')
    now.mockRestore()

    expect(apiGet).toHaveBeenCalledTimes(2)
    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
  })

  it('a settled check is no longer reused once exactly REUSE_MS (1s) has passed', async () => {
    const qc = seeded()
    meReturns(anna)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const revalidate = createSessionRevalidator(qc)
    await revalidate('/job-queue')

    now.mockReturnValue(1_000_000 + 999)
    await revalidate('/job-queue')
    expect(apiGet).toHaveBeenCalledTimes(1)

    now.mockReturnValue(1_000_000 + 1_000)
    await revalidate('/job-queue')
    now.mockRestore()

    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('purges when the session is gone (401), and stops persisting first as logout does', async () => {
    // the stop is one-way for the page: fresh modules, so the other cases keep persisting
    vi.resetModules()
    const fresh = await import('../auth')
    const store = await import('../../lib/persister')
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60_000) // the persister's throttle is idle: a save runs at once
    try {
      idbSet.mockReset().mockResolvedValue(undefined)
      apiGet.mockResolvedValue({ status: 401, data: {} })
      const qc = seeded()
      await fresh.createSessionRevalidator(qc)('/job-queue')
      expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
      expect(idbDel).toHaveBeenCalledWith(PERSIST_KEY)

      const client = { timestamp: 1, buster: '', clientState: { queries: [], mutations: [] } }
      await store.persister.persistClient(client as Parameters<typeof persister.persistClient>[0])
      await vi.advanceTimersByTimeAsync(1000)

      expect(idbSet).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the cache when the same user is still signed in', async () => {
    const qc = seeded()
    meReturns(anna)

    await createSessionRevalidator(qc)('/job-queue')

    expect(qc.getQueryData(QUEUE_KEY)).toEqual({ rows: ['anna-only-row'] })
    expect(idbDel).not.toHaveBeenCalled()
  })

  it('keeps the cache when the revalidation itself fails (the server still enforces access)', async () => {
    const qc = seeded()
    apiGet.mockRejectedValue(new Error('offline'))

    await expect(createSessionRevalidator(qc)('/job-queue')).resolves.toBeUndefined()

    expect(qc.getQueryData(QUEUE_KEY)).toEqual({ rows: ['anna-only-row'] })
    expect(qc.getQueryData(['auth', 'me'])).toEqual(anna)
  })

  it('sends no request before the first auth/me answer (AuthProvider owns that fetch)', async () => {
    const qc = new QueryClient()

    await createSessionRevalidator(qc)('/job-queue')

    expect(apiGet).not.toHaveBeenCalled()
  })

  it('a repeat of the same path within 1s reuses one check; another path asks again', async () => {
    const qc = seeded()
    meReturns(anna)
    const revalidate = createSessionRevalidator(qc)

    await revalidate('/job-queue')
    await revalidate('/job-queue')
    await revalidate('/projects')

    expect(apiGet).toHaveBeenCalledTimes(2)
  })
})

describe('session owner watch (CR-H-1): a changed auth/me user purges, whoever wrote it', () => {
  it('purges when other code wrote the new user to auth/me before the route change', async () => {
    const qc = seeded()
    const revalidate = createSessionRevalidator(qc)
    // e.g. refetchOnReconnect, invalidateQueries(['auth','me']) or AuthProvider remounting
    qc.setQueryData(['auth', 'me'], kateryna)
    meReturns(kateryna)

    await revalidate('/job-queue')

    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
    expect(qc.getQueryData(['auth', 'me'])).toEqual(kateryna)
    expect(idbDel).toHaveBeenCalledWith(PERSIST_KEY)
  })

  it('purges on an auth/me refetch answering as another user, with no route change at all', async () => {
    const qc = seeded()
    createSessionRevalidator(qc)

    await qc.fetchQuery({ queryKey: ['auth', 'me'], queryFn: () => kateryna, staleTime: 0 })

    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
    expect(idbDel).toHaveBeenCalledWith(PERSIST_KEY)
  })

  it('ignores other queries and non-answer auth/me events (new query, reset, invalidate)', async () => {
    const qc = seeded()
    createSessionRevalidator(qc)

    qc.setQueryData(['projects'], { id: 'not-a-user' })
    await qc.invalidateQueries({ queryKey: ['auth', 'me'], refetchType: 'none' })
    await qc.resetQueries({ queryKey: ['auth', 'me'], exact: true })

    expect(qc.getQueryData(QUEUE_KEY)).toEqual({ rows: ['anna-only-row'] })
    expect(qc.getQueryData(['projects'])).toEqual({ id: 'not-a-user' })
    expect(idbDel).not.toHaveBeenCalled()
  })

  it('a later answer as the same user after a reset keeps the cache', async () => {
    const qc = seeded()
    createSessionRevalidator(qc)
    await qc.resetQueries({ queryKey: ['auth', 'me'], exact: true })

    qc.setQueryData(['auth', 'me'], anna)

    expect(qc.getQueryData(QUEUE_KEY)).toEqual({ rows: ['anna-only-row'] })
    expect(idbDel).not.toHaveBeenCalled()
  })

  it('labels the persisted cache with the user auth/me now answers for', async () => {
    vi.useFakeTimers()
    try {
      const qc = seeded()
      createSessionRevalidator(qc)
      qc.setQueryData(['auth', 'me'], kateryna)

      const client = { timestamp: 1, buster: '', clientState: { queries: [], mutations: [] } }
      await persister.persistClient(client as Parameters<typeof persister.persistClient>[0])
      await vi.advanceTimersByTimeAsync(1000) // the persister throttles writes

      expect(idbSet).toHaveBeenCalledWith(PERSIST_KEY, expect.any(String))
      expect(JSON.parse(idbSet.mock.lastCall?.[1] as string).owner).toBe('user-kateryna')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a persist written during the purge never labels the old rows with the new owner (PR #1334 SR-H-1)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60_000) // the persister's throttle is idle: the next save runs at once
    try {
      idbSet.mockReset().mockResolvedValue(undefined)
      const qc = seeded()
      qc.setQueryData(['projects', 'user-anna', 'list'], [{ name: 'anna-only-project' }])
      // the app's order: the `_authenticated` route module subscribes before PersistQueryClientProvider
      createSessionRevalidator(qc)
      qc.setQueryData(['auth', 'me'], anna) // Anna's answer landed: the cache is labelled hers
      const unsubscribe = persistQueryClientSubscribe({ queryClient: qc, persister })

      qc.setQueryData(['auth', 'me'], kateryna)
      await vi.advanceTimersByTimeAsync(1000) // the immediate save and the throttled one after it

      // per write: [owner label, carries one of Anna's rows]
      const writes = idbSet.mock.calls.map(([, value]) => [
        JSON.parse(value as string).owner,
        /anna-only-(row|project)/.test(value as string),
      ])
      // the save the first reset runs still holds Anna's project; the next one is clean
      expect(writes).toEqual([
        ['user-anna', true],
        ['user-kateryna', false],
      ])
      unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a signed-out answer as an owner too: a sign-in after it purges', async () => {
    const qc = new QueryClient()
    qc.setQueryData(['auth', 'me'], null)
    qc.setQueryData(QUEUE_KEY, { rows: ['signed-out-row'] })
    createSessionRevalidator(qc)

    qc.setQueryData(['auth', 'me'], kateryna)

    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
  })

  it('keeps purging on every later switch, not only the first', async () => {
    const qc = seeded()
    createSessionRevalidator(qc)
    qc.setQueryData(['auth', 'me'], kateryna)
    qc.setQueryData(QUEUE_KEY, { rows: ['kateryna-only-row'] })

    qc.setQueryData(['auth', 'me'], anna)

    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
  })
})

describe('session revalidation request (CR-M-1)', () => {
  it('a failed or timed-out check leaves an auth/me request already in flight alone', async () => {
    const qc = seeded()
    let answer: (v: unknown) => void = () => {}
    const inFlight = qc.fetchQuery({
      queryKey: ['auth', 'me'],
      queryFn: () => new Promise((resolve) => (answer = resolve)),
      staleTime: 0,
    })
    apiGet.mockRejectedValue(new Error('timeout of 3000ms exceeded'))

    await createSessionRevalidator(qc)('/job-queue')

    expect(qc.getQueryState(['auth', 'me'])?.fetchStatus).toBe('fetching')
    answer(anna)
    await expect(inFlight).resolves.toEqual(anna)
  })

  it("AuthProvider's own auth/me request is the session answer, with no timeout", async () => {
    meReturns(anna)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(AuthProvider, { children: null }),
      ),
    )

    await waitFor(() => expect(qc.getQueryData(['auth', 'me'])).toEqual(anna))
    expect(apiGet).toHaveBeenCalledWith('/auth/me', expect.objectContaining({ timeout: 0 }))
  })

  it('gives up on /auth/me after 3s, so a hung request cannot block the navigation', async () => {
    const qc = seeded()
    meReturns(anna)

    await createSessionRevalidator(qc)('/job-queue')

    expect(apiGet).toHaveBeenCalledWith('/auth/me', expect.objectContaining({ timeout: 3000 }))
  })
})

describe('restored cache owner (SR-M-1): the first auth/me answer after a page load', () => {
  const restoredBlob = (owner?: unknown, queries: unknown[] = [{ queryKey: QUEUE_KEY }]) =>
    JSON.stringify({ timestamp: 1, buster: '', owner, clientState: { queries, mutations: [] } })

  // a fresh page: the persisted cache is restored first, then AuthProvider's auth/me answers
  async function pageLoad(blob: string | undefined) {
    idbGet.mockResolvedValueOnce(blob)
    await persister.restoreClient()
    const qc = new QueryClient()
    qc.setQueryData(QUEUE_KEY, { rows: ['restored-row'] })
    createSessionRevalidator(qc)
    return qc
  }

  it("purges a restored cache another user's tab saved", async () => {
    const qc = await pageLoad(restoredBlob('user-anna'))

    qc.setQueryData(['auth', 'me'], kateryna)

    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
    expect(idbDel).toHaveBeenCalledWith(PERSIST_KEY)
  })

  it('purges a non-empty restored cache with no owner recorded', async () => {
    const qc = await pageLoad(restoredBlob(undefined))

    qc.setQueryData(['auth', 'me'], kateryna)

    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
  })

  it('keeps a restored cache the same user saved', async () => {
    const qc = await pageLoad(restoredBlob('user-kateryna'))

    qc.setQueryData(['auth', 'me'], kateryna)

    expect(qc.getQueryData(QUEUE_KEY)).toEqual({ rows: ['restored-row'] })
    expect(idbDel).not.toHaveBeenCalled()
  })

  it('purges nothing when nothing was restored', async () => {
    const qc = await pageLoad(undefined)

    qc.setQueryData(['auth', 'me'], kateryna)

    expect(qc.getQueryData(QUEUE_KEY)).toEqual({ rows: ['restored-row'] })
    expect(idbDel).not.toHaveBeenCalled()
  })

  it('compares only the first answer: the restored owner is not consulted again', async () => {
    const qc = await pageLoad(restoredBlob('user-anna'))
    qc.setQueryData(['auth', 'me'], kateryna)
    qc.setQueryData(QUEUE_KEY, { rows: ['kateryna-only-row'] })
    idbDel.mockClear()

    qc.setQueryData(['auth', 'me'], kateryna)

    expect(qc.getQueryData(QUEUE_KEY)).toEqual({ rows: ['kateryna-only-row'] })
    expect(idbDel).not.toHaveBeenCalled()
  })
})

describe('refetch after an account switch (backlog 433): the page being left never asks as the new user', () => {
  /** A mounted observer of the old account's queue (the page still on screen), counting its fetches. */
  function mountQueue(qc: QueryClient) {
    const queueFn = vi.fn(() => Promise.resolve({ rows: ['kateryna-row'] }))
    const observer = new QueryObserver(qc, {
      queryKey: QUEUE_KEY,
      queryFn: queueFn,
      staleTime: Infinity,
    })
    const unsubscribe = observer.subscribe(() => {})
    return { queueFn, unsubscribe }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('a switch found on a route change purges at once but refetches only once the navigation settles', async () => {
    const qc = seeded()
    const { queueFn } = mountQueue(qc)
    meReturns(kateryna)
    const revalidate = createSessionRevalidator(qc)

    await revalidate('/projects')
    await tick()

    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
    expect(queueFn).not.toHaveBeenCalled()
    revalidate.settled()
    await waitFor(() => expect(queueFn).toHaveBeenCalledTimes(1))
    expect(qc.getQueryData(QUEUE_KEY)).toEqual({ rows: ['kateryna-row'] })
  })

  it('a query unmounted by the navigation is purged and never refetched', async () => {
    const qc = seeded()
    const { queueFn, unsubscribe } = mountQueue(qc)
    meReturns(kateryna)
    const revalidate = createSessionRevalidator(qc)

    await revalidate('/projects')
    unsubscribe() // the router rendered /projects: the queue page is gone
    revalidate.settled()
    await tick()

    expect(queueFn).not.toHaveBeenCalled()
    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
  })

  it('a switch with no route change (an auth/me refetch) refetches the mounted queries at once', async () => {
    const qc = seeded()
    const { queueFn } = mountQueue(qc)
    createSessionRevalidator(qc)

    await qc.fetchQuery({ queryKey: ['auth', 'me'], queryFn: () => kateryna, staleTime: 0 })

    await waitFor(() => expect(queueFn).toHaveBeenCalledTimes(1))
  })

  it('settling with no switch behind it fetches nothing; a repeated settle does not refetch again', async () => {
    const qc = seeded()
    const { queueFn } = mountQueue(qc)
    meReturns(anna)
    const revalidate = createSessionRevalidator(qc)

    await revalidate('/projects')
    revalidate.settled()
    await tick()
    expect(queueFn).not.toHaveBeenCalled()

    meReturns(kateryna)
    await revalidate('/job-queue')
    revalidate.settled()
    revalidate.settled()
    await waitFor(() => expect(queueFn).toHaveBeenCalledTimes(1))
    await tick()
    expect(queueFn).toHaveBeenCalledTimes(1)
  })

  it('a superseded check that lands after the router went idle refetches at once (SR-L-2)', async () => {
    const qc = seeded()
    const { queueFn } = mountQueue(qc)
    let answerAsKateryna: (v: unknown) => void = () => {}
    apiGet
      .mockReturnValueOnce(new Promise((resolve) => (answerAsKateryna = resolve)))
      .mockRejectedValueOnce(new Error('timeout of 3000ms exceeded'))
    const revalidate = createSessionRevalidator(qc)
    const older = revalidate('/job-queue')
    await revalidate('/projects') // the newer check fails, its navigation renders
    revalidate.settled() // the router is idle: nothing was purged yet

    answerAsKateryna({ status: 200, data: kateryna })
    await older

    expect(qc.getQueryData(['auth', 'me'])).toEqual(kateryna)
    await waitFor(() => expect(queueFn).toHaveBeenCalledTimes(1))
  })

  it('a superseded check still lands its answer when the newer check fails', async () => {
    const qc = seeded()
    let answerAsKateryna: (v: unknown) => void = () => {}
    let failNewer: (e: unknown) => void = () => {}
    apiGet
      .mockReturnValueOnce(new Promise((resolve) => (answerAsKateryna = resolve)))
      .mockReturnValueOnce(new Promise((_, reject) => (failNewer = reject)))
    const revalidate = createSessionRevalidator(qc)
    const older = revalidate('/job-queue')
    const newer = revalidate('/projects')

    answerAsKateryna({ status: 200, data: kateryna })
    failNewer(new Error('timeout of 3000ms exceeded'))
    await Promise.all([older, newer])

    expect(qc.getQueryData(['auth', 'me'])).toEqual(kateryna)
    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
  })

  it("an older check never lands over AuthProvider's own answer that came after it was sent (SR-L-1)", async () => {
    const qc = seeded()
    let answerAsAnna: (v: unknown) => void = () => {}
    let failNewer: (e: unknown) => void = () => {}
    apiGet
      .mockReturnValueOnce(new Promise((resolve) => (answerAsAnna = resolve)))
      .mockReturnValueOnce(new Promise((_, reject) => (failNewer = reject)))
    const revalidate = createSessionRevalidator(qc)
    const older = revalidate('/job-queue') // sent before the cookie changed
    const newer = revalidate('/projects')

    // AuthProvider's own refetch answers under the new cookie and applies Kateryna
    await qc.fetchQuery({ queryKey: ['auth', 'me'], queryFn: () => kateryna, staleTime: 0 })
    qc.setQueryData(QUEUE_KEY, { rows: ['kateryna-only-row'] })
    failNewer(new Error('timeout of 3000ms exceeded'))
    answerAsAnna({ status: 200, data: anna })
    await Promise.all([older, newer])

    expect(qc.getQueryData(['auth', 'me'])).toEqual(kateryna)
    expect(qc.getQueryData(QUEUE_KEY)).toEqual({ rows: ['kateryna-only-row'] })
  })

  it('a superseded answer never overwrites the newer answer that landed', async () => {
    const qc = seeded()
    const ivan = { id: 'user-ivan', role: 'JUNIOR' }
    let answerOlder: (v: unknown) => void = () => {}
    let answerNewer: (v: unknown) => void = () => {}
    apiGet
      .mockReturnValueOnce(new Promise((resolve) => (answerOlder = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (answerNewer = resolve)))
    const revalidate = createSessionRevalidator(qc)
    const older = revalidate('/job-queue')
    const newer = revalidate('/projects')

    answerOlder({ status: 200, data: kateryna })
    answerNewer({ status: 200, data: ivan })
    await Promise.all([older, newer])

    expect(qc.getQueryData(['auth', 'me'])).toEqual(ivan)
  })

  it("a superseded check that drops its answer leaves AuthProvider's later auth/me request alone (SO-1)", async () => {
    const qc = seeded()
    const ivan = { id: 'user-ivan', role: 'JUNIOR' }
    let answerOlder: (v: unknown) => void = () => {}
    apiGet
      .mockReturnValueOnce(new Promise((resolve) => (answerOlder = resolve)))
      .mockResolvedValueOnce({ status: 200, data: kateryna })
    const revalidate = createSessionRevalidator(qc)
    const older = revalidate('/job-queue')
    await revalidate('/projects') // the newer check lands Kateryna

    // AuthProvider asks again after the newer answer landed; the stale check must not cancel it
    let answerFresh: (v: unknown) => void = () => {}
    const fresh = qc.fetchQuery({
      queryKey: ['auth', 'me'],
      queryFn: () => new Promise((resolve) => (answerFresh = resolve)),
      staleTime: 0,
    })
    answerOlder({ status: 200, data: anna })
    await older
    answerFresh(ivan)

    await expect(fresh).resolves.toEqual(ivan)
    expect(qc.getQueryData(['auth', 'me'])).toEqual(ivan)
  })

  it('a check whose cancel is still settling when a newer check lands drops its own answer (SO-1)', async () => {
    const qc = seeded()
    let releaseCancel: () => void = () => {}
    vi.spyOn(qc, 'cancelQueries').mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseCancel = resolve)),
    )
    apiGet
      .mockResolvedValueOnce({ status: 200, data: anna })
      .mockResolvedValueOnce({ status: 200, data: kateryna })
    const revalidate = createSessionRevalidator(qc)
    const older = revalidate('/job-queue')
    await vi.waitFor(() => expect(qc.cancelQueries).toHaveBeenCalledTimes(1)) // older is cancelling

    await revalidate('/projects') // asked later, lands Kateryna meanwhile
    releaseCancel()
    await older

    expect(qc.getQueryData(['auth', 'me'])).toEqual(kateryna)
  })

  it('a switch with no route change after a finished check still refetches at once (no navigation left pending)', async () => {
    const qc = seeded()
    const { queueFn } = mountQueue(qc)
    meReturns(anna)
    const revalidate = createSessionRevalidator(qc)
    await revalidate('/projects') // a check ran and finished; settled() is never called

    await qc.fetchQuery({ queryKey: ['auth', 'me'], queryFn: () => kateryna, staleTime: 0 })

    await waitFor(() => expect(queueFn).toHaveBeenCalledTimes(1))
  })

  it('settling refetches only the purged queries, never auth/me itself', async () => {
    const qc = seeded()
    const meFn = vi.fn(() => Promise.resolve(kateryna))
    new QueryObserver(qc, {
      queryKey: ['auth', 'me'],
      queryFn: meFn,
      staleTime: Infinity,
    }).subscribe(() => {})
    const { queueFn } = mountQueue(qc)
    meReturns(kateryna)
    const revalidate = createSessionRevalidator(qc)

    await revalidate('/projects')
    revalidate.settled()
    await waitFor(() => expect(queueFn).toHaveBeenCalledTimes(1))
    await tick()

    expect(meFn).not.toHaveBeenCalled()
  })

  it('settling does not refetch a purged query that got data with no page observing it (a loader prefetch)', async () => {
    const qc = seeded()
    const { queueFn, unsubscribe } = mountQueue(qc)
    meReturns(kateryna)
    const revalidate = createSessionRevalidator(qc)

    await revalidate('/projects')
    unsubscribe()
    await qc.prefetchQuery({ queryKey: QUEUE_KEY, queryFn: queueFn })
    revalidate.settled()
    await tick()

    expect(queueFn).toHaveBeenCalledTimes(1) // the prefetch only
  })

  it('settling does not cancel and re-ask a request already in flight for the new page', async () => {
    const qc = seeded()
    let answerSecond: (v: unknown) => void = () => {}
    const queueFn = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ rows: ['kateryna-row'] })
      .mockReturnValueOnce(new Promise((resolve) => (answerSecond = resolve)))
      .mockResolvedValue({ rows: ['asked-again'] })
    const observer = new QueryObserver(qc, {
      queryKey: QUEUE_KEY,
      queryFn: queueFn,
      staleTime: Infinity,
    })
    observer.subscribe(() => {})
    meReturns(kateryna)
    const revalidate = createSessionRevalidator(qc)

    await revalidate('/projects')
    await observer.refetch() // the new page already shows the new account's rows...
    const second = observer.refetch() // ...and asks for them again (focus, reconnect)
    revalidate.settled()
    answerSecond({ rows: ['kateryna-second'] })
    await second
    await tick()

    // cancelling the request in flight to ask again would be a third call
    expect(queueFn).toHaveBeenCalledTimes(2)
    expect(qc.getQueryData(QUEUE_KEY)).toEqual({ rows: ['kateryna-second'] })
  })

  /** Ids of every `auth/me` answer written to the cache, in order. */
  function landedAnswers(qc: QueryClient): string[] {
    const landed: string[] = []
    qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return
      if (event.query.queryKey[0] !== 'auth') return
      landed.push((event.query.state.data as { id: string }).id)
    })
    return landed
  }

  it('of three overlapping checks an older answer never lands before or after a newer one (CR-L-4)', async () => {
    const qc = seeded()
    const ivan = { id: 'user-ivan', role: 'JUNIOR' }
    let answerFirst: (v: unknown) => void = () => {}
    let answerSecond: (v: unknown) => void = () => {}
    let failThird: (e: unknown) => void = () => {}
    apiGet
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (answerSecond = resolve)))
      .mockReturnValueOnce(new Promise((_, reject) => (failThird = reject)))
    const revalidate = createSessionRevalidator(qc)
    const landed = landedAnswers(qc)
    let firstSettled = false
    const first = revalidate('/job-queue').then(() => (firstSettled = true))
    const second = revalidate('/projects')
    const third = revalidate('/teams')

    answerFirst({ status: 200, data: kateryna })
    failThird(new Error('timeout of 3000ms exceeded'))
    await tick()
    expect(qc.getQueryData(['auth', 'me'])).toEqual(anna) // the second check is still out
    expect(firstSettled).toBe(false)

    answerSecond({ status: 200, data: ivan })
    await Promise.all([first, second, third])
    expect(landed).toEqual(['user-ivan'])
  })

  it('an overtaken check also waits for a check asked while it was already waiting', async () => {
    const qc = seeded()
    const ivan = { id: 'user-ivan', role: 'JUNIOR' }
    let answerFirst: (v: unknown) => void = () => {}
    let failSecond: (e: unknown) => void = () => {}
    let answerThird: (v: unknown) => void = () => {}
    apiGet
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockReturnValueOnce(new Promise((_, reject) => (failSecond = reject)))
      .mockReturnValueOnce(new Promise((resolve) => (answerThird = resolve)))
    const revalidate = createSessionRevalidator(qc)
    const landed = landedAnswers(qc)
    const first = revalidate('/job-queue')
    const second = revalidate('/projects')

    answerFirst({ status: 200, data: kateryna })
    await tick() // the first check now waits for the second
    const third = revalidate('/teams')
    failSecond(new Error('timeout of 3000ms exceeded'))
    await tick()
    expect(landed).toEqual([])

    answerThird({ status: 200, data: ivan })
    await Promise.all([first, second, third])
    expect(landed).toEqual(['user-ivan'])
  })

  it('an older answer arriving after every newer check finished never lands over the newer one', async () => {
    const qc = seeded()
    const ivan = { id: 'user-ivan', role: 'JUNIOR' }
    let answerFirst: (v: unknown) => void = () => {}
    apiGet
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({ status: 200, data: ivan })
    const revalidate = createSessionRevalidator(qc)
    const landed = landedAnswers(qc)
    const first = revalidate('/job-queue')
    await revalidate('/projects') // the newer check lands and leaves before the older one answers
    expect(landed).toEqual(['user-ivan'])

    answerFirst({ status: 200, data: kateryna })
    await first
    expect(landed).toEqual(['user-ivan'])
    expect(qc.getQueryData(['auth', 'me'])).toEqual(ivan)
  })
})
