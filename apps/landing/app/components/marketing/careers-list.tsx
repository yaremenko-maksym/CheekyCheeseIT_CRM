import { useLayoutEffect } from 'react'
import { useLocation } from '@tanstack/react-router'
import { FolderOpen } from 'lucide-react'
import type { PublicVacancy } from '@crm/shared'
import { VacancyCard } from '@/components/marketing/vacancy-card'
import { Button } from '@/components/ui/button'
import { CONTACT_EMAIL } from '@/content/home'
import {
  findMorphTargetElement,
  playTitleMorphOverlay,
  readPendingMorph,
  validateMorphDestination,
} from '@/lib/title-morph'
import { DEFAULT_LOCALE, type Locale } from '@/i18n/locale'
import type { Dictionary } from '@/i18n/dictionary'

/**
 * `/careers` list body — extracted from the route component so it is
 * unit-testable with plain props (task-landing-redesign.md AC5 "careers-
 * список (данные/пусто)") without wiring up a TanStack Router loader
 * harness. No filters/tabs (owner decision 2026-07-23, AC2).
 *
 * Title-morph consumer, back direction (docs/design/landing-redesign.md
 * §M v3.2 п.5) — the detail page's `<h1>` "flying" back into the matching
 * `VacancyCard`'s `<h3>` here. `useLayoutEffect` (not `useEffect`): must run
 * BEFORE the browser paints this route's first frame, or the real card
 * titles would flash visible before the overlay hides the target one.
 * `readPendingMorph(pathname)` always one-shot consumes regardless of
 * whether this list has any cards — a stray pending morph from an unrelated
 * navigation must never leak into a LATER `/careers` visit — but ONLY
 * actually returns a morph when THIS component's own current pathname is
 * the navigation's real destination (`lib/title-morph.ts`'s addressable
 * consume, fix for a HIGH fidelity-review finding, 2026-07-25).
 *
 * **`pathname` is deliberately OMITTED from the effect's dependency array**
 * (fix for a second, self-inflicted bug found while verifying the fix
 * above): `useLocation()` is reactive — TanStack Router updates
 * `router.state.location` to the PENDING/target location early in a
 * navigation, well before this component actually unmounts, so if
 * `pathname` were a dependency, the effect would RE-RUN the instant the
 * global pending location changes — while `CareersList` is STILL mounted
 * as the SOURCE page — defeating the whole point of the addressable check
 * (the re-run would read the DESTINATION's pathname, "passing" its own
 * check despite still being the source). Omitting it from deps means the
 * effect only ever runs on this component's OWN true mount, and the
 * `pathname` value it captures via closure is a snapshot of THIS
 * component's own identity at that moment, not a live-tracked value.
 */
export function CareersList({
  vacancies,
  locale = DEFAULT_LOCALE,
  dict,
}: {
  vacancies: PublicVacancy[]
  locale?: Locale
  dict: Dictionary
}) {
  const pathname = useLocation({ select: (location) => location.pathname })
  const t = dict

  useLayoutEffect(() => {
    const morph = readPendingMorph(pathname)
    if (!morph) return
    const destEl = findMorphTargetElement(morph.slug)
    if (!destEl || !validateMorphDestination(morph, morph.slug, destEl)) return
    playTitleMorphOverlay(morph, destEl)
  }, [vacancies])

  if (vacancies.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card p-9 py-[72px] text-center">
        <div className="mx-auto mb-[22px] flex size-[60px] items-center justify-center rounded-2xl bg-primary/12 text-primary">
          <FolderOpen aria-hidden="true" className="size-7" />
        </div>
        <h2 className="mb-3 text-[1.4rem] font-semibold tracking-[-0.015em] text-foreground">
          {t.careers.emptyTitle}
        </h2>
        <p className="mx-auto mb-7 max-w-[46ch] text-muted-foreground">{t.careers.emptyBody}</p>
        <Button asChild>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </Button>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2 md:gap-7">
      {vacancies.map((vacancy) => (
        <VacancyCard key={vacancy.slug} vacancy={vacancy} locale={locale} dict={dict} />
      ))}
    </div>
  )
}
