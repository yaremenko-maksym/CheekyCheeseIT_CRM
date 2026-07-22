import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft, Briefcase, BarChart3, MapPin } from 'lucide-react'
import type { PublicVacancyDetail } from '@crm/shared'
import { fetchVacancy } from '@/lib/api'
import { useDocumentHead } from '@/lib/use-document-head'
import { domainLabel, domainTagVariant, employmentTypeLabel } from '@/lib/vacancy-domain'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { MarkdownBody } from '@/components/marketing/markdown-body'
import { VacancyApplyForm } from '@/components/marketing/vacancy-apply-form'
import { Tag } from '@/components/ui/tag'
import { cn, focusRing } from '@/lib/utils'

/**
 * `/careers/:slug` — vacancy detail + apply form (landing-redesign.md §1,
 * §6.6). `fetchVacancy` returns `null` for the API's 404 (DRAFT/CLOSED/
 * missing — server does not distinguish, task §Public endpoints) — rendered
 * as a friendly "Role not found" state, never a raw browser 404
 * (docs/design/landing-redesign.md §8).
 */
export const Route = createFileRoute('/careers_/$slug')({
  loader: async ({ params }) => fetchVacancy(params.slug),
  component: VacancyDetailPage,
})

function NotFoundState() {
  useDocumentHead({
    title: 'Role not found — CheekyCheeseIT Careers',
    description: 'This role is no longer available.',
  })
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <MarketingNav active="careers" />
      <main className="flex flex-1 items-center justify-center px-5 py-24 text-center">
        <div>
          <h1 className="mb-3 text-[1.6rem] font-semibold tracking-[-0.015em] text-foreground">
            Role not found
          </h1>
          <p className="mb-6 text-muted-foreground">
            This role isn&rsquo;t open anymore — but there may be others.
          </p>
          <Link
            to="/careers"
            className={cn('inline-flex items-center gap-2 font-medium text-primary', focusRing)}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back to careers
          </Link>
        </div>
      </main>
      <MarketingFooter />
    </div>
  )
}

function VacancyDetailPage() {
  const vacancy = Route.useLoaderData() as PublicVacancyDetail | null

  if (!vacancy) return <NotFoundState />

  return <VacancyDetailContent vacancy={vacancy} />
}

function VacancyDetailContent({ vacancy }: { vacancy: PublicVacancyDetail }) {
  useDocumentHead({
    title: `${vacancy.title} — CheekyCheeseIT Careers`,
    description: `${vacancy.title} (${vacancy.seniority}, ${employmentTypeLabel(vacancy.employmentType)}, ${vacancy.location}) — apply at CheekyCheeseIT.`,
  })

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <MarketingNav active="careers" />

      <main className="flex-1">
        <div className="mx-auto max-w-[1200px] px-5 pt-8 pb-5 md:px-10 lg:px-14">
          <Link
            to="/careers"
            className={cn('inline-flex items-center gap-2 text-muted-foreground', focusRing)}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            All roles
          </Link>
        </div>

        <div className="mx-auto max-w-[1200px] border-b border-border px-5 pb-9 md:px-10 lg:px-14">
          <Tag variant={domainTagVariant(vacancy.domain)} className="mb-[18px]">
            {domainLabel(vacancy.domain)}
          </Tag>
          <h1 className="mb-[22px] max-w-[18ch] text-[clamp(2rem,5.5vw,3.4rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance text-foreground">
            {vacancy.title}
          </h1>
          <div className="flex flex-wrap gap-2.5">
            <Tag variant="neutral">
              <BarChart3 aria-hidden="true" className="size-3.5" />
              {vacancy.seniority}
            </Tag>
            <Tag variant="neutral">
              <Briefcase aria-hidden="true" className="size-3.5" />
              {employmentTypeLabel(vacancy.employmentType)}
            </Tag>
            <Tag variant="neutral">
              <MapPin aria-hidden="true" className="size-3.5" />
              {vacancy.location}
            </Tag>
          </div>
        </div>

        <div className="mx-auto max-w-[1200px] px-5 pt-12 pb-24 md:px-10 lg:px-14">
          <div className="grid grid-cols-1 items-start gap-10 min-[1000px]:grid-cols-[1.35fr_1fr] min-[1000px]:gap-14">
            <MarkdownBody markdown={vacancy.descriptionMd} />
            <aside>
              <div className="static min-[1000px]:sticky min-[1000px]:top-[90px]">
                <VacancyApplyForm slug={vacancy.slug} vacancyTitle={vacancy.title} />
              </div>
            </aside>
          </div>
        </div>
      </main>

      <MarketingFooter />
    </div>
  )
}
