import { forwardRef } from 'react'

/**
 * Full-viewport "yellow caret" page-transition sweep (docs/design/landing-
 * redesign.md §M.3) — a solid `bg-primary` bar `__root.tsx`'s orchestrator
 * drives imperatively via framer-motion's standalone `animate()` DOM API on
 * the ref below, never via `whileInView`/`variants` (this is router-event-
 * driven, not scroll- or hover-driven). Always `pointer-events-none` so it
 * NEVER blocks a click, even mid-sweep — starts translated fully off-screen
 * to the left.
 */
export const PageTransitionOverlay = forwardRef<HTMLDivElement>(
  function PageTransitionOverlay(_props, ref) {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-[999] bg-primary"
        style={{ transform: 'translateX(-100%)', willChange: 'transform' }}
      />
    )
  },
)
