import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancyDetail } from '@crm/shared'
import { fetchVacancy } from '@/lib/api'
import { VacancyDetailPageContent } from '@/components/marketing/pages/vacancy-detail-page-content'
import type { LocalizableVacancyDetailFields } from '@/lib/vacancy-i18n'

/** `/ru/careers/:slug` — Russian vacancy detail (task-landing-i18n.md, plan §1 URL scheme). */
export const Route = createFileRoute('/ru/careers_/$slug')({
  loader: async ({ params }) => fetchVacancy(params.slug, 'ru'),
  component: RuVacancyDetailPage,
})

function RuVacancyDetailPage() {
  const vacancy = Route.useLoaderData() as
    | (PublicVacancyDetail & LocalizableVacancyDetailFields)
    | null
  const { slug } = Route.useParams()
  return <VacancyDetailPageContent vacancy={vacancy} slug={slug} locale="ru" />
}
