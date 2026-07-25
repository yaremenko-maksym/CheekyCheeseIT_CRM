import { useRef } from 'react'
import { m, useReducedMotion, useScroll, useTransform, type MotionValue } from 'framer-motion'
import { Chip } from '@/components/ui/chip'
import { useCoarsePointer } from '@/lib/use-coarse-pointer'

/**
 * Chip-wave (docs/design/landing-redesign.md §M.1.1) — each chip is its OWN
 * component instance so it can call `useTransform` at its own top level
 * (calling a Framer Motion hook per-iteration inside `.map()` on a SHARED
 * component would violate the Rules of Hooks — a fixed hook count is only
 * guaranteed per component instance, not per loop iteration).
 */
function AnimatedChip({
  tech,
  index,
  total,
  scrollYProgress,
}: {
  tech: string
  index: number
  total: number
  scrollYProgress: MotionValue<number>
}) {
  // Entrance is spread across the first 40% of the container's scroll
  // progress range so chips ripple in left-to-right instead of popping in
  // all at once (§M.1.1 "chip-волна").
  const start = (index / total) * 0.4
  const opacity = useTransform(scrollYProgress, [start, start + 0.2], [0, 1])
  const y = useTransform(scrollYProgress, [start, start + 0.2], [10, 0])
  // `m.div` (perf round, PR #421 orchestrator finding) — see __root.tsx's
  // module doc.
  return (
    <m.div style={{ opacity, y }}>
      <Chip>{tech}</Chip>
    </m.div>
  )
}

/** "Tech stack" chip grid (landing-redesign.md §2.4 `TechStackChips`). */
export function TechStackChips({ stack }: { stack: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const coarse = useCoarsePointer()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 0.6'] })

  // §M v3.3 п.2 — ambient chip-wave has no natural one-shot equivalent;
  // touch merges into the SAME static fallback as reduced-motion.
  if (reduced || coarse) {
    // `ref` MUST still be attached here even though its value goes unused —
    // `useScroll({ target: ref })` above already committed to measuring
    // this ref; permanently never attaching it (as an earlier version of
    // this component did) throws framer-motion's "Target ref is defined but
    // not hydrated" error the moment its internal effect looks for a DOM
    // node that will never arrive, crashing the whole route under
    // `prefers-reduced-motion: reduce` (caught by E2E, not unit tests).
    return (
      <div ref={ref} className="flex flex-wrap gap-3">
        {stack.map((tech) => (
          <Chip key={tech}>{tech}</Chip>
        ))}
      </div>
    )
  }

  return (
    <div ref={ref} className="flex flex-wrap gap-3">
      {stack.map((tech, i) => (
        <AnimatedChip
          key={tech}
          tech={tech}
          index={i}
          total={stack.length}
          scrollYProgress={scrollYProgress}
        />
      ))}
    </div>
  )
}
