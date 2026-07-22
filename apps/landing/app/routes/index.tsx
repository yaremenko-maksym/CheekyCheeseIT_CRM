import type { ReactNode } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, FolderOpen, Mail } from 'lucide-react'
import type { PublicVacancy } from '@crm/shared'
import { fetchVacancies } from '@/lib/api'
import { useDocumentHead } from '@/lib/use-document-head'
import { MarketingNav } from '@/components/marketing/nav'
import { MarketingFooter } from '@/components/marketing/footer'
import { Terminal } from '@/components/marketing/terminal'
import { SectionEyebrow } from '@/components/marketing/section-eyebrow'
import { StatStrip } from '@/components/marketing/stat-strip'
import { CaseStudyCard } from '@/components/marketing/case-study-card'
import { ServiceCard } from '@/components/marketing/service-card'
import { ProcessStep } from '@/components/marketing/process-step'
import { TechStackChips } from '@/components/marketing/tech-stack-chips'
import { VacancyCard } from '@/components/marketing/vacancy-card'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { caseStudies } from '@/content/case-studies'
import {
  CONTACT_EMAIL,
  HOME_CAREERS_TEASER_LIMIT,
  aboutBullets,
  processSteps,
  services,
  stats,
  techStack,
} from '@/content/home'

export const Route = createFileRoute('/')({
  loader: async () => fetchVacancies(),
  component: LandingPage,
})

/** Scroll-reveal wrapper (landing-redesign.md §5.1) — no-op above the fold; skipped entirely under reduced motion. */
function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  const reduced = useReducedMotion()
  if (reduced) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 22 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-8% 0px' }}
      transition={{ duration: 0.7, ease: [0.2, 0.6, 0.2, 1], delay }}
    >
      {children}
    </motion.div>
  )
}

