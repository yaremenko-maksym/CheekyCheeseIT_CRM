import { Card } from '@/components/ui/card'
import type { ProcessStepItem } from '@/content/home'

/** "How we work" timeline step (landing-redesign.md §2.4 `ProcessStep`). */
export function ProcessStep({ step }: { step: ProcessStepItem }) {
  return (
    <Card className="p-[26px] md:p-[26px]">
      <div className="mb-5 font-mono text-[0.82rem] tracking-[0.1em] text-primary">
        {step.stepNum}
      </div>
      <h3 className="mb-2.5 text-[1.15rem] leading-[1.15] font-semibold tracking-[-0.015em] text-foreground">
        {step.title}
      </h3>
      <p className="m-0 text-[0.94rem] text-muted-foreground">{step.description}</p>
    </Card>
  )
}
