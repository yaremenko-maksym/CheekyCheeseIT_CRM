import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancyDetail } from '@crm/shared'
import { fetchVacancy } from '@/lib/api'
import { VacancyDetailPageContent } from '@/components/marketing/pages/vacancy-detail-page-content'
import type { LocalizableVacancyDetailFields } from '@/lib/vacancy-i18n'
import { uk } from '@/i18n/dictionaries/uk'

/** `/uk/careers/:slug` — Ukrainian vacancy detail (task-landing-i18n.md, plan §1 URL scheme). */
export const Route = createFileRoute('/uk/careers_/$slug')({
  loader: async ({ params }) => fetchVacancy(params.slug, 'uk'),
  component: UkVacancyDetailPage,
})

function UkVacancyDetailPage() {
  const vacancy = Route.useLoaderData() as
    | (PublicVacancyDetail & LocalizableVacancyDetailFields)
    | null
  const { slug } = Route.useParams()
  return <VacancyDetailPageContent vacancy={vacancy} slug={slug} locale="uk" dict={uk} />
}
