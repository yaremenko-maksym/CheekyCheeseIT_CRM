import { useRef, type ReactNode } from 'react'
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'

/**
 * Progress-linked scroll-reveal (docs/design/landing-redesign.md §M.1.0) —
 * upgrade of the old one-shot `whileInView` `Reveal` (§5.1). Opacity/y are
 * `useTransform` motion values bound directly to the section's OWN scroll
 * progress (`useScroll({ target: ref })`), not a discrete IntersectionObserver
 * trigger — scrolling back up smoothly un-reveals the section (no `once`,
 * intentional: the owner explicitly asked for "animation depending on the
 * CURRENT scroll position", not "play once and forget").
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
  // 'start end' -> 'start <revealAt>': progress 0 when the section's top
  // touches the viewport bottom (just appeared), progress 1 once its top
  // reaches `revealAt` of the viewport height from the top.
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', `start ${revealAt}`] })
  const opacity = useTransform(scrollYProgress, [0, 1], [0, 1])
  // 3-point curve fakes an ease-out WITHOUT time-based easing (progress
  // isn't time) — a sharp deceleration toward the end of the range instead
  // of a linear approach.
  const yMotion = useTransform(scrollYProgress, [0, 0.6, 1], [y, y * 0.22, 0])

  if (reduced) {
    return (
      <div ref={ref} className={className}>
        {children}
      </div>
    )
  }

  return (
    <motion.div ref={ref} className={className} style={{ opacity, y: yMotion }}>
      {children}
    </motion.div>
  )
}
