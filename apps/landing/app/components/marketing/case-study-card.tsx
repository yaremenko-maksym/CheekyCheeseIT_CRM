import { useRef } from 'react'
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { useCoarsePointer } from '@/lib/use-coarse-pointer'
import type { CaseStudy } from '@/content/case-studies'

/**
 * "Selected work" case study (landing-redesign.md §2.4 `CaseStudyCard`,
 * §6.4). 1 column <860px (text over 3-in-a-row metrics), `1.25fr 1fr` ≥860px.
 * Metrics NEVER collapse to 1 column, even on 320px — values are short
 * ("80ms" / "-64%" / "5×").
 *
 * Metric-lag (§M.1.1): the whole card is wrapped in a `ScrollReveal` by the
 * caller (`routes/index.tsx`), but the metrics grid tracks the CARD's OWN
 * scroll progress (same `useScroll` offset the outer `ScrollReveal` uses)
 * with a shifted input domain — it "catches up" to the rest of the card's
 * content ~15% later, a subtle depth cue instead of one flat simultaneous
 * fade. §M v3.3 п.2 (touch) — the lag is disabled: metrics appear TOGETHER
 * with the rest of the card via the same static/plain render as the
 * reduced-motion branch (no separate one-shot lag effect, per spec — the
 * parent `ScrollReveal`'s own touch fallback already handles the entrance).
 *
 * §M v3.4 mobile audit #2 — `text-[1.35rem] min-[400px]:text-[1.9rem]` on
 * both metric-value branches: at 1.9rem, a 2-digit `±NN%` value's natural
 * width (~83px) overruns the 66px+16px-gap grid column budget on 320px
 * viewports, visually touching the next metric. Smaller base size fully
 * fixes it; ≥400px reverts to the original 1.9rem (no overlap there).
 */
export function CaseStudyCard({ study }: { study: CaseStudy }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const coarse = useCoarsePointer()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 0.6'] })
  const metricsOpacity = useTransform(scrollYProgress, [0.15, 1], [0, 1])
  const metricsY = useTransform(scrollYProgress, [0.15, 1], [14, 0])

  return (
    <Card ref={ref}>
      <div className="grid grid-cols-1 items-start gap-7 min-[860px]:grid-cols-[1.25fr_1fr] min-[860px]:gap-11">
        <div>
          <Tag variant={study.domain} className="mb-[18px]">
            {study.domainLabel}
          </Tag>
          <h3 className="mb-[18px] text-[clamp(1.25rem,2.4vw,1.6rem)] leading-[1.15] font-semibold tracking-[-0.015em] text-foreground">
            {study.title}
          </h3>
          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-1.5 font-mono text-[0.72rem] tracking-[0.12em] text-primary uppercase">
                Challenge
              </div>
              <p className="m-0 text-muted-foreground">{study.challenge}</p>
            </div>
            <div>
              <div className="mb-1.5 font-mono text-[0.72rem] tracking-[0.12em] text-primary uppercase">
                Solution
              </div>
              <p className="m-0 text-muted-foreground">{study.solution}</p>
            </div>
          </div>
        </div>
        {reduced || coarse ? (
          <div className="grid grid-cols-3 gap-4">
            {study.metrics.map((metric) => (
              <div key={metric.label}>
                <div className="text-[1.35rem] min-[400px]:text-[1.9rem] font-semibold tracking-[-0.03em] text-foreground tabular-nums">
                  {metric.value}
                  {metric.suffix && <em className="text-primary not-italic">{metric.suffix}</em>}
                </div>
                <div className="mt-2 text-[0.82rem] text-muted-foreground">{metric.label}</div>
              </div>
            ))}
          </div>
        ) : (
          <motion.div
            className="grid grid-cols-3 gap-4"
            style={{ opacity: metricsOpacity, y: metricsY }}
          >
            {study.metrics.map((metric) => (
              <div key={metric.label}>
                <div className="text-[1.35rem] min-[400px]:text-[1.9rem] font-semibold tracking-[-0.03em] text-foreground tabular-nums">
                  {metric.value}
                  {metric.suffix && <em className="text-primary not-italic">{metric.suffix}</em>}
                </div>
                <div className="mt-2 text-[0.82rem] text-muted-foreground">{metric.label}</div>
              </div>
            ))}
          </motion.div>
        )}
      </div>
    </Card>
  )
}
