import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { CareersPageContent } from '@/components/marketing/pages/careers-page-content'
import type { LocalizableVacancyFields } from '@/lib/vacancy-i18n'
import { pt } from '@/i18n/dictionaries/pt'

/** `/pt/careers` — Portuguese careers list (task-landing-i18n.md, plan §1 URL scheme). */
export const Route = createFileRoute('/pt/careers')({
  loader: async () => fetchVacancies('pt'),
  component: PtCareersPage,
})

function PtCareersPage() {
  const vacancies = Route.useLoaderData() as (PublicVacancy & LocalizableVacancyFields)[]
  return <CareersPageContent vacancies={vacancies} locale="pt" dict={pt} />
}
