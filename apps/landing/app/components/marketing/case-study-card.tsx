import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import type { CaseStudy } from '@/content/case-studies'

/**
 * "Selected work" case study (landing-redesign.md §2.4 `CaseStudyCard`,
 * §6.4). 1 column <860px (text over 3-in-a-row metrics), `1.25fr 1fr` ≥860px.
 * Metrics NEVER collapse to 1 column, even on 320px — values are short
 * ("80ms" / "-64%" / "5×").
 */
export function CaseStudyCard({ study }: { study: CaseStudy }) {
  return (
    <Card>
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
        <div className="grid grid-cols-3 gap-4">
          {study.metrics.map((metric) => (
            <div key={metric.label}>
              <div className="text-[1.9rem] font-semibold tracking-[-0.03em] text-foreground">
                {metric.value}
                {metric.suffix && <em className="text-primary not-italic">{metric.suffix}</em>}
              </div>
              <div className="mt-2 text-[0.82rem] text-muted-foreground">{metric.label}</div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}
