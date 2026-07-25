import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { CareersPageContent } from '@/components/marketing/pages/careers-page-content'
import type { LocalizableVacancyFields } from '@/lib/vacancy-i18n'
import { ru } from '@/i18n/dictionaries/ru'

/** `/ru/careers` — Russian careers list (task-landing-i18n.md, plan §1 URL scheme). */
export const Route = createFileRoute('/ru/careers')({
  loader: async () => fetchVacancies('ru'),
  component: RuCareersPage,
})

function RuCareersPage() {
  const vacancies = Route.useLoaderData() as (PublicVacancy & LocalizableVacancyFields)[]
  return <CareersPageContent vacancies={vacancies} locale="ru" dict={ru} />
}
