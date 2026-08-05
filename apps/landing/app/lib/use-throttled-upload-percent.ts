import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Coalesces a high-frequency upload-progress callback into at most one
 * React commit per animation frame (task-upload-freeze-and-progress.md).
 *
 * `XMLHttpRequest.upload.onprogress` (which `submitApplication` in
 * `lib/api.ts` now uses so it can report real percent — the Fetch API has
 * no equivalent) fires once per network chunk, each its own browser
 * macrotask that React does NOT auto-batch with anything else. On a slow
 * connection that can be dozens of separate `setState` calls over one CV
 * upload; no single one is ever long enough to register as a >50ms Long
 * Task, but the sheer frequency saturates the main thread's task queue and
 * degrades input responsiveness for the rest of the page — this is the
 * exact failure mode measured in that task's PR body (before/after
 * numbers there). Duplicated from `apps/web`'s `useUploadProgressState`
 * rather than shared: apps/web and apps/landing are separate Vite apps
 * with no shared UI package (`packages/shared` is schemas/types only, not
 * React hooks/components), and this landing form doesn't need the fuller
 * preparing/processing/success/error state machine the CRM component
 * covers — `vacancy-apply-form.tsx` already has its own `status` machine
 * (idle/submitting/success/error) and only needed the missing "how far
 * along is the upload" piece.
 */
export function useThrottledUploadPercent(): {
  percent: number | null
  report: (percent: number) => void
  reset: () => void
} {
  const [percent, setPercent] = useState<number | null>(null)
  const pending = useRef<number | null>(null)
  const frame = useRef<number | null>(null)

  const cancelPending = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    pending.current = null
  }, [])

  useEffect(() => cancelPending, [cancelPending])

  const report = useCallback((next: number) => {
    pending.current = next
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      if (pending.current !== null) setPercent(pending.current)
    })
  }, [])

  const reset = useCallback(() => {
    cancelPending()
    setPercent(null)
  }, [cancelPending])

  return { percent, report, reset }
}
