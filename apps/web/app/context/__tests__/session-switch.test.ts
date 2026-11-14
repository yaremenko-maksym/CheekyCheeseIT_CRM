/**
 * Task 7.6c — the session cookie can change under an open page (a sign-in in another tab). The
 * `_authenticated` route revalidates the cached `auth/me` user on each pathname change; when the user
 * id differs, every other query and the persisted copy are purged BEFORE the next route renders, so
 * the new account never paints the previous account's cached rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

const { apiGet, idbDel } = vi.hoisted(() => ({ apiGet: vi.fn(), idbDel: vi.fn() }))
vi.mock('../../lib/axios', () => ({ api: { get: apiGet } }))
vi.mock('idb-keyval', () => ({ del: idbDel }))

import { createSessionRevalidator } from '../auth'
import { PERSIST_KEY } from '../../lib/persister'

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

  it('purges when the session is gone (401)', async () => {
    const qc = seeded()
    apiGet.mockResolvedValue({ status: 401, data: {} })

    await createSessionRevalidator(qc)('/job-queue')

    expect(qc.getQueryData(QUEUE_KEY)).toBeUndefined()
    expect(idbDel).toHaveBeenCalledWith(PERSIST_KEY)
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

  it('asks once per pathname: a repeat of the same path (search change) sends no request', async () => {
    const qc = seeded()
    meReturns(anna)
    const revalidate = createSessionRevalidator(qc)

    await revalidate('/job-queue')
    await revalidate('/job-queue')
    await revalidate('/projects')

    expect(apiGet).toHaveBeenCalledTimes(2)
  })
})
