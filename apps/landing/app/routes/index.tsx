import { createFileRoute } from '@tanstack/react-router'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { HomePageContent } from '@/components/marketing/pages/home-page-content'
// Single-locale import (review round 1, HIGH-1b) — NOT the 5-locale barrel
// `@/i18n/dictionaries` — see `home-page-content.tsx`'s module doc for why.
import { en } from '@/i18n/dictionaries/en'

export const Route = createFileRoute('/')({
  loader: async () => fetchVacancies('en'),
  component: LandingPage,
})

function LandingPage() {
  const vacancies = Route.useLoaderData() as PublicVacancy[]
  return <HomePageContent vacancies={vacancies} locale="en" dict={en} />
}
