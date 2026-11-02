import { useEffect, useRef } from 'react'
import { AlertCircle } from 'lucide-react'
import { useReducedMotion } from 'framer-motion'

export const SUBMIT_ERROR_ID = 'admin-edit-submit-error'

/**
 * Failed-save banner. It sits at the bottom of the scrolling dialog body, so it
 * announces itself (`role="alert"`) and scrolls itself into view — otherwise a
 * Save press on a short viewport appears to do nothing (QA-MED-1).
 * `scroll={false}` leaves the view alone when focus is being moved elsewhere.
 */
export function SubmitErrorBanner({
  message,
  scroll = true,
}: {
  message: string
  scroll?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  useEffect(() => {
    if (scroll)
      // Stryker disable next-line OptionalChaining: equivalent — the banner div is always rendered, so ref.current is never null when the effect runs
      ref.current?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
  }, [message, scroll, reduceMotion])
  return (
    <div
      ref={ref}
      id={SUBMIT_ERROR_ID}
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {message}
    </div>
  )
}
