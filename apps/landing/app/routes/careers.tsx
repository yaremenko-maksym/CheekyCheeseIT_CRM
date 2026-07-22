import { createFileRoute } from '@tanstack/react-router'
import { FolderOpen } from 'lucide-react'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { useDocumentHead } from '@/lib/use-document-head'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { SectionEyebrow } from '@/components/marketing/section-eyebrow'
import { VacancyCard } from '@/components/marketing/vacancy-card'
import { Button } from '@/components/ui/button'
import { CONTACT_EMAIL } from '@/content/home'

/**
 * `/careers` — full list, NO filters/tabs (owner decision 2026-07-23, see
 * docs/design/landing-redesign.md §1 + task-landing-redesign.md AC2).
 */
export const Route = createFileRoute('/careers')({
  loader: async () => fetchVacancies(),
  component: CareersPage,
})

function EmptyState() {
  return (
    <div className="rounded-2xl border border-border bg-card p-9 py-[72px] text-center">
      <div className="mx-auto mb-[22px] flex size-[60px] items-center justify-center rounded-2xl bg-primary/12 text-primary">
        <FolderOpen aria-hidden="true" className="size-7" />
      </div>
      <h2 className="mb-3 text-[1.4rem] font-semibold tracking-[-0.015em] text-foreground">
        No open roles right now
      </h2>
      <p className="mx-auto mb-7 max-w-[46ch] text-muted-foreground">
        We hire in waves and we&rsquo;re between them. Send your CV anyway — we keep every strong
        profile on file and reach out the moment something fits.
      </p>
      <Button asChild>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </Button>
    </div>
  )
}

function CareersPage() {
  const vacancies = Route.useLoaderData() as PublicVacancy[]

  useDocumentHead({
    title: 'Careers — CheekyCheeseIT',
    description:
      'Open senior engineering roles at CheekyCheeseIT — remote-first, senior-only, real ownership.',
  })

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <MarketingNav active="careers" />

      <main className="flex-1">
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
          </div>
        </section>

        <div className="mx-auto max-w-[1200px] px-5 pb-24 md:px-10 lg:px-14">
          <div className="mb-10 border-t border-border" />

          {vacancies.length > 0 ? (
            <div className="grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2 md:gap-7">
              {vacancies.map((vacancy) => (
                <VacancyCard key={vacancy.slug} vacancy={vacancy} />
              ))}
            </div>
          ) : (
            <EmptyState />
          )}
        </div>
      </main>

      <MarketingFooter />
    </div>
  )
}
