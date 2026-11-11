/**
 * Task 7.5 — `useSetJobSourceEnabled`: the PATCH for the ADMIN source switch.
 * AC1: the request carries exactly `{ enabled }` and, on success, refetches the source list and the
 * health list; a refused change refetches nothing (nothing changed on the server).
 */
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/axios', () => ({ api: { patch: vi.fn() } }))

import { api } from '@/lib/axios'
import { jobSourceHealthQueryKey } from '../use-job-source-admin'
import { jobSourcesQueryKey, useSetJobSourceEnabled } from '../use-job-sourcing'

const ID = '55555555-5555-4555-8555-555555555555'

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { ...renderHook(() => useSetJobSourceEnabled(), { wrapper }), invalidate }
}

describe('useSetJobSourceEnabled', () => {
  beforeEach(() => {
    vi.mocked(api.patch).mockReset()
  })

  it('PATCHes the source with exactly the requested value and returns the parsed answer', async () => {
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: ID, enabled: false, changed: true, cancelledRuns: 2 },
    })
    const { result } = setup()

    let answer: unknown
    await act(async () => {
      answer = await result.current.mutateAsync({ id: ID, enabled: false })
    })

    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(api.patch).toHaveBeenCalledWith(`/job-sourcing/sources/${ID}`, { enabled: false })
    expect(answer).toEqual({ id: ID, enabled: false, changed: true, cancelledRuns: 2 })
  })

  it('refetches the source list and the health list after a success — and nothing else', async () => {
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: ID, enabled: true, changed: true, cancelledRuns: 0 },
    })
    const { result, invalidate } = setup()

    await act(async () => {
      await result.current.mutateAsync({ id: ID, enabled: true })
    })

    expect(invalidate).toHaveBeenCalledTimes(2)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: jobSourcesQueryKey })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: jobSourceHealthQueryKey })
  })

  it('stays pending until BOTH refetches finish, so the switch never flickers back', async () => {
    vi.mocked(api.patch).mockResolvedValue({
      data: { id: ID, enabled: true, changed: true, cancelledRuns: 0 },
    })
    const { result, invalidate } = setup()
    const release: Array<() => void> = []
    invalidate.mockImplementation(
      () => new Promise<void>((resolve) => release.push(resolve)) as never,
    )

    act(() => {
      result.current.mutate({ id: ID, enabled: true })
    })
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2))
    expect(result.current.isPending).toBe(true)

    await act(async () => {
      release[1]?.()
    })
    expect(result.current.isPending).toBe(true)

    await act(async () => {
      release[0]?.()
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('refetches nothing when the server refuses the change', async () => {
    vi.mocked(api.patch).mockRejectedValue(new Error('409'))
    const { result, invalidate } = setup()

    await act(async () => {
      result.current.mutate({ id: ID, enabled: true })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('refuses a malformed answer instead of treating it as success', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: { id: 'not-a-uuid' } })
    const { result } = setup()

    await act(async () => {
      result.current.mutate({ id: ID, enabled: true })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
