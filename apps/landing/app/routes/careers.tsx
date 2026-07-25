import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { CareersPageContent } from '@/components/marketing/pages/careers-page-content'
import { en } from '@/i18n/dictionaries/en'

/**
 * `/careers` — full list, NO filters/tabs (owner decision 2026-07-23, see
 * docs/design/landing-redesign.md §1 + task-landing-redesign.md AC2).
 */
export const Route = createFileRoute('/careers')({
  loader: async () => fetchVacancies('en'),
  component: CareersPage,
})

function CareersPage() {
  const vacancies = Route.useLoaderData() as PublicVacancy[]
  return <CareersPageContent vacancies={vacancies} locale="en" dict={en} />
}
