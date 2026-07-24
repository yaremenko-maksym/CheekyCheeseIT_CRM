import { useRef } from 'react'
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { ProcessStep } from '@/components/marketing/process-step'
import type { ProcessStepItem } from '@/content/home'

/**
 * "How we work" 4-step grid + the connector-line signature detail
 * (docs/design/landing-redesign.md §M.1.1) — a hairline that "draws itself"
 * left-to-right across the row as the section scrolls into view, visible in
 * the gaps between the step cards (the cards themselves paint over it,
 * literally threading steps 1→4 together). `md:` and up only — the mobile
 * grid is single-column, a horizontal connector makes no sense there.
 */
export function ProcessStepsGrid({ steps }: { steps: ProcessStepItem[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end 0.4'] })
  const scaleX = useTransform(scrollYProgress, [0, 1], [0, 1])

  return (
    <div ref={ref} className="relative">
      {reduced ? (
        <div
          aria-hidden="true"
          className="absolute top-[34px] right-[12.5%] left-[12.5%] hidden h-px origin-left bg-primary/50 md:block"
        />
      ) : (
        <motion.div
          aria-hidden="true"
          className="absolute top-[34px] right-[12.5%] left-[12.5%] hidden h-px origin-left bg-primary/50 md:block"
          style={{ scaleX }}
        />
      )}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-4 md:gap-7">
        {steps.map((step) => (
          <ProcessStep key={step.stepNum} step={step} />
        ))}
      </div>
    </div>
  )
}
