import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { HomePageContent } from '@/components/marketing/pages/home-page-content'
import type { LocalizableVacancyFields } from '@/lib/vacancy-i18n'
import { pt } from '@/i18n/dictionaries/pt'

/** `/pt` — Portuguese home (task-landing-i18n.md, plan §1 URL scheme). */
export const Route = createFileRoute('/pt')({
  loader: async () => fetchVacancies('pt'),
  component: PtLandingPage,
})

function PtLandingPage() {
  const vacancies = Route.useLoaderData() as (PublicVacancy & LocalizableVacancyFields)[]
  return <HomePageContent vacancies={vacancies} locale="pt" dict={pt} />
}
