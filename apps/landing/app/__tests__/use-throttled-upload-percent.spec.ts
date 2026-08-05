/**
 * use-throttled-upload-percent.ts — unit tests (task-upload-freeze-and-progress.md).
 *
 * Mirrors apps/web's use-upload-progress-state.test.ts pin for the same
 * root-cause fix: a burst of synchronous `report()` calls (what XHR's
 * `upload.onprogress` produces on a slow connection) must coalesce into a
 * single commit carrying the latest value, not one commit per call.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useThrottledUploadPercent } from '../lib/use-throttled-upload-percent'

describe('useThrottledUploadPercent', () => {
  it('starts at null (no upload in flight)', () => {
    const { result } = renderHook(() => useThrottledUploadPercent())
    expect(result.current.percent).toBeNull()
  })

  it('coalesces a burst of report() calls into one commit with the latest value', async () => {
    const { result } = renderHook(() => useThrottledUploadPercent())
    act(() => {
      result.current.report(12)
      result.current.report(38)
      result.current.report(55)
    })
    await waitFor(() => {
      expect(result.current.percent).toBe(55)
    })
  })

  it('reset() clears the value and cancels a pending frame', async () => {
    const { result } = renderHook(() => useThrottledUploadPercent())
    act(() => {
      result.current.report(20)
      result.current.reset()
    })
    expect(result.current.percent).toBeNull()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(result.current.percent).toBeNull()
  })
})
