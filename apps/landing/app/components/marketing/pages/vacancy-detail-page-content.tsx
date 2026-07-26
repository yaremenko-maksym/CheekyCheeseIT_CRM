import { useMemo } from 'react'
import { ArrowLeft, Briefcase, BarChart3, MapPin } from 'lucide-react'
import type { PublicVacancyDetail } from '@crm/shared'
import { useDocumentHead } from '@/lib/use-document-head'
import {
  buildBreadcrumbListJsonLd,
  buildFAQPageJsonLd,
  buildHreflangAlternates,
  buildJobPostingJsonLd,
  canonicalUrl,
  markdownToPlainText,
  truncateForMetaDescription,
} from '@/lib/seo'
import { domainLabel, domainTagVariant, employmentTypeLabel } from '@/lib/vacancy-domain'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { HiringStrip } from '@/components/marketing/hiring-strip'
import { BackLink } from '@/components/marketing/back-link'
import { MarkdownBody, markdownToHtml } from '@/components/marketing/markdown-body'
import { VacancyApplyForm } from '@/components/marketing/vacancy-apply-form'
import { VacancyCard } from '@/components/marketing/vacancy-card'
import { Tag } from '@/components/ui/tag'
import { cn, focusRing } from '@/lib/utils'
import { DEFAULT_LOCALE, localizedPath, type Locale } from '@/i18n/locale'
import type { Dictionary } from '@/i18n/dictionary'
import { careersRoutePath } from '@/i18n/routes'

/**
 * `/careers/:slug` content — extracted from `routes/careers_.$slug.tsx` so
 * the SAME tree renders under every locale route file (task-landing-i18n.md).
 * `vacancy === null` renders the localized "Role not found" empty state
 * (docs/design/landing-redesign.md §8), never a raw browser 404.
 *
 * `dict` (required — review round 1, HIGH-1b) — see
 * `home-page-content.tsx`'s module doc for the code-splitting rationale.
 *
 * `hreflangExcludes` (round-4 "дорезка") — the route loader's OWN resolved
 * result from `lib/api.ts` `fetchVacancyHreflangExcludes(slug)`, passed down
 * rather than computed here — see that function's module doc for why it
 * needs its own multi-request round trip the vacancy DETAIL fetch alone
 * cannot answer.
 */
export function VacancyDetailPageContent({
  vacancy,
  hreflangExcludes,
  slug,
  vacancyCount,
  locale = DEFAULT_LOCALE,
  dict,
}: {
  vacancy: PublicVacancyDetail | null
  hreflangExcludes: Locale[]
  /** The route's `$slug` param — passed explicitly (not re-derived from
   * `pathname`) since every locale route file owns its own `Route.useParams()`. */
  slug: string
  /**
   * Total PUBLISHED vacancy count for THIS locale — task-landing-contact-
   * and-hiring-strip.md Часть B (`<HiringStrip>`). Fetched by the route
   * loader alongside `vacancy`/`hreflangExcludes` (see `routes/careers_.
   * $slug.tsx` — a SEPARATE `fetchVacancies(locale)` call, this detail route
   * otherwise never needs the full list). Defaults to `0` (strip hidden) so
   * existing callers/tests that don't pass it keep working.
   */
  vacancyCount?: number
  locale?: Locale
  dict: Dictionary
}) {
  const count = vacancyCount ?? 0
  if (!vacancy) return <NotFoundState slug={slug} vacancyCount={count} locale={locale} dict={dict} />
  return (
    <VacancyDetailContent
      vacancy={vacancy}
      hreflangExcludes={hreflangExcludes}
      vacancyCount={count}
      locale={locale}
      dict={dict}
    />
  )
}

