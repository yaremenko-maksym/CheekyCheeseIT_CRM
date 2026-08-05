/**
 * useUploadProgressState — the phase state machine behind <UploadProgress>
 * (`@/components/ui/upload-progress`). Owns the fix for the freeze measured
 * in task-upload-freeze-and-progress.md (PR body has the before/after
 * numbers): axios's `onUploadProgress` fires once per raw XHR progress
 * EVENT — on a slow connection that can be dozens of times over a single
 * upload — and each call is its own browser macrotask, so React does NOT
 * automatically batch a `setState` made inside it with anything else.
 * Left unthrottled, every tick is a separate commit; no single one is ever
 * long enough to show up as a Long Task (>50ms), but the sheer FREQUENCY
 * saturates the main thread's task queue and delays real input handling —
 * measured as click round-trip latency climbing from ~7ms to 200ms+ over
 * the course of one upload, with zero Long Task entries to explain it.
 *
 * `onProgress` below coalesces ticks with `requestAnimationFrame`: whatever
 * the latest reported percent is when the next frame comes due is what
 * gets committed — intermediate ticks are still real (nothing is dropped
 * from the underlying transfer), they just don't each force their own
 * render. That caps re-renders at the display's refresh rate (~60/s)
 * regardless of how many raw progress events arrive per second.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UploadProgressState } from '@/components/ui/upload-progress'

const IDLE_STATE: UploadProgressState = { phase: 'idle' }

export interface UseUploadProgressState {
  state: UploadProgressState
  /** Client-side work before any bytes are sent (crop/read/validate). */
  prepare: () => void
  /** Feed straight into `useUploadDocument`'s `onProgress` (or equivalent). */
  onProgress: (percent: number) => void
  success: () => void
  error: (message: string) => void
  reset: () => void
}

export function useUploadProgressState(): UseUploadProgressState {
  const [state, setState] = useState<UploadProgressState>(IDLE_STATE)
  const pendingPercent = useRef<number | null>(null)
  const frameHandle = useRef<number | null>(null)

  const cancelPendingFrame = useCallback(() => {
    if (frameHandle.current !== null) {
      cancelAnimationFrame(frameHandle.current)
      frameHandle.current = null
    }
    pendingPercent.current = null
  }, [])

  // Unmount safety — an in-flight rAF callback firing after unmount would
  // otherwise call setState on a gone component.
  useEffect(() => cancelPendingFrame, [cancelPendingFrame])

  const prepare = useCallback(() => {
    cancelPendingFrame()
    setState({ phase: 'preparing' })
  }, [cancelPendingFrame])

  const onProgress = useCallback((percent: number) => {
    // 100% sent is "processing" (server hasn't confirmed yet), not one more
    // 'uploading' tick — flush immediately, no need to wait a frame for the
    // last, most-important state change of the transfer.
    if (percent >= 100) {
      pendingPercent.current = null
      if (frameHandle.current !== null) {
        cancelAnimationFrame(frameHandle.current)
        frameHandle.current = null
      }
      setState({ phase: 'processing' })
      return
    }
    pendingPercent.current = percent
    if (frameHandle.current !== null) return
    frameHandle.current = requestAnimationFrame(() => {
      frameHandle.current = null
      if (pendingPercent.current !== null) {
        setState({ phase: 'uploading', percent: pendingPercent.current })
      }
    })
  }, [])

  const success = useCallback(() => {
    cancelPendingFrame()
    setState({ phase: 'success' })
  }, [cancelPendingFrame])

  const error = useCallback(
    (message: string) => {
      cancelPendingFrame()
      setState({ phase: 'error', error: message })
    },
    [cancelPendingFrame],
  )

  const reset = useCallback(() => {
    cancelPendingFrame()
    setState(IDLE_STATE)
  }, [cancelPendingFrame])

  return { state, prepare, onProgress, success, error, reset }
}
