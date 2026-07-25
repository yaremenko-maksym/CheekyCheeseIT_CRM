import { createFileRoute } from '@tanstack/react-router'
import { fetchVacancy, fetchVacancyHreflangExcludes } from '@/lib/api'
import { VacancyDetailPageContent } from '@/components/marketing/pages/vacancy-detail-page-content'
import { en } from '@/i18n/dictionaries/en'

/**
 * `/careers/:slug` — vacancy detail + apply form (landing-redesign.md §1,
 * §6.6). `fetchVacancy` returns `null` for the API's 404/410 (DRAFT/CLOSED/
 * missing — see that function's doc) — rendered as a friendly "Role not
 * found" state, never a raw browser 404 (docs/design/landing-redesign.md §8).
 *
 * `hreflangExcludes` — even though `en` itself is never a fallback, its OWN
 * alternates cluster must still OMIT any OTHER locale that IS a fallback for
 * this vacancy (plan §3/A10) — see `lib/api.ts`
 * `fetchVacancyHreflangExcludes()` module doc for why this needs its own
 * request alongside the main `fetchVacancy` call (round-4 "дорезка").
 */
export const Route = createFileRoute('/careers_/$slug')({
  loader: async ({ params }) => {
    const [vacancy, hreflangExcludes] = await Promise.all([
      fetchVacancy(params.slug, 'en'),
      fetchVacancyHreflangExcludes(params.slug),
    ])
    return { vacancy, hreflangExcludes }
  },
  component: VacancyDetailPage,
})

function VacancyDetailPage() {
  const { vacancy, hreflangExcludes } = Route.useLoaderData()
  const { slug } = Route.useParams()
  return (
    <VacancyDetailPageContent
      vacancy={vacancy}
      hreflangExcludes={hreflangExcludes}
      slug={slug}
      locale="en"
      dict={en}
    />
  )
}
