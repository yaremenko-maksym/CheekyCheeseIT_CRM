import { createFileRoute } from '@tanstack/react-router'
import { fetchVacancy, fetchVacancyHreflangExcludes } from '@/lib/api'
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
    const [vacancy, hreflangExcludes] = await Promise.all([
      fetchVacancy(params.slug, 'es'),
      fetchVacancyHreflangExcludes(params.slug),
    ])
    return { vacancy, hreflangExcludes }
  },
  component: EsVacancyDetailPage,
})

function EsVacancyDetailPage() {
  const { vacancy, hreflangExcludes } = Route.useLoaderData()
  const { slug } = Route.useParams()
  return (
    <VacancyDetailPageContent
      vacancy={vacancy}
      hreflangExcludes={hreflangExcludes}
      slug={slug}
      locale="es"
      dict={es}
    />
  )
}