function NotFoundState({
  slug,
  vacancyCount,
  locale,
  dict,
}: {
  slug: string
  vacancyCount: number
  locale: Locale
  dict: Dictionary
}) {
  const t = dict
  const path = `/careers/${slug}`
  useDocumentHead({
    title: t.vacancy.notFoundSeoTitle,
    description: t.vacancy.notFoundSeoDescription,
    canonical: canonicalUrl(localizedPath(locale, path)),
    htmlLang: locale,
    // Soft-404 (DRAFT/CLOSED/missing slug, see module doc) — never index,
    // so no hreflang cluster either (nothing to advertise as an alternate).
    noindex: true,
  })
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <HiringStrip count={vacancyCount} locale={locale} dict={dict} />
      <MarketingNav active="careers" locale={locale} dict={dict} path={path} />
      <main
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-5 py-24 text-center focus:outline-none"
      >
        <div>
          <h1 className="mb-3 text-[1.6rem] font-semibold tracking-[-0.015em] text-foreground">
            {t.vacancy.notFoundH1}
          </h1>
          <p className="mb-6 text-muted-foreground">{t.vacancy.notFoundBody}</p>
          <BackLink
            to={careersRoutePath(locale)}
            className={cn('inline-flex items-center gap-2 font-medium text-primary', focusRing)}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            {t.vacancy.backToCareers}
          </BackLink>
        </div>
      </main>
      <MarketingFooter locale={locale} dict={dict} path={path} />
    </div>
  )
}

