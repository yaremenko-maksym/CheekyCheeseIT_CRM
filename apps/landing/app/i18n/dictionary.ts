import type { TagVariant } from '@/components/ui/tag'
import type { Locale } from './locale'

/**
 * task-landing-i18n.md — the single Dictionary shape every locale
 * (`dictionaries/{en,ru,uk}.ts`) must implement in full. Kept as ONE big
 * interface (rather than splitting content into separate per-file arrays,
 * as the pre-i18n `content/home.ts`/`content/case-studies.ts` did) so a
 * single recursive key-set walk (`__tests__/i18n.spec.ts`, plan §A2) can
 * prove "0 untranslated keys" across the WHOLE app in one pass, arrays
 * included.
 *
 * Values that are genuinely locale-INVARIANT (tech-stack names, the contact
 * email, numeric stat values) stay in `content/home.ts` as plain exports —
 * duplicating them into all 3 dictionaries would just be 3x the same
 * string, which the A2 test would then have nothing meaningful to compare.
 */

export interface StatItem {
  value: string
  suffix: string
  label: string
}

export interface ServiceItem {
  domain: TagVariant
  domainLabel: string
  title: string
  description: string
  bullets: [string, string, string]
}

export interface ProcessStepItem {
  stepNum: string
  title: string
  description: string
}

export interface CaseStudyMetric {
  value: string
  suffix?: string
  label: string
}

export interface CaseStudy {
  domain: TagVariant
  domainLabel: string
  title: string
  challenge: string
  solution: string
  metrics: [CaseStudyMetric, CaseStudyMetric, CaseStudyMetric]
}

/**
 * CLDR plural-category forms (review round 1 MED-1) — `Intl.PluralRules`
 * only ever selects `one`/`few`/`many`/`other` for the integer counts this
 * app renders (ru/uk use all four; en/es/pt only ever select `one`/`other`,
 * see `lib/plural.ts`), but EVERY locale dictionary fills all four keys so
 * the flat key-set-parity test (`__tests__/i18n.spec.ts`) stays meaningful
 * across locales with different category sets. `{count}` is a literal
 * placeholder substituted at render time (`selectPluralForm`).
 */
export interface PluralForms {
  one: string
  few: string
  many: string
  other: string
}

