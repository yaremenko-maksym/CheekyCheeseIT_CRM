import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import type { ServiceItem } from '@/content/home'

/** "Services" domain card (landing-redesign.md §2.4 `ServiceCard`). Hover-enabled. */
export function ServiceCard({ service }: { service: ServiceItem }) {
  return (
    <Card hover className="flex flex-col gap-4">
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
