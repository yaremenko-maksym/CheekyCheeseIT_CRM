import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { HomePageContent } from '@/components/marketing/pages/home-page-content'
import type { LocalizableVacancyFields } from '@/lib/vacancy-i18n'

/** `/ru` — Russian home (task-landing-i18n.md, plan §1 URL scheme). */
export const Route = createFileRoute('/ru')({
  loader: async () => fetchVacancies('ru'),
  component: RuLandingPage,
})

function RuLandingPage() {
  const vacancies = Route.useLoaderData() as (PublicVacancy & LocalizableVacancyFields)[]
  return <HomePageContent vacancies={vacancies} locale="ru" />
}