export interface Dictionary {
  /**
   * task-landing-contact-and-hiring-strip.md — announcement strip rendered
   * above `MarketingNav` on every page whenever there is at least one
   * PUBLISHED vacancy. `text` is CLDR-pluralized (review round 1 MED-1) —
   * see `PluralForms` / `lib/plural.ts` `selectPluralForm`.
   */
  hiringStrip: {
    text: PluralForms
    close: string
  }
  nav: {
    services: string
    work: string
    careers: string
    contact: string
    startProject: string
    toggleMenu: string
    primaryNav: string
    primaryMobileNav: string
    brandHome: string
  }
  footer: {
    tagline: string
    studioHeading: string
    selectedWork: string
    howWeWork: string
    companyHeading: string
    careers: string
    aboutUs: string
    contact: string
    getInTouch: string
    /**
     * design-review round 1 LOW-2 — the "Get in touch" column's link used to
     * literally display `CONTACT_EMAIL` (`hr@cheekycheese.tech`) while
     * navigating to `/#contact` (the form), not `mailto:` — a confusing
     * affordance (a visitor reads it as a copyable address, the click takes
     * them somewhere else). This is the link's visible CTA text now instead
     * of the raw address — the real `mailto:` fallback lives ONLY under the
     * contact form itself (owner decision §4 in the task file: "ТОЛЬКО
     * здесь"), this link's job is purely to get a visitor TO that form.
     */
    writeToUs: string
    rights: string
  }
  languageSwitcher: {
    label: string
    names: Record<Locale, string>
  }
  home: {
    seoTitle: string
    seoDescription: string
    heroChip: string
    heroH1Line1: string
    heroH1Highlight: string
    heroParagraph: string
    ctaStartProject: string
    ctaSeeRoles: string
    aboutEyebrow: string
    aboutH2Line1: string
    aboutH2Line2: string
    aboutP1: string
    aboutP2: string
    aboutBullets: [string, string, string, string]
    stats: [StatItem, StatItem, StatItem, StatItem]
    workEyebrow: string
    workH2: string
    workP: string
    caseStudies: [CaseStudy, CaseStudy, CaseStudy]
    challengeLabel: string
    solutionLabel: string
    servicesEyebrow: string
    servicesH2Line1: string
    servicesH2Line2: string
    servicesP: string
    services: [ServiceItem, ServiceItem, ServiceItem]
    processEyebrow: string
    processH2Line1: string
    processH2Line2: string
    processSteps: [ProcessStepItem, ProcessStepItem, ProcessStepItem, ProcessStepItem]
    techStackEyebrow: string
    techStackH2: string
    careersEyebrow: string
    careersH2: string
    careersP: string
    viewAllRoles: string
    contactH2: string
    contactP: string
    terminalAriaLabel: string
    /**
     * task-landing-contact-and-hiring-strip.md — the "Start a project"
     * contact form rendered inline in the `#contact` section (owner decision
     * §1: "форма прямо на странице", replacing the previous mailto CTAs).
     * `contactH2`/`contactP` above stay the section heading/intro copy.
     */
    contactForm: {
      nameLabel: string
      namePlaceholder: string
      companyLabel: string
      companyPlaceholder: string
      emailLabel: string
      emailPlaceholder: string
      messageLabel: string
      messagePlaceholder: string
      submit: string
      submitting: string
      protectedBy: string
      orEmailUs: string
      errorName: string
      errorEmail: string
      errorMessage: string
      successHeading: string
      successBody: string
      apiErrorValidation: string
      /**
       * review round 1 MED-2 — a Turnstile-verification failure (expired/
       * invalid captcha check, server 422) is a DISTINCT situation from a
       * malformed field: the fields are fine, the anti-bot check itself
       * needs a retry. Shown on the FIRST occurrence in a submit streak.
       */
      apiErrorTurnstile: string
      /**
       * Shown from the SECOND consecutive Turnstile failure onward (same
       * submit streak) — same message, PLUS the `hr@` fallback rendered
       * inline right at the point of failure (not just the persistent link
       * under the button, which a visitor mid-retry may not notice).
       */
      apiErrorTurnstileRepeat: string
      apiErrorRateLimited: string
      apiErrorUnavailable: string
      apiErrorNetwork: string
    }
  }
  careers: {
    seoTitle: string
    seoDescription: string
    eyebrow: string
    h1: string
    p1: string
    p2: string
    emptyTitle: string
    emptyBody: string
  }
  vacancyCard: {
    viewRole: string
  }
  vacancy: {
    notFoundSeoTitle: string
    notFoundSeoDescription: string
    notFoundH1: string
    notFoundBody: string
    backToCareers: string
    allRoles: string
    domainLabels: Record<'AI' | 'EDTECH' | 'ECOMMERCE' | 'OTHER', string>
    employmentTypeLabels: Record<'FULL_TIME' | 'PART_TIME' | 'CONTRACT', string>
    /** task-vacancy-salary-range — period suffix for the salary range tag; numbers/currency are NOT translated. */
    salaryPeriodLabels: Record<'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR', string>
    breadcrumbHome: string
    breadcrumbCareers: string
    titleSuffix: string
    relatedHeading: string
    apply: {
      heading: string
      subheading: string
      requiredNote: string
      fullNameLabel: string
      emailLabel: string
      telegramLabel: string
      linkedinLabel: string
      githubLabel: string
      coverLetterLabel: string
      namePlaceholder: string
      emailPlaceholder: string
      telegramPlaceholder: string
      linkedinPlaceholder: string
      githubPlaceholder: string
      coverPlaceholder: string
      cvLabel: string
      cvDropPrefix: string
      cvBrowse: string
      cvHint: string
      cvRemoveAriaLabel: string
      errorName: string
      errorEmail: string
      errorLinkedin: string
      errorGithub: string
      errorFile: string
      cvInvalidType: string
      cvTooLarge: string
      submit: string
      submitting: string
      /**
       * task-upload-freeze-and-progress.md — shown once the CV's bytes have
       * all been sent but the server hasn't confirmed yet (still writing to
       * storage). Distinct from `submitting` (which now also carries a live
       * `NN%` alongside it while bytes are actually in flight) — 100% sent
       * is NOT the same as done.
       */
      processing: string
      protectedBy: string
      successHeading: string
      successThanks: string
      successBodyBefore: string
      successBodyAfter: string
      successBrowseMore: string
      apiErrorValidation: string
      apiErrorTooLarge: string
      apiErrorUnsupportedMedia: string
      apiErrorDuplicate: string
      apiErrorNetwork: string
    }
  }
  notFoundPage: {
    seoTitle: string
    seoDescription: string
    h1: string
    body: string
    backHome: string
  }
}
