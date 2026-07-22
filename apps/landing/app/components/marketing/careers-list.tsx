import { FolderOpen } from 'lucide-react'
import type { PublicVacancy } from '@crm/shared'
import { VacancyCard } from '@/components/marketing/vacancy-card'
import { Button } from '@/components/ui/button'
import { CONTACT_EMAIL } from '@/content/home'

/**
 * `/careers` list body — extracted from the route component so it is
 * unit-testable with plain props (task-landing-redesign.md AC5 "careers-
 * список (данные/пусто)") without wiring up a TanStack Router loader
 * harness. No filters/tabs (owner decision 2026-07-23, AC2).
 */
export function CareersList({ vacancies }: { vacancies: PublicVacancy[] }) {
  if (vacancies.length === 0) {
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

  return (
    <div className="grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2 md:gap-7">
      {vacancies.map((vacancy) => (
        <VacancyCard key={vacancy.slug} vacancy={vacancy} />
      ))}
    </div>
  )
}
