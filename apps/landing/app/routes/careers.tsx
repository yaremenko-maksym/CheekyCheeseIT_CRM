import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { useDocumentHead } from '@/lib/use-document-head'
import { buildItemListJsonLd, canonicalUrl } from '@/lib/seo'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { SectionEyebrow } from '@/components/marketing/section-eyebrow'
import { CareersList } from '@/components/marketing/careers-list'

/**
 * `/careers` — full list, NO filters/tabs (owner decision 2026-07-23, see
 * docs/design/landing-redesign.md §1 + task-landing-redesign.md AC2).
 */
export const Route = createFileRoute('/careers')({
  loader: async () => fetchVacancies(),
  component: CareersPage,
})

function CareersPage() {
  const vacancies = Route.useLoaderData() as PublicVacancy[]

  useDocumentHead({
    title: 'Careers — CheekyCheeseIT',
    description:
      'Open senior engineering roles at CheekyCheeseIT — remote-first, senior-only, real ownership.',
    canonical: canonicalUrl('/careers'),
    // ItemList only when there's something to list — an empty one has
    // nothing useful to tell a crawler (owner decision 2026-07-24).
    jsonLd: vacancies.length > 0 ? buildItemListJsonLd(vacancies) : undefined,
  })

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <MarketingNav active="careers" />

      {/* `tabIndex={-1}` — page-transition focus target (§M.3 step 9). */}
      <main tabIndex={-1} className="flex-1 focus:outline-none">
        <section className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_60%_at_80%_10%,color-mix(in_oklch,var(--primary)_11%,transparent),transparent_70%)]"
          />
          <div className="relative mx-auto max-w-[1200px] px-5 pt-14 pb-11 md:px-10 lg:px-14">
            <SectionEyebrow className="mb-[22px]">Careers</SectionEyebrow>
            <h1 className="mb-5 max-w-[15ch] text-[clamp(2.2rem,6.5vw,4rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance text-foreground">
              Build hard things with senior people.
            </h1>
            <p className="max-w-[52ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
              Remote-first, senior-only, real ownership. We hire slowly and keep teams small — every
              role here is one we genuinely need filled.
            </p>
            {/* owner decision 2026-07-24: natural, non-spammy SEO copy in the
                existing lead block (no new visual section) — "remote IT jobs" /
                "senior engineering roles" for title-bearing search queries. */}
            <p className="mt-4 max-w-[52ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
              Browse our open remote IT jobs below — every senior engineering role here is a real
              seat on a live product team, not a maybe-someday requisition.
            </p>
          </div>
        </section>

        <div className="mx-auto max-w-[1200px] px-5 pb-24 md:px-10 lg:px-14">
          <div className="mb-10 border-t border-border" />
          <CareersList vacancies={vacancies} />
        </div>
      </main>

      <MarketingFooter />
    </div>
  )
}
