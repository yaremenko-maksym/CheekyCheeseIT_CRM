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

export interface Dictionary {
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
    breadcrumbHome: string
    breadcrumbCareers: string
    titleSuffix: string
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
