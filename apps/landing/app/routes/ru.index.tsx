import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { HomePageContent } from '@/components/marketing/pages/home-page-content'
import { ru } from '@/i18n/dictionaries/ru'

/** `/ru` — Russian home (task-landing-i18n.md, plan §1 URL scheme). */
export const Route = createFileRoute('/ru/')({
  loader: async () => fetchVacancies('ru'),
  component: RuLandingPage,
})

function RuLandingPage() {
  const vacancies = Route.useLoaderData() as PublicVacancy[]
  return <HomePageContent vacancies={vacancies} locale="ru" dict={ru} />
}
