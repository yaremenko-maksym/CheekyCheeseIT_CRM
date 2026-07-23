import { FolderOpen } from 'lucide-react'
import type { PublicVacancy } from '@crm/shared'
import { VacancyCard } from '@/components/marketing/vacancy-card'
import { Button } from '@/components/ui/button'
import { CONTACT_EMAIL, HOME_CAREERS_TEASER_LIMIT } from '@/content/home'

/**
 * Home "Careers" section body — up to 3 live PUBLISHED vacancies, or an
 * empty-CTA when there are none (task-landing-redesign.md AC2: the section
 * itself is NEVER hidden). Extracted from `routes/index.tsx` so it is
 * unit-testable with plain props (AC5 "тизер (данные/пусто)").
 */
export function CareersTeaser({ vacancies }: { vacancies: PublicVacancy[] }) {
  const teaser = vacancies.slice(0, HOME_CAREERS_TEASER_LIMIT)

  if (teaser.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-card p-7 py-14 text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary/12 text-primary">
          <FolderOpen aria-hidden="true" className="size-[26px]" />
        </div>
        <h3 className="mb-2.5 text-[clamp(1.25rem,2.4vw,1.6rem)] leading-[1.15] font-semibold tracking-[-0.015em] text-foreground">
          No open roles right now
        </h3>
        <p className="mx-auto mb-6 max-w-[44ch] text-muted-foreground">
          We hire in waves and we&rsquo;re between them. Send your CV anyway — we keep every strong
          profile on file.
        </p>
        <Button asChild>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </Button>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-3 md:gap-7">
      {teaser.map((vacancy) => (
        <VacancyCard key={vacancy.slug} vacancy={vacancy} />
      ))}
    </div>
  )
}
