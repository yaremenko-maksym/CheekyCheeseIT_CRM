import { useLayoutEffect, useMemo, useRef } from 'react'
import { useLocation } from '@tanstack/react-router'
import { ArrowLeft, Briefcase, BarChart3, MapPin } from 'lucide-react'
import type { PublicVacancyDetail } from '@crm/shared'
import { useDocumentHead } from '@/lib/use-document-head'
import {
  buildBreadcrumbListJsonLd,
  buildHreflangAlternates,
  buildJobPostingJsonLd,
  canonicalUrl,
  markdownToPlainText,
  truncateForMetaDescription,
} from '@/lib/seo'
import {
  resolveVacancyDescription,
  resolveVacancyTitle,
  vacancyHreflangExcludes,
  type LocalizableVacancyDetailFields,
} from '@/lib/vacancy-i18n'
import { domainLabel, domainTagVariant, employmentTypeLabel } from '@/lib/vacancy-domain'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { BackLink } from '@/components/marketing/back-link'
import { MarkdownBody, markdownToHtml } from '@/components/marketing/markdown-body'
import { VacancyApplyForm } from '@/components/marketing/vacancy-apply-form'
import { Tag } from '@/components/ui/tag'
import { cn, focusRing } from '@/lib/utils'
import {
  captureMorphSource,
  playTitleMorphOverlay,
  readPendingMorph,
  validateMorphDestination,
} from '@/lib/title-morph'
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
 */
export function VacancyDetailPageContent({
  vacancy,
  slug,
  locale = DEFAULT_LOCALE,
  dict,
}: {
  vacancy: (PublicVacancyDetail & LocalizableVacancyDetailFields) | null
  /** The route's `$slug` param — passed explicitly (not re-derived from
   * `pathname`) since every locale route file owns its own `Route.useParams()`. */
  slug: string
  locale?: Locale
  dict: Dictionary
}) {
  if (!vacancy) return <NotFoundState slug={slug} locale={locale} dict={dict} />
  return <VacancyDetailContent vacancy={vacancy} locale={locale} dict={dict} />
}

function NotFoundState({ slug, locale, dict }: { slug: string; locale: Locale; dict: Dictionary }) {
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
  locale,
  dict,
}: {
  vacancy: PublicVacancyDetail & LocalizableVacancyDetailFields
  locale: Locale
  dict: Dictionary
}) {
  const t = dict
  const path = `/careers/${vacancy.slug}`
  const title = resolveVacancyTitle(vacancy, locale)
  const descriptionMd = resolveVacancyDescription(vacancy, locale)

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
  // plan §3/A10 — locales with no real translation never advertise this
  // vacancy's URL as an hreflang alternate (avoids flagging fallback/
  // duplicate content as a genuine locale variant).
  const hreflangExcludes = vacancyHreflangExcludes(vacancy)
  const localizedForJsonLd = { ...vacancy, title }

  useDocumentHead({
    // "<Job Title> — <location> | CheekyCheeseIT Careers" (owner decision
    // 2026-07-24, for queries with a location-qualified job title). Also
    // becomes the OG title via useDocumentHead's shared `title` prop.
    title: `${title} — ${vacancy.location} | ${t.vacancy.titleSuffix}`,
    description: metaDescription,
    canonical: canonicalUrl(localizedPath(locale, path)),
    htmlLang: locale,
    alternates: buildHreflangAlternates(path, hreflangExcludes),
    jsonLd: [
      buildJobPostingJsonLd(localizedForJsonLd, descriptionHtml),
      buildBreadcrumbListJsonLd(localizedForJsonLd),
    ],
  })

  // Title-morph consumer, forward direction (§M v3.2 п.5) — /careers's
  // VacancyCard <h3> "flying" into this page's <h1>. `useLayoutEffect`, not
  // `useEffect`: must run BEFORE the browser paints this route's first
  // frame, or the real <h1> would flash visible before the overlay hides it.
  // `readPendingMorph(pathname)` only actually returns a morph when THIS
  // component's own current pathname is the navigation's real destination
  // (`lib/title-morph.ts`'s addressable consume, fix for a HIGH
  // fidelity-review finding, 2026-07-25).
  //
  // `pathname` is deliberately OMITTED from the effect's dependency array —
  // same reasoning as `careers-list.tsx`'s companion consumer (see its
  // module doc): `useLocation()` is reactive and TanStack Router updates
  // `router.state.location` to the pending/target location EARLY, so
  // including it as a dep would re-run this effect on ANY global location
  // change, not just this component's own true mount — defeating the
  // addressable check entirely (a still-mounted SOURCE instance would
  // "pass" once the pending location catches up to its own destination).
  const pathname = useLocation({ select: (location) => location.pathname })
  const titleRef = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    const morph = readPendingMorph(pathname)
    const titleEl = titleRef.current
    if (!morph || !titleEl) return
    if (!validateMorphDestination(morph, vacancy.slug, titleEl)) return
    playTitleMorphOverlay(morph, titleEl)
  }, [vacancy.slug])

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <MarketingNav active="careers" locale={locale} dict={dict} path={path} />

      <main tabIndex={-1} className="flex-1 focus:outline-none">
        <div className="mx-auto max-w-[1200px] px-5 pt-8 pb-5 md:px-10 lg:px-14">
          <BackLink
            to={careersRoutePath(locale)}
            onClick={() => {
              if (titleRef.current) captureMorphSource(titleRef.current, vacancy.slug)
            }}
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
          <h1
            ref={titleRef}
            data-vacancy-morph-slug={vacancy.slug}
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

        <div className="mx-auto max-w-[1200px] px-5 pt-12 pb-24 md:px-10 lg:px-14">
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
      </main>

      <MarketingFooter locale={locale} dict={dict} path={path} />
    </div>
  )
}
