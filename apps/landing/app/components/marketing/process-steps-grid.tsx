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
 *
 * §M.1.1a HOTFIX (2026-07-24) — the line was crossing OUT the step-label
 * text ("01 / Discovery" etc, read as strikethrough). Two independent
 * causes, both fixed together:
 * 1. **Stacking order** — the line is `absolute`, but the card grid below
 *    was NOT positioned (`static`), so per CSS 2.1 the (positioned) line
 *    always painted ABOVE the (non-positioned) cards regardless of DOM
 *    order. Fix: `relative z-10` on the grid wrapper (now positioned, so it
 *    paints over the `z-0` line as intended — visible only in the 28px
 *    gaps between cards) — the STRUCTURAL fix, addresses the root cause.
 * 2. **Geometry** — defense-in-depth for the moment the section is still
 *    mid-fade (`ScrollReveal` opacity 0→1), when a semi-transparent card
 *    doesn't fully occlude what's under it either. `top-[34px]` sat
 *    squarely inside the step-label's line-box; `top-[60px]` sits in the
 *    safe zone between the label and the heading (approximate — depends on
 *    browser font-hinting, verify visually against the real render).
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
          className="absolute top-[60px] right-[12.5%] left-[12.5%] z-0 hidden h-px origin-left bg-primary/50 md:block"
        />
      ) : (
        <motion.div
          aria-hidden="true"
          className="absolute top-[60px] right-[12.5%] left-[12.5%] z-0 hidden h-px origin-left bg-primary/50 md:block"
          style={{ scaleX }}
        />
      )}
      <div className="relative z-10 grid grid-cols-1 gap-5 md:grid-cols-4 md:gap-7">
        {steps.map((step) => (
          <ProcessStep key={step.stepNum} step={step} />
        ))}
      </div>
    </div>
  )
}
