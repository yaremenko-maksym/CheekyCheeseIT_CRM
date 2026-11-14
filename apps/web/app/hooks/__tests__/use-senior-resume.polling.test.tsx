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

import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, EMPTY_RESUME_FACTS } from '@crm/shared'
import { useSeniorResume } from '../use-senior-resume'

/** A whole envelope: the hook parses every body with `seniorResumeResponseSchema`. */
const verified = (busy: boolean) => ({
  data: {
    resume: {
      id: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      content: EMPTY_RESUME_CONTENT,
      status: 'READY',
      errorCode: null,
      errorMessage: null,
      quotaResetsAt: null,
      sourceFileName: null,
      sourceFileSizeBytes: null,
      hasSourceFile: false,
      version: 2,
      updatedByUserId: null,
      updatedByName: null,
      createdAt: '2026-11-10T10:00:00.000Z',
      updatedAt: '2026-11-10T10:00:00.000Z',
      layout: DEFAULT_RESUME_LAYOUT,
      templateName: 'classic',
      hasCustomTemplate: false,
      renderStatus: 'READY',
      renderError: null,
      pdfUpToDate: true,
      facts: EMPTY_RESUME_FACTS,
      verificationStatus: 'VERIFIED',
      verificationErrorCode: null,
      verificationReport: null,
      verifiedVersion: 2,
      verifiedAt: '2026-11-10T10:00:00.000Z',
      verifiedByName: null,
      staged: null,
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

  it('a malformed body is an error, never data (FR-W-3)', async () => {
    getMock.mockResolvedValue({ data: { resume: { status: 'READY' }, canEdit: true } })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useSeniorResume('senior-1'), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })
})
