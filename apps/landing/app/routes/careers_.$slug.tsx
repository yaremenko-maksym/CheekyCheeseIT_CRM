import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancyDetail } from '@crm/shared'
import { fetchVacancy } from '@/lib/api'
import { VacancyDetailPageContent } from '@/components/marketing/pages/vacancy-detail-page-content'
import type { LocalizableVacancyDetailFields } from '@/lib/vacancy-i18n'
import { en } from '@/i18n/dictionaries/en'

/**
 * `/careers/:slug` — vacancy detail + apply form (landing-redesign.md §1,
 * §6.6). `fetchVacancy` returns `null` for the API's 404 (DRAFT/CLOSED/
 * missing — server does not distinguish, task §Public endpoints) — rendered
 * as a friendly "Role not found" state, never a raw browser 404
 * (docs/design/landing-redesign.md §8).
 */
export const Route = createFileRoute('/careers_/$slug')({
  loader: async ({ params }) => fetchVacancy(params.slug, 'en'),
  component: VacancyDetailPage,
})

function VacancyDetailPage() {
  const vacancy = Route.useLoaderData() as
    | (PublicVacancyDetail & LocalizableVacancyDetailFields)
    | null
  const { slug } = Route.useParams()
  return <VacancyDetailPageContent vacancy={vacancy} slug={slug} locale="en" dict={en} />
}
