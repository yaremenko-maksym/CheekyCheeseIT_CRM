import { createFileRoute } from '@tanstack/react-router'
import { fetchVacancies, fetchVacancy, fetchVacancyHreflangExcludes } from '@/lib/api'
import { VacancyDetailPageContent } from '@/components/marketing/pages/vacancy-detail-page-content'
import { es } from '@/i18n/dictionaries/es'

/**
 * `/es/careers/:slug` — Spanish vacancy detail (task-landing-i18n.md, plan §1
 * URL scheme). `hreflangExcludes` — see `lib/api.ts`
 * `fetchVacancyHreflangExcludes()` module doc for why this needs its own
 * request alongside the main `fetchVacancy` call (round-4 "дорезка").
 */
export const Route = createFileRoute('/es/careers_/$slug')({
  loader: async ({ params }) => {
    const [vacancy, hreflangExcludes, vacancies] = await Promise.all([
      fetchVacancy(params.slug, 'es'),
      fetchVacancyHreflangExcludes(params.slug),
      fetchVacancies('es'),
    ])
    return { vacancy, hreflangExcludes, vacancyCount: vacancies.length }
  },
  component: EsVacancyDetailPage,
})

function EsVacancyDetailPage() {
  const { vacancy, hreflangExcludes, vacancyCount } = Route.useLoaderData()
  const { slug } = Route.useParams()
  return (
    <VacancyDetailPageContent
      vacancy={vacancy}
      hreflangExcludes={hreflangExcludes}
      slug={slug}
      vacancyCount={vacancyCount}
      locale="es"
      dict={es}
    />
  )
}
