import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { CareersPageContent } from '@/components/marketing/pages/careers-page-content'
import { es } from '@/i18n/dictionaries/es'

/** `/es/careers` — Spanish careers list (task-landing-i18n.md, plan §1 URL scheme). */
export const Route = createFileRoute('/es/careers')({
  loader: async () => fetchVacancies('es'),
  component: EsCareersPage,
})

function EsCareersPage() {
  const vacancies = Route.useLoaderData() as PublicVacancy[]
  return <CareersPageContent vacancies={vacancies} locale="es" dict={es} />
}
