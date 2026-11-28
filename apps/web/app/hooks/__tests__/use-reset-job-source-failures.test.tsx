/**
 * `useResetJobSourceFailures` — the ADMIN "Reset failures" write. AC2: the request carries exactly
 * `{ reason }` to the source's reset path; a blank reason never leaves the browser; on success the
 * health list and the source's detail are refetched, on failure nothing is refetched.
 */
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/axios', () => ({ api: { post: vi.fn() } }))

import { api } from '@/lib/axios'
import {
  jobSourceDetailQueryKey,
  jobSourceHealthQueryKey,
  useResetJobSourceFailures,
} from '../use-job-source-admin'

const ID = '55555555-5555-4555-8555-555555555555'

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { ...renderHook(() => useResetJobSourceFailures(ID), { wrapper }), invalidate }
}

describe('useResetJobSourceFailures', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset()
  })

  it('POSTs exactly { reason } to the source reset path', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: undefined })
    const { result } = setup()

    await act(async () => {
      await result.current.mutateAsync('provider fixed its side')
    })

    expect(api.post).toHaveBeenCalledWith(`/job-sourcing/admin/sources/${ID}/reset-failures`, {
      reason: 'provider fixed its side',
    })
  })

  it('refuses a blank reason before any request is sent', async () => {
    const { result } = setup()

    await act(async () => {
      await expect(result.current.mutateAsync('   ')).rejects.toThrow()
    })

    expect(api.post).not.toHaveBeenCalled()
  })

  it('refetches the health list and this source detail after a successful reset', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: undefined })
    const { result, invalidate } = setup()

    await act(async () => {
      await result.current.mutateAsync('provider fixed its side')
    })

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: jobSourceHealthQueryKey })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: jobSourceDetailQueryKey(ID) })
  })

  it('refetches nothing when the server refuses the reset', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('refused'))
    const { result, invalidate } = setup()

    await act(async () => {
      await expect(result.current.mutateAsync('provider fixed its side')).rejects.toThrow()
    })

    expect(invalidate).not.toHaveBeenCalled()
  })
})
