/**
 * use-notification-preferences.test.tsx — task-notification-settings-ui
 * (position 7b), AC4.
 *
 * Covers the optimistic update / rollback / toast contract (design spec
 * §6.2) directly on the hooks, independent of the rendered tab component.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  NOTIFICATION_PREFERENCES_QUERY_KEY,
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from '../use-notification-preferences'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { api } from '@/lib/axios'
import { toast } from 'sonner'

const mockGet = api.get as ReturnType<typeof vi.fn>
const mockPut = api.put as ReturnType<typeof vi.fn>

const RESPONSE = {
  items: [
    { type: 'TRANSACTION_ADDED', emailEnabled: true, locked: false },
    { type: 'PROJECT_CONFIRM_REQUIRED', emailEnabled: true, locked: true },
  ],
}

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useNotificationPreferences', () => {
  it('fetches GET /notifications/preferences', async () => {
    mockGet.mockResolvedValueOnce({ data: RESPONSE })
    const qc = new QueryClient()
    const { result } = renderHook(() => useNotificationPreferences(), { wrapper: wrapper(qc) })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockGet).toHaveBeenCalledWith('/notifications/preferences')
    expect(result.current.data).toEqual(RESPONSE)
  })
})

describe('useUpdateNotificationPreference', () => {
  it('optimistically flips the switch in cache immediately (before the PUT resolves)', async () => {
    mockGet.mockResolvedValueOnce({ data: RESPONSE })
    let resolvePut!: () => void
    mockPut.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePut = () => resolve()
      }),
    )
    const qc = new QueryClient()
    const { result: queryResult } = renderHook(() => useNotificationPreferences(), {
      wrapper: wrapper(qc),
    })
    await waitFor(() => expect(queryResult.current.isSuccess).toBe(true))

    const { result: mutationResult } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: wrapper(qc),
    })

    act(() => {
      mutationResult.current.mutate({ type: 'TRANSACTION_ADDED', emailEnabled: false })
    })

    // Optimistic write lands before the PUT promise resolves.
    await waitFor(() => {
      const cached = qc.getQueryData<typeof RESPONSE>(NOTIFICATION_PREFERENCES_QUERY_KEY)
      expect(cached?.items.find((i) => i.type === 'TRANSACTION_ADDED')?.emailEnabled).toBe(false)
    })

    // The OTHER cached item must stay byte-for-byte untouched — pins the
    // per-item `item.type === type ? ... : item` predicate against a mutant
    // that updates every row unconditionally.
    const cachedMid = qc.getQueryData<typeof RESPONSE>(NOTIFICATION_PREFERENCES_QUERY_KEY)
    expect(cachedMid?.items.find((i) => i.type === 'PROJECT_CONFIRM_REQUIRED')).toEqual(
      RESPONSE.items[1],
    )

    expect(mockPut).toHaveBeenCalledWith('/notifications/preferences', {
      items: [{ type: 'TRANSACTION_ADDED', emailEnabled: false }],
    })

    resolvePut()
    await waitFor(() => expect(mutationResult.current.isSuccess).toBe(true))
    expect(toast.success).toHaveBeenCalledWith('Сохранено')
  })

  it('cancels the in-flight preferences query on mutate, and re-invalidates on settle', async () => {
    mockGet.mockResolvedValueOnce({ data: RESPONSE })
    mockPut.mockResolvedValueOnce(undefined)
    const qc = new QueryClient()
    const cancelSpy = vi.spyOn(qc, 'cancelQueries')
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const { result: queryResult } = renderHook(() => useNotificationPreferences(), {
      wrapper: wrapper(qc),
    })
    await waitFor(() => expect(queryResult.current.isSuccess).toBe(true))
    cancelSpy.mockClear()
    invalidateSpy.mockClear()

    const { result: mutationResult } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: wrapper(qc),
    })
    act(() => {
      mutationResult.current.mutate({ type: 'TRANSACTION_ADDED', emailEnabled: false })
    })

    await waitFor(() => expect(mutationResult.current.isSuccess).toBe(true))

    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY })
  })

  it('mutating with no prior GET (empty cache) does not crash and writes no snapshot', async () => {
    // No useNotificationPreferences render here — the cache starts genuinely
    // empty, pinning the `if (previous)` guard: a mutant forcing that branch
    // to always run would call `setQueryData` with `previous.items` on
    // `undefined` and throw.
    mockPut.mockResolvedValueOnce(undefined)
    const qc = new QueryClient()
    const { result: mutationResult } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: wrapper(qc),
    })

    act(() => {
      mutationResult.current.mutate({ type: 'TRANSACTION_ADDED', emailEnabled: false })
    })

    await waitFor(() => expect(mutationResult.current.isSuccess).toBe(true))
    expect(qc.getQueryData(NOTIFICATION_PREFERENCES_QUERY_KEY)).toBeUndefined()
  })

  it('rolls back the cache and shows the server message on error', async () => {
    mockGet.mockResolvedValueOnce({ data: RESPONSE })
    mockPut.mockRejectedValueOnce(new Error('Слишком много настроек в одном запросе'))
    const qc = new QueryClient()
    const { result: queryResult } = renderHook(() => useNotificationPreferences(), {
      wrapper: wrapper(qc),
    })
    await waitFor(() => expect(queryResult.current.isSuccess).toBe(true))

    const { result: mutationResult } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: wrapper(qc),
    })

    act(() => {
      mutationResult.current.mutate({ type: 'TRANSACTION_ADDED', emailEnabled: false })
    })

    await waitFor(() => expect(mutationResult.current.isError).toBe(true))

    const cached = qc.getQueryData<typeof RESPONSE>(NOTIFICATION_PREFERENCES_QUERY_KEY)
    expect(cached?.items.find((i) => i.type === 'TRANSACTION_ADDED')?.emailEnabled).toBe(true)
    expect(toast.error).toHaveBeenCalledWith(
      'Не удалось сохранить настройку: Слишком много настроек в одном запросе',
    )
  })

  it('erroring with no prior snapshot never calls setQueryData at all', async () => {
    // Pins `if (context?.previous)` directly via a spy — NOT via the
    // resulting cache state, because `QueryClient.setQueryData(key,
    // undefined)` is a documented no-op (TanStack Query skips writing when
    // the new value is `undefined`), so `if (true)` and `if (context?.
    // previous)` produce the IDENTICAL observable cache state here even
    // though only one of them actually calls `setQueryData`. The spy sees
    // the call that the cache state cannot.
    mockPut.mockRejectedValueOnce(new Error('boom'))
    const qc = new QueryClient()
    const setDataSpy = vi.spyOn(qc, 'setQueryData')
    const { result: mutationResult } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: wrapper(qc),
    })

    act(() => {
      mutationResult.current.mutate({ type: 'TRANSACTION_ADDED', emailEnabled: false })
    })

    await waitFor(() => expect(mutationResult.current.isError).toBe(true))
    expect(setDataSpy).not.toHaveBeenCalled()
  })

  it('never throws in onError when onMutate itself rejected (context is undefined, not just context.previous)', async () => {
    // `context?.previous` guards against TWO distinct falsy shapes: (1)
    // `context` is a real object with `previous: undefined` (covered above),
    // and (2) `context` itself is `undefined` — which only happens if
    // `onMutate` rejects before returning. Removing the `?.` (leaving plain
    // `context.previous`) is safe for shape (1) but throws a TypeError for
    // shape (2) — forcing `cancelQueries` (the first call inside `onMutate`)
    // to reject reaches exactly that shape.
    const qc = new QueryClient()
    vi.spyOn(qc, 'cancelQueries').mockRejectedValueOnce(new Error('cancel failed'))
    const { result: mutationResult } = renderHook(() => useUpdateNotificationPreference(), {
      wrapper: wrapper(qc),
    })

    act(() => {
      mutationResult.current.mutate({ type: 'TRANSACTION_ADDED', emailEnabled: false })
    })

    await waitFor(() => expect(mutationResult.current.isError).toBe(true))
    // Reaching this line at all (no uncaught TypeError) is the assertion —
    // the PUT mock was never even configured for this test, so the error
    // toast necessarily carries the onMutate-stage failure.
    expect(toast.error).toHaveBeenCalledWith('Не удалось сохранить настройку: cancel failed')
  })
})
