import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import type { ServiceItem } from '@/content/home'

/**
 * "Services" domain card (landing-redesign.md §2.4 `ServiceCard`). Hover-enabled
 * + glow (§M.2). `h-full` (task fix-service-card-fourth-chip) — the caller
 * wraps each card in `ScrollReveal`, which IS the grid item and stretches to
 * the row's height by CSS Grid's own default, but `Card` nested inside it
 * doesn't inherit that automatically (block layout, not `h-full`/flex): the
 * 2×2 Services grid went from three cards with near-identical copy length to
 * four, and the "Any domain" card's longer paragraph made row 2 visibly
 * uneven (measured 305px vs 353px) without this. Same fix `VacancyCard`
 * already uses one grid-level up (no intermediate `ScrollReveal` there).
 */
export function ServiceCard({ service }: { service: ServiceItem }) {
  return (
    <Card hover glow className="flex h-full flex-col gap-4">
      <Tag variant={service.domain} className="self-start">
        {service.domainLabel}
      </Tag>
      <h3 className="text-[clamp(1.25rem,2.4vw,1.6rem)] leading-[1.15] font-semibold tracking-[-0.015em] text-foreground">
        {service.title}
      </h3>
      <p className="m-0 text-muted-foreground">{service.description}</p>
      <ul className="m-0 mt-1.5 list-disc space-y-0 pl-[18px] text-[0.92rem] leading-[1.9] text-muted-foreground marker:text-primary">
        {service.bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
    </Card>
  )
}
