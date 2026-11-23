/**
 * QA-LOW-4: with the feature flag off the batch GET answers 404 on every card open. That is the
 * inert answer, not a failure: the real `api` (its error interceptor logs every rejected request)
 * must not log it, and the query ends answered (success), not failed. A 200 still answers its rows
 * and any other status (3xx, 4xx, 5xx) is still a logged refusal.
 */
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import settle from 'axios/unsafe/core/settle.js'
import type { AxiosAdapter, AxiosResponse } from 'axios'
import { api } from '@/lib/axios'
import { useTailoredRows } from '../useTailoredResumes'

const OPP = 'dddddddd-0000-4000-8000-000000000001'
const S1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const HR = { actorId: 'actor', role: 'HR' as const, teamId: null }

/** The real `settle()`, so `validateStatus` decides resolve or reject as it does on the network. */
const answer =
  (status: number, data: unknown = { statusCode: status, message: 'x' }): AxiosAdapter =>
  (config) =>
    new Promise((resolve, reject) =>
      settle(resolve, reject, {
        data,
        status,
        statusText: '',
        headers: {},
        config,
        request: {},
      } as AxiosResponse),
    )

let client: QueryClient
function Wrapper({ children }: { children: ReactNode }) {
  const [own] = useState(() => (client = new QueryClient()))
  return <QueryClientProvider client={own}>{children}</QueryClientProvider>
}
/** The batch query's own outcome: the 404 is an answer (success), not a failure. */
const batchStatus = () => client.getQueryCache().getAll()[0]?.state.status

const ROW = {
  seniorId: S1,
  eligibility: 'READY',
  runStatus: null,
  runStage: null,
  runErrorCode: null,
  published: false,
  pdfStatus: 'IDLE',
  pdfRenderId: null,
  baseChanged: false,
}

const adapter = api.defaults.adapter!
afterEach(() => {
  api.defaults.adapter = adapter
  vi.restoreAllMocks()
})

describe('useTailoredRows: the inert batch 404', () => {
  it('a 404 answers no rows and logs nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls = vi.fn(answer(404))
    api.defaults.adapter = calls
    const { result } = renderHook(() => useTailoredRows(HR, OPP, [S1]), { wrapper: Wrapper })
    await waitFor(() => expect(batchStatus()).toBe('success'))
    expect(calls).toHaveBeenCalledTimes(1)
    expect(result.current.size).toBe(0)
    expect(error).not.toHaveBeenCalled()
  })

  it('a 200 answers its rows through the same request', async () => {
    api.defaults.adapter = answer(200, [ROW])
    const { result } = renderHook(() => useTailoredRows(HR, OPP, [S1]), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.get(S1)?.eligibility).toBe('READY'))
  })

  it.each([300, 403, 500])('a %i is still a refusal and is logged', async (status) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.defaults.adapter = answer(status)
    renderHook(() => useTailoredRows(HR, OPP, [S1]), { wrapper: Wrapper })
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        '[api]',
        'GET',
        `/job-queue/${OPP}/tailored`,
        '→',
        status,
        '—',
        expect.any(String),
      ),
    )
  })
})