function LandingPage() {
  const vacancies = Route.useLoaderData() as PublicVacancy[]
  const teaserVacancies = vacancies.slice(0, HOME_CAREERS_TEASER_LIMIT)

  useDocumentHead({
    title: 'CheekyCheeseIT — Senior engineering studio for AI, EdTech & E-Commerce',
    description:
      'A senior-only engineering studio for international product companies. From model to storefront — we ship the hard parts, on your timezone.',
  })

  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingNav />

      {/* ── Hero — always visible, no scroll-reveal (§5.1) ─────────────────── */}
      <section id="hero" className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_78%_20%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_70%)]"
        />
        <div className="relative mx-auto grid max-w-[1200px] grid-cols-1 items-center gap-10 px-5 pt-16 pb-[84px] md:px-10 lg:grid-cols-[1.02fr_1fr] lg:gap-14 lg:px-14">
          <div>
            <Chip className="mb-6 py-1.5 text-[0.8rem] font-mono">
              Outsource &amp; outstaffing · AI · EdTech · E-Commerce
            </Chip>
            <h1 className="mb-[22px] text-[clamp(2.35rem,8vw,5rem)] leading-[1.02] font-semibold tracking-[-0.03em] text-balance text-foreground">
              We build products
              <br />
              that <span className="text-primary">scale.</span>
            </h1>
            <p className="mb-[34px] max-w-[46ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
              A senior-only engineering studio for international product companies. From model to
              storefront — we ship the hard parts, on your timezone.
            </p>
            <div className="flex flex-col gap-3 min-[460px]:flex-row min-[460px]:flex-wrap">
              <Button asChild size="lg">
                <a href={`mailto:${CONTACT_EMAIL}`}>
                  Start a project
                  <ArrowRight aria-hidden="true" />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/careers">See open roles</Link>
              </Button>
            </div>
          </div>
          <div className="min-w-0">
            <Terminal />
          </div>
        </div>
      </section>

      <hr className="h-px border-0 bg-border" />

      {/* ── About ────────────────────────────────────────────────────────── */}
      <section id="about" className="px-5 py-18 md:px-10 md:py-26 lg:px-14">
        <div className="mx-auto max-w-[1200px]">
          <div className="grid grid-cols-1 items-start gap-9 min-[900px]:grid-cols-[0.85fr_1.15fr] min-[900px]:gap-14">
            <Reveal>
              <SectionEyebrow className="mb-5">About us</SectionEyebrow>
              <h2 className="text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
                Small teams,
                <br />
                senior hands.
              </h2>
            </Reveal>
            <Reveal delay={0.08}>
              <p className="mb-5 text-[1.12rem] leading-[1.65] text-pretty text-muted-foreground">
                We&rsquo;re an IT studio that plugs into product companies as an extension of their
                team — or takes a mandate end to end. No layers, no juniors learning on your budget.
              </p>
              <p className="mb-8 leading-[1.65] text-pretty text-muted-foreground">
                Our approach is deliberately narrow: three domains we know cold, senior engineers
                who own outcomes, and weekly shipping so you always see progress. We stay quietly in
                the background of great products.
              </p>
              <div className="grid grid-cols-2 gap-4">
                {aboutBullets.map((bullet) => (
                  <div key={bullet} className="flex items-start gap-2.5">
                    <span aria-hidden="true" className="mt-0.5 text-primary">
                      ●
                    </span>
                    <span className="text-[0.98rem] text-foreground">{bullet}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
          <Reveal className="mt-16 border-t border-border pt-11">
            <StatStrip stats={stats} />
          </Reveal>
        </div>
      </section>

      <hr className="h-px border-0 bg-border" />

      {/* ── Selected work ────────────────────────────────────────────────── */}
      <section id="work" className="px-5 py-18 md:px-10 md:py-26 lg:px-14">
        <div className="mx-auto max-w-[1200px]">
          <Reveal className="mb-[52px] max-w-[640px]">
            <SectionEyebrow className="mb-5">Selected work</SectionEyebrow>
            <h2 className="mb-4 text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
              Anonymised, but real.
            </h2>
            <p className="max-w-[52ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
              Under NDA we can&rsquo;t name names — but the problems, the builds and the numbers are
              exactly as they happened.
            </p>
          </Reveal>
          <div className="flex flex-col gap-[22px]">
            {caseStudies.map((study, i) => (
              <Reveal key={study.title} delay={i * 0.05}>
                <CaseStudyCard study={study} />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <hr className="h-px border-0 bg-border" />

      {/* ── Services ─────────────────────────────────────────────────────── */}
      <section id="services" className="px-5 py-18 md:px-10 md:py-26 lg:px-14">
        <div className="mx-auto max-w-[1200px]">
          <Reveal className="mb-[52px] max-w-[640px]">
            <SectionEyebrow className="mb-5">Services</SectionEyebrow>
            <h2 className="mb-4 text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
              Three domains,
              <br />
              learned the hard way.
            </h2>
            <p className="max-w-[52ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
              We go deep, not wide. Every engineer here has shipped production systems in the domain
              they work.
            </p>
          </Reveal>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3 md:gap-7">
            {services.map((service, i) => (
              <Reveal key={service.title} delay={i * 0.1}>
                <ServiceCard service={service} />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <hr className="h-px border-0 bg-border" />

      {/* ── How we work ──────────────────────────────────────────────────── */}
      <section id="process" className="px-5 py-18 md:px-10 md:py-26 lg:px-14">
        <div className="mx-auto max-w-[1200px]">
          <Reveal className="mb-[52px] max-w-[640px]">
            <SectionEyebrow className="mb-5">How we work</SectionEyebrow>
            <h2 className="text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
              Four steps,
              <br />
              no surprises.
            </h2>
          </Reveal>
          <Reveal>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-4 md:gap-7">
              {processSteps.map((step) => (
                <ProcessStep key={step.stepNum} step={step} />
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <hr className="h-px border-0 bg-border" />

      {/* ── Tech stack ───────────────────────────────────────────────────── */}
      <section className="px-5 py-18 md:px-10 md:py-26 lg:px-14">
        <div className="mx-auto max-w-[1200px]">
          <Reveal className="mb-10 max-w-[640px]">
            <SectionEyebrow className="mb-5">Tech stack</SectionEyebrow>
            <h2 className="text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
              Tools we reach for.
            </h2>
          </Reveal>
          <Reveal>
            <TechStackChips stack={techStack} />
          </Reveal>
        </div>
      </section>

      <hr className="h-px border-0 bg-border" />

      {/* ── Careers teaser ───────────────────────────────────────────────── */}
      <section id="careers" className="px-5 py-18 md:px-10 md:py-26 lg:px-14">
        <div className="mx-auto max-w-[1200px]">
          <Reveal className="mb-11 flex flex-wrap items-end justify-between gap-5">
            <div className="max-w-[560px]">
              <SectionEyebrow className="mb-5">Careers</SectionEyebrow>
              <h2 className="mb-4 text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
                We&rsquo;re hiring senior engineers.
              </h2>
              <p className="max-w-[48ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
                Remote-first, senior-only, real ownership. If you&rsquo;ve shipped hard things in
                AI, EdTech or commerce, we should talk.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link to="/careers">
                View all roles
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </Button>
          </Reveal>

          {teaserVacancies.length > 0 ? (
            <Reveal className="grid grid-cols-1 gap-5 md:grid-cols-3 md:gap-7">
              {teaserVacancies.map((vacancy) => (
                <VacancyCard key={vacancy.slug} vacancy={vacancy} />
              ))}
            </Reveal>
          ) : (
            <Reveal className="rounded-2xl border border-border bg-card p-7 py-14 text-center">
              <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary/12 text-primary">
                <FolderOpen aria-hidden="true" className="size-[26px]" />
              </div>
              <h3 className="mb-2.5 text-[clamp(1.25rem,2.4vw,1.6rem)] leading-[1.15] font-semibold tracking-[-0.015em] text-foreground">
                No open roles right now
              </h3>
              <p className="mx-auto mb-6 max-w-[44ch] text-muted-foreground">
                We hire in waves and we&rsquo;re between them. Send your CV anyway — we keep every
                strong profile on file.
              </p>
              <Button asChild>
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
              </Button>
            </Reveal>
          )}
        </div>
      </section>

      <hr className="h-px border-0 bg-border" />

      {/* ── Contact ──────────────────────────────────────────────────────── */}
      <section id="contact" className="px-5 py-22 md:px-10 md:py-32 lg:px-14">
        <div className="mx-auto max-w-[1200px]">
          <Reveal className="relative overflow-hidden rounded-2xl border border-border bg-card p-7 py-16 text-center">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_120%_at_50%_0%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_65%)]"
            />
            <div className="relative">
              <h2 className="mx-auto mb-[18px] max-w-[18ch] text-[clamp(1.9rem,4.5vw,3rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance text-foreground">
                Have a hard problem worth shipping?
              </h2>
              <p className="mx-auto mb-8 max-w-[46ch] text-[clamp(1.05rem,1.6vw,1.3rem)] leading-[1.55] text-pretty text-muted-foreground">
                Tell us what you&rsquo;re building. We&rsquo;ll reply within one business day with
                senior people, not a sales deck.
              </p>
              <div className="flex flex-col justify-center gap-3 min-[460px]:flex-row min-[460px]:flex-wrap">
                <Button asChild size="lg">
                  <a href={`mailto:${CONTACT_EMAIL}`}>
                    Start a project
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
          </Reveal>
        </div>
      </section>

      <MarketingFooter />
    </div>
  )
}
