import { useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { BarChart3, MapPin, ArrowRight } from 'lucide-react'
import type { PublicVacancy } from '@crm/shared'
import { Tag } from '@/components/ui/tag'
import { domainLabel, domainTagVariant, employmentTypeLabel } from '@/lib/vacancy-domain'
import { resolveVacancyTitle, type LocalizableVacancyFields } from '@/lib/vacancy-i18n'
import { captureMorphSource } from '@/lib/title-morph'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/locale'
import { getDictionary } from '@/i18n/dictionaries'
import { careersSlugRoutePath } from '@/i18n/routes'

/**
 * Careers-teaser (Home) + `/careers` list card (landing-redesign.md §2.4
 * `VacancyCard`). The whole card is the click target — the circular arrow
 * (38px, below the 44px touch-target minimum) is decorative-only, an
 * explicit accepted exception (§6.7/§9), not an oversight.
 *
 * `will-change-transform` (§M.2a HOTFIX 2026-07-24) — same first-frame
 * layer-promotion jump fix as `ui/card.tsx`'s `hover` variant; VacancyCard
 * is always hover-active (unconditional, no `hover` prop to gate it), see
 * that file's module doc for the full diagnosis.
 *
 * `titleRef`/`onClick` (§M v3.2) — captures the `<h3>` as the shared-element
 * title-morph SOURCE on click. `VacancyCard` is one shared component for
 * both the Home teaser and the `/careers` list; the morph only actually
 * plays when the destination page validates the `/careers ↔ /careers/:slug`
 * route pair (title-morph.ts's consumer side) — no fork needed here.
 *
 * `locale` (task-landing-i18n.md, optional — default `en`) — resolves the
 * DISPLAYED title via `resolveVacancyTitle` (real translation or `en`
 * fallback, plan §3/A10) and links to this locale's `/careers/:slug`.
 */
export function VacancyCard({
  vacancy,
  locale = DEFAULT_LOCALE,
}: {
  vacancy: PublicVacancy & LocalizableVacancyFields
  locale?: Locale
}) {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const t = getDictionary(locale)
  const title = resolveVacancyTitle(vacancy, locale)
  return (
    <Link
      to={careersSlugRoutePath(locale)}
      params={{ slug: vacancy.slug }}
      onClick={() => {
        if (titleRef.current) captureMorphSource(titleRef.current, vacancy.slug)
      }}
      className="group flex h-full flex-col gap-[18px] rounded-2xl border border-border bg-card p-6 no-underline transition-[border-color,transform,background] duration-300 ease-out will-change-transform hover:-translate-y-[3px] hover:border-[color-mix(in_oklch,var(--primary)_40%,transparent)] focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[3px] md:p-[30px]"
    >
      <div className="flex items-center justify-between gap-3">
        <Tag variant={domainTagVariant(vacancy.domain)}>
          {domainLabel(vacancy.domain, t.vacancy)}
        </Tag>
        <span className="font-mono text-[0.74rem] tracking-[0.04em] text-muted-foreground">
          {employmentTypeLabel(vacancy.employmentType, t.vacancy)}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <h3
          ref={titleRef}
          data-vacancy-morph-slug={vacancy.slug}
          className="text-[1.22rem] leading-[1.15] font-semibold tracking-[-0.015em] text-foreground"
        >
          {title}
        </h3>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-[0.9rem] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <BarChart3 aria-hidden="true" className="size-3.5" />
            {vacancy.seniority}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <MapPin aria-hidden="true" className="size-3.5" />
            {vacancy.location}
          </span>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-2">
        <span className="pointer-events-none inline-flex items-center gap-2 text-[0.95rem] font-medium text-primary">
          {t.vacancyCard.viewRole}
        </span>
        <span
          aria-hidden="true"
          className="flex size-[38px] flex-none items-center justify-center rounded-full border border-border text-primary transition-[transform,background-color] duration-200 ease-out group-hover:translate-x-[2px] group-hover:bg-primary/10"
        >
          <ArrowRight className="size-4" />
        </span>
      </div>
    </Link>
  )
}
