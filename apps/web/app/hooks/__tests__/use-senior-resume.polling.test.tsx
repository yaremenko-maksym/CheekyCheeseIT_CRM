/**
 * useSeniorResume polling (verified base resume design §5.3): the query
 * re-fetches while `verificationBusy` is true — including a template run on a
 * VERIFIED resume — and stops the moment it clears.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))
vi.mock('@/lib/axios', () => ({ api: { get: getMock } }))

import { useSeniorResume } from '../use-senior-resume'

/** Only the fields the polling rule reads; the hook does not parse the body. */
const verified = (busy: boolean) => ({
  data: {
    resume: {
      status: 'READY',
      renderStatus: 'READY',
      verificationStatus: 'VERIFIED',
      verificationBusy: busy,
    },
    canEdit: true,
    canConfirm: true,
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useSeniorResume polling', () => {
  it('polls while verificationBusy on a VERIFIED resume and stops when it clears', async () => {
    getMock
      .mockResolvedValueOnce(verified(true))
      .mockResolvedValueOnce(verified(true))
      .mockResolvedValue(verified(false))
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useSeniorResume('senior-1'), { wrapper })

    await waitFor(() => expect(result.current.data?.resume?.verificationBusy).toBe(true))
    expect(getMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2600)
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(2600)
    await waitFor(() => expect(result.current.data?.resume?.verificationBusy).toBe(false))
    expect(getMock).toHaveBeenCalledTimes(3)

    // Busy cleared: no further fetch, however long the tab stays open.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getMock).toHaveBeenCalledTimes(3)
  })
})