function VacancyDetailContent({
  vacancy,
  hreflangExcludes,
  vacancyCount,
  locale,
  dict,
}: {
  vacancy: PublicVacancyDetail
  hreflangExcludes: Locale[]
  vacancyCount: number
  locale: Locale
  dict: Dictionary
}) {
  const t = dict
  const path = `/careers/${vacancy.slug}`
  // `vacancy.title`/`descriptionMd` are ALREADY the correct locale's copy —
  // `PublicVacancyDetail` resolves them SERVER-SIDE per `?locale=`
  // (`VacanciesService.resolveLocalized`, task-landing-i18n.md round-4); no
  // client-side re-resolution needed any more (was `resolveVacancyTitle`/
  // `resolveVacancyDescription` against a locally-mocked `translations`
  // object, pre-Block-C).
  const title = vacancy.title
  const descriptionMd = vacancy.descriptionMd

  // Same markdown renderer/plugins as the visible <MarkdownBody> below,
  // rendered to a clean (no wrapper/Tailwind classes) HTML string — feeds
  // the JobPosting JSON-LD's full `description` (owner decision 2026-07-24:
  // Google wants the complete posting text, not a truncated snippet) so it
  // can never drift from what a visitor actually sees. Memoized:
  // `markdownToHtml` re-walks the whole markdown tree, not worth repeating
  // on unrelated re-renders.
  const descriptionHtml = useMemo(() => markdownToHtml(descriptionMd), [descriptionMd])
  // Plain-text (not raw Markdown) excerpt of the REAL description, per owner
  // decision 2026-07-24 — was a hand-synthesized sentence; title-bearing
  // search queries rank better against a snippet of the actual posting.
  const metaDescription = truncateForMetaDescription(markdownToPlainText(descriptionMd))

  useDocumentHead({
    // "<Job Title> — <location> | CheekyCheeseIT Careers" (owner decision
    // 2026-07-24, for queries with a location-qualified job title). Also
    // becomes the OG title via useDocumentHead's shared `title` prop.
    title: `${title} — ${vacancy.location} | ${t.vacancy.titleSuffix}`,
    description: metaDescription,
    canonical: canonicalUrl(localizedPath(locale, path)),
    htmlLang: locale,
    // plan §3/A10, round-4 — locales with no real translation never
    // advertise this vacancy's URL as an hreflang alternate (avoids
    // flagging fallback/duplicate content as a genuine locale variant);
    // `hreflangExcludes` is the route loader's own resolved result (see
    // this component's module doc), not computed here.
    alternates: buildHreflangAlternates(path, hreflangExcludes),
    // task-vacancy-i18n-jobposting C6 — FAQPage JSON-LD, localized to this
    // page's own locale (round-4 "дорезка"; generic per-locale content, not
    // vacancy-specific, so it takes no `vacancy` argument — see `lib/seo.ts`
    // `buildFAQPageJsonLd`).
    jsonLd: [
      buildJobPostingJsonLd(vacancy, descriptionHtml),
      buildBreadcrumbListJsonLd(vacancy),
      buildFAQPageJsonLd(locale),
    ],
  })

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <HiringStrip count={vacancyCount} locale={locale} dict={dict} />
      <MarketingNav active="careers" locale={locale} dict={dict} path={path} />

      <main tabIndex={-1} className="flex-1 focus:outline-none">
        <div className="mx-auto max-w-[1200px] px-5 pt-8 pb-5 md:px-10 lg:px-14">
          <BackLink
            to={careersRoutePath(locale)}
            className={cn('inline-flex items-center gap-2 text-muted-foreground', focusRing)}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            {t.vacancy.allRoles}
          </BackLink>
        </div>

        <div className="mx-auto max-w-[1200px] border-b border-border px-5 pb-9 md:px-10 lg:px-14">
          <Tag variant={domainTagVariant(vacancy.domain)} className="mb-[18px]">
            {domainLabel(vacancy.domain, t.vacancy)}
          </Tag>
          {/* `data-vacancy-slug` — E2E-only marker (apps/e2e/tests/landing/
              i18n.spec.ts "orchestrator finding" block): an unambiguous "this
              is the DETAIL page's own heading" signal the home page's h1
              never carries, proving the body content — not just the head's
              `<link rel="canonical">` — actually rendered the detail page.
              No runtime consumer (task-landing-remove-page-transitions.md
              removed the title-morph feature this attribute used to serve). */}
          <h1
            data-vacancy-slug={vacancy.slug}
            className="mb-[22px] max-w-[18ch] text-[clamp(2rem,5.5vw,3.4rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance text-foreground"
          >
            {title}
          </h1>
          <div className="flex flex-wrap gap-2.5">
            <Tag variant="neutral">
              <BarChart3 aria-hidden="true" className="size-3.5" />
              {vacancy.seniority}
            </Tag>
            <Tag variant="neutral">
              <Briefcase aria-hidden="true" className="size-3.5" />
              {employmentTypeLabel(vacancy.employmentType, t.vacancy)}
            </Tag>
            <Tag variant="neutral">
              <MapPin aria-hidden="true" className="size-3.5" />
              {vacancy.location}
            </Tag>
          </div>
        </div>

        <div
          className={cn(
            'mx-auto max-w-[1200px] px-5 pt-12 md:px-10 lg:px-14',
            vacancy.relatedVacancies.length > 0 ? 'pb-16 md:pb-20' : 'pb-24',
          )}
        >
          <div className="grid grid-cols-1 items-start gap-10 min-[1000px]:grid-cols-[1.35fr_1fr] min-[1000px]:gap-14">
            <MarkdownBody markdown={descriptionMd} />
            <aside>
              <div className="static min-[1000px]:sticky min-[1000px]:top-[90px]">
                <VacancyApplyForm
                  slug={vacancy.slug}
                  vacancyTitle={title}
                  locale={locale}
                  dict={dict}
                />
              </div>
            </aside>
          </div>
        </div>

        {/* "Похожие вакансии" (task-vacancy-i18n-jobposting C8, round-4
            "дорезка") — up to 3 other PUBLISHED roles in the same domain,
            already resolved + locale-localized server-side
            (`VacanciesService.findRelated` + `mapPublic`, same `isFallback`/
            title-resolution contract as the main vacancy). Reuses
            `VacancyCard` (the SAME component `/careers` and the Home teaser
            render) rather than a bespoke list — one visual language for
            "here's a vacancy" everywhere on the site, not two. */}
        {vacancy.relatedVacancies.length > 0 && (
          <div className="mx-auto max-w-[1200px] px-5 pt-9 pb-24 md:px-10 lg:px-14">
            <h2 className="mb-6 text-[clamp(1.5rem,3vw,1.9rem)] leading-[1.1] font-semibold tracking-[-0.02em] text-foreground">
              {t.vacancy.relatedHeading}
            </h2>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
              {vacancy.relatedVacancies.map((related) => (
                <VacancyCard key={related.slug} vacancy={related} locale={locale} dict={dict} />
              ))}
            </div>
          </div>
        )}
      </main>

      <MarketingFooter locale={locale} dict={dict} path={path} />
    </div>
  )
}
