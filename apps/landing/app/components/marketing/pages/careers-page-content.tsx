import type { PublicVacancy } from '@crm/shared'
import { useDocumentHead } from '@/lib/use-document-head'
import { buildHreflangAlternates, buildItemListJsonLd, canonicalUrl } from '@/lib/seo'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { HiringStrip } from '@/components/marketing/hiring-strip'
import { SectionEyebrow } from '@/components/marketing/section-eyebrow'
import { CareersList } from '@/components/marketing/careers-list'
import { DEFAULT_LOCALE, localizedPath, type Locale } from '@/i18n/locale'
import type { Dictionary } from '@/i18n/dictionary'

/** Locale-agnostic path of this page — see `home-page-content.tsx`'s `PATH` doc. */
const PATH = '/careers'

/**
 * `/careers` content — extracted from `routes/careers.tsx` so the SAME tree
 * renders under every locale route file (task-landing-i18n.md). NO filters/
 * tabs (owner decision 2026-07-23, see task-landing-redesign.md AC2).
 *
 * `dict` (required — review round 1, HIGH-1b) — see
 * `home-page-content.tsx`'s module doc for the code-splitting rationale.
 */
export function CareersPageContent({
  vacancies,
  locale = DEFAULT_LOCALE,
  dict,
}: {
  vacancies: PublicVacancy[]
  locale?: Locale
  dict: Dictionary
}) {
  const t = dict

  useDocumentHead({
    title: t.careers.seoTitle,
    description: t.careers.seoDescription,
    canonical: canonicalUrl(localizedPath(locale, PATH)),
    htmlLang: locale,
    alternates: buildHreflangAlternates(PATH),
    // ItemList only when there's something to list — an empty one has
    // nothing useful to tell a crawler (owner decision 2026-07-24).
    jsonLd: vacancies.length > 0 ? buildItemListJsonLd(vacancies) : undefined,
  })

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <HiringStrip count={vacancies.length} locale={locale} dict={dict} />
      <MarketingNav active="careers" locale={locale} dict={dict} path={PATH} />

      {/* `tabIndex={-1}` — programmatic focus target after a client-side
          navigation (WCAG 2.4.3) — `__root.tsx` moves focus here once the
          route resolves. */}
      <main tabIndex={-1} className="flex-1 focus:outline-none">
        <section className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(55%_60%_at_80%_10%,color-mix(in_oklch,var(--primary)_11%,transparent),transparent_70%)]"
          />
          <div className="relative mx-auto max-w-[1200px] px-5 pt-14 pb-11 md:px-10 lg:px-14">
            <SectionEyebrow className="mb-[22px]">{t.careers.eyebrow}</SectionEyebrow>
            <h1 className="mb-5 max-w-[15ch] text-[clamp(2.2rem,6.5vw,4rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance text-foreground">
              {t.careers.h1}
            </h1>
            <p className="max-w-[52ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
              {t.careers.p1}
            </p>
            {/* owner decision 2026-07-24: natural, non-spammy SEO copy in the
                existing lead block (no new visual section) — "remote IT jobs" /
                "senior engineering roles" for title-bearing search queries. */}
            <p className="mt-4 max-w-[52ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
              {t.careers.p2}
            </p>
          </div>
        </section>

        <div className="mx-auto max-w-[1200px] px-5 pb-24 md:px-10 lg:px-14">
          <div className="mb-10 border-t border-border" />
          <CareersList vacancies={vacancies} locale={locale} dict={dict} />
        </div>
      </main>

      <MarketingFooter locale={locale} dict={dict} path={PATH} />
    </div>
  )
}
