import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * "— LABEL" section kicker (landing-redesign.md §2.4 `SectionEyebrow`) — used
 * 8+ times across Home/Careers/Vacancy. The leading tick is a real element
 * (not a pseudo-element) so it composes cleanly with Tailwind.
 */
export function SectionEyebrow({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 text-[0.78rem] font-medium tracking-[0.16em] text-primary uppercase',
        className,
      )}
    >
      <span aria-hidden="true" className="h-px w-5 bg-primary/70" />
      {children}
    </span>
  )
}
