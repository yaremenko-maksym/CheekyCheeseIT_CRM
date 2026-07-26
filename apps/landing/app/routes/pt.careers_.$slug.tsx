import { createFileRoute } from '@tanstack/react-router'
import { fetchVacancies, fetchVacancy, fetchVacancyHreflangExcludes } from '@/lib/api'
import { VacancyDetailPageContent } from '@/components/marketing/pages/vacancy-detail-page-content'
import { pt } from '@/i18n/dictionaries/pt'

/**
 * `/pt/careers/:slug` — Portuguese vacancy detail (task-landing-i18n.md, plan
 * §1 URL scheme). `hreflangExcludes` — see `lib/api.ts`
 * `fetchVacancyHreflangExcludes()` module doc for why this needs its own
 * request alongside the main `fetchVacancy` call (round-4 "дорезка").
 */
export const Route = createFileRoute('/pt/careers_/$slug')({
  loader: async ({ params }) => {
    const [vacancy, hreflangExcludes, vacancies] = await Promise.all([
      fetchVacancy(params.slug, 'pt'),
      fetchVacancyHreflangExcludes(params.slug),
      fetchVacancies('pt'),
    ])
    return { vacancy, hreflangExcludes, vacancyCount: vacancies.length }
  },
  component: PtVacancyDetailPage,
})

function PtVacancyDetailPage() {
  const { vacancy, hreflangExcludes, vacancyCount } = Route.useLoaderData()
  const { slug } = Route.useParams()
  return (
    <VacancyDetailPageContent
      vacancy={vacancy}
      hreflangExcludes={hreflangExcludes}
      slug={slug}
      vacancyCount={vacancyCount}
      locale="pt"
      dict={pt}
    />
  )
}
