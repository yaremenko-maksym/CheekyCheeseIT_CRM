/**
 * use-upload-progress-state.ts — unit tests (task-upload-freeze-and-progress.md).
 *
 * Pins:
 * 1. Starts idle.
 * 2. prepare() -> 'preparing'.
 * 3. Multiple synchronous onProgress(<100) calls coalesce into ONE commit
 *    carrying the LATEST value — this is the actual fix for the measured
 *    root cause (see PR body): an unthrottled callback would instead cause
 *    one commit per call.
 * 4. onProgress(100) transitions straight to 'processing' (not 'uploading'
 *    at 100%) without waiting a frame.
 * 5. success() -> 'success'; error(msg) -> 'error' with the message.
 * 6. reset() -> back to idle and cancels any pending frame (no stray commit
 *    lands after reset).
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useUploadProgressState } from '../use-upload-progress-state'

describe('useUploadProgressState', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useUploadProgressState())
    expect(result.current.state).toEqual({ phase: 'idle' })
  })

  it('prepare() sets phase to preparing', () => {
    const { result } = renderHook(() => useUploadProgressState())
    act(() => result.current.prepare())
    expect(result.current.state).toEqual({ phase: 'preparing' })
  })

  it('coalesces bursty onProgress ticks into a single commit with the latest value', async () => {
    const { result } = renderHook(() => useUploadProgressState())
    act(() => {
      // Simulate what an unthrottled axios onUploadProgress would do: many
      // synchronous calls before the browser gets a chance to paint.
      result.current.onProgress(10)
      result.current.onProgress(23)
      result.current.onProgress(47)
      result.current.onProgress(61)
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'uploading', percent: 61 })
    })
  })

  it('onProgress(100) flips straight to processing, not uploading at 100%', async () => {
    const { result } = renderHook(() => useUploadProgressState())
    act(() => {
      result.current.onProgress(50)
    })
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'uploading', percent: 50 })
    })
    act(() => {
      result.current.onProgress(100)
    })
    // No rAF wait needed — the 100% branch commits synchronously.
    expect(result.current.state).toEqual({ phase: 'processing' })
  })

  it('success() sets phase to success', () => {
    const { result } = renderHook(() => useUploadProgressState())
    act(() => {
      result.current.onProgress(100)
      result.current.success()
    })
    expect(result.current.state).toEqual({ phase: 'success' })
  })

  it('error(message) sets phase to error with the message', () => {
    const { result } = renderHook(() => useUploadProgressState())
    act(() => result.current.error('Не удалось загрузить файл'))
    expect(result.current.state).toEqual({ phase: 'error', error: 'Не удалось загрузить файл' })
  })

  it('reset() returns to idle and cancels a pending frame (no stray commit after reset)', async () => {
    const { result } = renderHook(() => useUploadProgressState())
    act(() => {
      result.current.onProgress(30) // schedules a rAF-deferred commit
      result.current.reset()
    })
    expect(result.current.state).toEqual({ phase: 'idle' })
    // Give any (incorrectly) still-pending frame a chance to fire — state
    // must stay idle, not jump to `{ phase: 'uploading', percent: 30 }`.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(result.current.state).toEqual({ phase: 'idle' })
  })
})
