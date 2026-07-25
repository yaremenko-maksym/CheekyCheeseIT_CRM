import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { CareersPageContent } from '@/components/marketing/pages/careers-page-content'
import { uk } from '@/i18n/dictionaries/uk'

/** `/uk/careers` — Ukrainian careers list (task-landing-i18n.md, plan §1 URL scheme). */
export const Route = createFileRoute('/uk/careers')({
  loader: async () => fetchVacancies('uk'),
  component: UkCareersPage,
})

function UkCareersPage() {
  const vacancies = Route.useLoaderData() as PublicVacancy[]
  return <CareersPageContent vacancies={vacancies} locale="uk" dict={uk} />
}
