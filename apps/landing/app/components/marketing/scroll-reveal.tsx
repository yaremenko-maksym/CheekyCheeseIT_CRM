import { useRef, type ReactNode } from 'react'
import { m, useInView, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { useCoarsePointer } from '@/lib/use-coarse-pointer'
import { cn } from '@/lib/utils'

/**
 * Progress-linked scroll-reveal (docs/design/landing-redesign.md §M.1.0) —
 * upgrade of the old one-shot `whileInView` `Reveal` (§5.1). Opacity/y are
 * `useTransform` motion values bound directly to the section's OWN scroll
 * progress (`useScroll({ target: ref })`), not a discrete IntersectionObserver
 * trigger — scrolling back up smoothly un-reveals the section (no `once`,
 * intentional: the owner explicitly asked for "animation depending on the
 * CURRENT scroll position", not "play once and forget"). Desktop only —
 * see the touch/coarse-pointer branch below (§M v3.3).
 *
 * `revealAt` replaces the old `delay` prop for staggered lists
 * (case-study/service cards): instead of a time-based delay, later items get
 * a LATER scroll-progress offset to "mature" into (§M.1.0 — not time-based
 * since progress isn't time). Pass `0.6 + i * 0.05` (or similar) for the Nth
 * item in a `.map()`.
 */
export function ScrollReveal({
  children,
  className,
  y = 26,
  revealAt = 0.6,
}: {
  children: ReactNode
  className?: string
  y?: number
  /** Second `useScroll` offset intersection point (§M.1.0) — default 0.6, i.e. fully revealed once the section's top reaches 60% down the viewport. */
  revealAt?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const coarse = useCoarsePointer()
  // 'start end' -> 'start <revealAt>': progress 0 when the section's top
  // touches the viewport bottom (just appeared), progress 1 once its top
  // reaches `revealAt` of the viewport height from the top.
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', `start ${revealAt}`] })
  const opacity = useTransform(scrollYProgress, [0, 1], [0, 1])
  // 3-point curve fakes an ease-out WITHOUT time-based easing (progress
  // isn't time) — a sharp deceleration toward the end of the range instead
  // of a linear approach.
  const yMotion = useTransform(scrollYProgress, [0, 0.6, 1], [y, y * 0.22, 0])
  // §M v3.3 п.2 — touch/coarse-pointer devices: a one-shot IntersectionObserver-
  // backed reveal instead of the continuous per-scroll-frame `useTransform`
  // above (nulling the iOS "everything feels janky" main-thread cost).
  // `useScroll`'s MotionValue is still created unconditionally either way —
  // its own `target: ref` effect needs `ref` attached to SOME DOM node
  // regardless of which branch below renders (same "ref must stay attached"
  // requirement documented in `tech-stack-chips.tsx`'s reduced-motion branch).
  const isInView = useInView(ref, { once: true, amount: 0.15 })

  if (reduced) {
    return (
      <div ref={ref} className={className}>
        {children}
      </div>
    )
  }

  if (coarse) {
    return (
      <div
        ref={ref}
        className={cn('transition-[opacity,transform] duration-500 ease-out', className)}
        style={{
          opacity: isInView ? 1 : 0,
          transform: isInView ? 'translateY(0)' : `translateY(${y}px)`,
        }}
      >
        {children}
      </div>
    )
  }

  // `m.div` (perf round, PR #421 orchestrator finding) — see __root.tsx's
  // module doc for why: `m` + the app-wide `<LazyMotion features={domAnimation}>`
  // provider gets the same style-bound-MotionValue rendering `motion.div`
  // gave here, without bundling gesture/drag/layout-projection code this
  // component (and none of `ScrollReveal`'s callers) ever uses.
  return (
    <m.div ref={ref} className={className} style={{ opacity, y: yMotion }}>
      {children}
    </m.div>
  )
}
