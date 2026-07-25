import { useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { m, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { ArrowRight, Mail } from 'lucide-react'
import type { PublicVacancy } from '@crm/shared'
import { useDocumentHead } from '@/lib/use-document-head'
import {
  buildHreflangAlternates,
  buildOrganizationJsonLd,
  buildWebSiteJsonLd,
  canonicalUrl,
} from '@/lib/seo'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { Terminal } from '@/components/marketing/terminal'
import { SectionEyebrow } from '@/components/marketing/section-eyebrow'
import { StatStrip } from '@/components/marketing/stat-strip'
import { CaseStudyCard } from '@/components/marketing/case-study-card'
import { ServiceCard } from '@/components/marketing/service-card'
import { ProcessStepsGrid } from '@/components/marketing/process-steps-grid'
import { TechStackChips } from '@/components/marketing/tech-stack-chips'
import { CareersTeaser } from '@/components/marketing/careers-teaser'
import { ScrollReveal } from '@/components/marketing/scroll-reveal'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useCoarsePointer } from '@/lib/use-coarse-pointer'
import { techStack, CONTACT_EMAIL } from '@/content/home'
import { DEFAULT_LOCALE, localizedPath, type Locale } from '@/i18n/locale'
import type { Dictionary } from '@/i18n/dictionary'
import { careersRoutePath } from '@/i18n/routes'

/** Locale-agnostic path of this page — fed to `buildHreflangAlternates` AND threaded to `<MarketingNav>`/`<MarketingFooter>`'s language switcher (review round 1, HIGH-3). */
const PATH = '/'

/**
 * `/` (Home) content — extracted verbatim from `routes/index.tsx` so the
 * SAME JSX/motion tree renders under every locale route file
 * (`routes/index.tsx` (en), `routes/uk.tsx`, `routes/ru.tsx`,
 * `routes/es.tsx`, `routes/pt.tsx`), each passing its own hardcoded
 * `locale` — task-landing-i18n.md. All translatable copy comes from
 * `dict.home`; motion/layout/structure is untouched (no regression to
 * §M v3 lift/morph/scroll-reveal effects).
 *
 * `dict` (required — review round 1, HIGH-1b) is imported by the CALLING
 * route file directly from `i18n/dictionaries/<locale>` (a single-locale
 * module, not the 5-locale barrel `i18n/dictionaries/index.ts`) — every
 * route's own lazy chunk (`autoCodeSplitting`, `vite.config.ts`) then only
 * ever bundles the ONE dictionary it actually needs. Looking it up here via
 * `getDictionary(locale)` would statically re-import the shared barrel
 * (all 5 locales) into every route's chunk regardless of which locale that
 * route serves — the root cause of the Lighthouse mobile performance
 * regression this review round fixed.
 */
export function HomePageContent({
  vacancies,
  locale = DEFAULT_LOCALE,
  dict,
}: {
  vacancies: PublicVacancy[]
  locale?: Locale
  dict: Dictionary
}) {
  const t = dict.home
  const heroRef = useRef<HTMLElement>(null)
  const reducedMotion = useReducedMotion()
  const coarsePointer = useCoarsePointer()
  // Hero glow + terminal "docking" (§M.1.1) — the ONLY parallax allowed
  // inside the hero: it's an EXIT effect (fires as the visitor scrolls PAST
  // the hero), not an entrance — the hero itself stays visible immediately,
  // no scroll-reveal (§5.1 contract, unchanged). §M v3.3 п.2 — touch merges
  // into the SAME static fallback as reduced-motion below (ambient effect,
  // no natural one-shot equivalent).
  const { scrollYProgress: heroProgress } = useScroll({
    target: heroRef,
    offset: ['start start', 'end start'],
  })
  const glowY = useTransform(heroProgress, [0, 1], [0, 60])
  const terminalY = useTransform(heroProgress, [0, 1], [0, -36])
  const terminalScale = useTransform(heroProgress, [0, 1], [1, 0.965])
  const terminalOpacity = useTransform(heroProgress, [0, 0.7, 1], [1, 1, 0.85])

  useDocumentHead({
    title: t.seoTitle,
    description: t.seoDescription,
    canonical: canonicalUrl(localizedPath(locale, PATH)),
    htmlLang: locale,
    alternates: buildHreflangAlternates(PATH),
    jsonLd: [buildOrganizationJsonLd(), buildWebSiteJsonLd()],
  })

  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingNav locale={locale} dict={dict} path={PATH} />

      {/* `tabIndex={-1}` + `focus:outline-none` — programmatic focus target
          for page-transitions (§M v3.1 step 7, WCAG 2.4.3): __root.tsx moves
          focus here after a client-side navigation resolves so keyboard/AT
          users learn the page changed, without a distracting full-page ring
          on an element that isn't otherwise interactive. */}
      <main tabIndex={-1} className="focus:outline-none">
        {/* ── Hero — always visible, no scroll-reveal (§5.1) ─────────────── */}
        <section id="hero" ref={heroRef} className="relative overflow-hidden">
          {!reducedMotion && !coarsePointer ? (
            // `m.div` (perf round, PR #421 orchestrator finding) — see
            // __root.tsx's module doc.
            <m.div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_78%_20%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_70%)]"
              style={{ y: glowY }}
            />
          ) : (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_78%_20%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_70%)]"
            />
          )}
          <div className="relative mx-auto grid max-w-[1200px] grid-cols-1 items-center gap-10 px-5 pt-16 pb-[84px] md:px-10 lg:grid-cols-[1.02fr_1fr] lg:gap-14 lg:px-14">
            <div>
              <Chip className="mb-6 py-1.5 text-[0.8rem] font-mono">{t.heroChip}</Chip>
              <h1 className="mb-[22px] text-[clamp(2.35rem,8vw,5rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance text-foreground">
                {t.heroH1Line1}
                <br />
                <span className="text-primary">{t.heroH1Highlight}</span>
              </h1>
              <p className="mb-[34px] max-w-[46ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
                {t.heroParagraph}
              </p>
              <div className="flex flex-col gap-3 min-[460px]:flex-row min-[460px]:flex-wrap">
                <Button asChild size="lg">
                  <a href={`mailto:${CONTACT_EMAIL}`}>
                    {t.ctaStartProject}
                    <ArrowRight aria-hidden="true" />
                  </a>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link to={careersRoutePath(locale)}>{t.ctaSeeRoles}</Link>
                </Button>
              </div>
            </div>
            {!reducedMotion && !coarsePointer ? (
              // `m.div` (perf round, PR #421 orchestrator finding) — see
              // __root.tsx's module doc.
              <m.div
                className="min-w-0"
                style={{ y: terminalY, scale: terminalScale, opacity: terminalOpacity }}
              >
                <Terminal ariaLabel={t.terminalAriaLabel} />
              </m.div>
            ) : (
              <div className="min-w-0">
                <Terminal ariaLabel={t.terminalAriaLabel} />
              </div>
            )}
          </div>
        </section>

        <hr className="h-px border-0 bg-border" />

        {/* ── About ────────────────────────────────────────────────────────── */}
        {/* `scroll-mt-[82px]` (= HEADER_OFFSET in lib/smooth-scroll.ts) — the
            router's OWN native `scrollIntoView` landing for a cross-page hash
            link (`hashScrollIntoView` stays default `true` there, §M.4)
            otherwise aligns the section flush with the viewport top, hidden
            under the sticky header. Same-page navigation is unaffected —
            `smoothScrollToId` computes its own explicit offset, independent
            of this CSS property. */}
        <section id="about" className="scroll-mt-[82px] px-5 py-18 md:px-10 md:py-26 lg:px-14">
          <div className="mx-auto max-w-[1200px]">
            <div className="grid grid-cols-1 items-start gap-9 min-[900px]:grid-cols-[0.85fr_1.15fr] min-[900px]:gap-14">
              <ScrollReveal>
                <SectionEyebrow className="mb-5">{t.aboutEyebrow}</SectionEyebrow>
                <h2 className="text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
                  {t.aboutH2Line1}
                  <br />
                  {t.aboutH2Line2}
                </h2>
              </ScrollReveal>
              <ScrollReveal revealAt={0.68}>
                <p className="mb-5 text-[1.12rem] leading-[1.65] text-pretty text-muted-foreground">
                  {t.aboutP1}
                </p>
                <p className="mb-8 leading-[1.65] text-pretty text-muted-foreground">{t.aboutP2}</p>
                <div className="grid grid-cols-2 gap-4">
                  {t.aboutBullets.map((bullet) => (
                    <div key={bullet} className="flex items-start gap-2.5">
                      <span aria-hidden="true" className="mt-0.5 text-primary">
                        ●
                      </span>
                      <span className="text-[0.98rem] text-foreground">{bullet}</span>
                    </div>
                  ))}
                </div>
              </ScrollReveal>
            </div>
            <ScrollReveal className="mt-16 border-t border-border pt-11">
              <StatStrip stats={t.stats} />
            </ScrollReveal>
          </div>
        </section>

        <hr className="h-px border-0 bg-border" />

        {/* ── Selected work ────────────────────────────────────────────────── */}
        <section id="work" className="scroll-mt-[82px] px-5 py-18 md:px-10 md:py-26 lg:px-14">
          <div className="mx-auto max-w-[1200px]">
            <ScrollReveal className="mb-[52px] max-w-[640px]">
              <SectionEyebrow className="mb-5">{t.workEyebrow}</SectionEyebrow>
              <h2 className="mb-4 text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
                {t.workH2}
              </h2>
              <p className="max-w-[52ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
                {t.workP}
              </p>
            </ScrollReveal>
            <div className="flex flex-col gap-[22px]">
              {t.caseStudies.map((study, i) => (
                <ScrollReveal key={study.title} revealAt={0.6 + i * 0.05}>
                  <CaseStudyCard
                    study={study}
                    challengeLabel={t.challengeLabel}
                    solutionLabel={t.solutionLabel}
                  />
                </ScrollReveal>
              ))}
            </div>
          </div>
        </section>

        <hr className="h-px border-0 bg-border" />

        {/* ── Services ─────────────────────────────────────────────────────── */}
        <section id="services" className="scroll-mt-[82px] px-5 py-18 md:px-10 md:py-26 lg:px-14">
          <div className="mx-auto max-w-[1200px]">
            <ScrollReveal className="mb-[52px] max-w-[640px]">
              <SectionEyebrow className="mb-5">{t.servicesEyebrow}</SectionEyebrow>
              <h2 className="mb-4 text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
                {t.servicesH2Line1}
                <br />
                {t.servicesH2Line2}
              </h2>
              <p className="max-w-[52ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
                {t.servicesP}
              </p>
            </ScrollReveal>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-3 md:gap-7">
              {t.services.map((service, i) => (
                <ScrollReveal key={service.title} revealAt={0.6 + i * 0.05}>
                  <ServiceCard service={service} />
                </ScrollReveal>
              ))}
            </div>
          </div>
        </section>

        <hr className="h-px border-0 bg-border" />

        {/* ── How we work ──────────────────────────────────────────────────── */}
        <section id="process" className="scroll-mt-[82px] px-5 py-18 md:px-10 md:py-26 lg:px-14">
          <div className="mx-auto max-w-[1200px]">
            <ScrollReveal className="mb-[52px] max-w-[640px]">
              <SectionEyebrow className="mb-5">{t.processEyebrow}</SectionEyebrow>
              <h2 className="text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
                {t.processH2Line1}
                <br />
                {t.processH2Line2}
              </h2>
            </ScrollReveal>
            <ScrollReveal>
              <ProcessStepsGrid steps={t.processSteps} />
            </ScrollReveal>
          </div>
        </section>

        <hr className="h-px border-0 bg-border" />

        {/* ── Tech stack ───────────────────────────────────────────────────── */}
        <section className="px-5 py-18 md:px-10 md:py-26 lg:px-14">
          <div className="mx-auto max-w-[1200px]">
            <ScrollReveal className="mb-10 max-w-[640px]">
              <SectionEyebrow className="mb-5">{t.techStackEyebrow}</SectionEyebrow>
              <h2 className="text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
                {t.techStackH2}
              </h2>
            </ScrollReveal>
            <ScrollReveal>
              <TechStackChips stack={techStack} />
            </ScrollReveal>
          </div>
        </section>

        <hr className="h-px border-0 bg-border" />

        {/* ── Careers teaser ───────────────────────────────────────────────── */}
        <section id="careers" className="scroll-mt-[82px] px-5 py-18 md:px-10 md:py-26 lg:px-14">
          <div className="mx-auto max-w-[1200px]">
            <ScrollReveal className="mb-11 flex flex-wrap items-end justify-between gap-5">
              <div className="max-w-[560px]">
                <SectionEyebrow className="mb-5">{t.careersEyebrow}</SectionEyebrow>
                <h2 className="mb-4 text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
                  {t.careersH2}
                </h2>
                <p className="max-w-[48ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
                  {t.careersP}
                </p>
              </div>
              <Button asChild variant="outline">
                <Link to={careersRoutePath(locale)}>
                  {t.viewAllRoles}
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              </Button>
            </ScrollReveal>

            <ScrollReveal>
              <CareersTeaser vacancies={vacancies} locale={locale} dict={dict} />
            </ScrollReveal>
          </div>
        </section>

        <hr className="h-px border-0 bg-border" />

        {/* ── Contact ──────────────────────────────────────────────────────── */}
        <section id="contact" className="scroll-mt-[82px] px-5 py-22 md:px-10 md:py-32 lg:px-14">
          <div className="mx-auto max-w-[1200px]">
            <ScrollReveal className="relative overflow-hidden rounded-2xl border border-border bg-card p-7 py-16 text-center">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_120%_at_50%_0%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_65%)]"
              />
              <div className="relative">
                <h2 className="mx-auto mb-[18px] max-w-[18ch] text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
                  {t.contactH2}
                </h2>
                <p className="mx-auto mb-8 max-w-[46ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
                  {t.contactP}
                </p>
                <div className="flex flex-col justify-center gap-3 min-[460px]:flex-row min-[460px]:flex-wrap">
                  <Button asChild size="lg">
                    <a href={`mailto:${CONTACT_EMAIL}`}>
                      {t.ctaStartProject}
                      <ArrowRight aria-hidden="true" />
                    </a>
                  </Button>
                  <Button asChild size="lg" variant="outline">
                    <a href={`mailto:${CONTACT_EMAIL}`}>
                      <Mail aria-hidden="true" className="size-4" />
                      {CONTACT_EMAIL}
                    </a>
                  </Button>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </section>
      </main>

      <MarketingFooter locale={locale} dict={dict} path={PATH} />
    </div>
  )
}
