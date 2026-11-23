/**
 * QA-LOW-4: with the feature flag off the batch GET answers 404 on every card open. That is the
 * inert answer, not a failure: the real `api` (its error interceptor logs every rejected request)
 * must not log it. Any other refusal of the same request is still logged.
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
  (status: number): AxiosAdapter =>
  (config) =>
    new Promise((resolve, reject) =>
      settle(resolve, reject, {
        data: { statusCode: status, message: 'x' },
        status,
        statusText: '',
        headers: {},
        config,
        request: {},
      } as AxiosResponse),
    )

function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient())
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
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
    await waitFor(() => expect(calls).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.size).toBe(0))
    expect(error).not.toHaveBeenCalled()
  })

  it.each([403, 500])('a %i is still a refusal and is logged', async (status) => {
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
