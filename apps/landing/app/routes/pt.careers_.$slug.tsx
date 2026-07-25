import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancyDetail } from '@crm/shared'
import { fetchVacancy } from '@/lib/api'
import { VacancyDetailPageContent } from '@/components/marketing/pages/vacancy-detail-page-content'
import type { LocalizableVacancyDetailFields } from '@/lib/vacancy-i18n'
import { pt } from '@/i18n/dictionaries/pt'

/** `/pt/careers/:slug` — Portuguese vacancy detail (task-landing-i18n.md, plan §1 URL scheme). */
export const Route = createFileRoute('/pt/careers_/$slug')({
  loader: async ({ params }) => fetchVacancy(params.slug, 'pt'),
  component: PtVacancyDetailPage,
})

function PtVacancyDetailPage() {
  const vacancy = Route.useLoaderData() as
    | (PublicVacancyDetail & LocalizableVacancyDetailFields)
    | null
  const { slug } = Route.useParams()
  return <VacancyDetailPageContent vacancy={vacancy} slug={slug} locale="pt" dict={pt} />
}
