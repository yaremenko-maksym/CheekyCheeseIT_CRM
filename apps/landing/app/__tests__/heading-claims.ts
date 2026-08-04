/**
 * The claim registry — DATA, not a docblock.
 *
 * Review round 2 introduced this registry as a comment in `en.ts`. It failed
 * inside the very PR that introduced it: it covered 8 of ~13 headings, and
 * `careers.h1` — which was outside it — had lost the word "senior" in ru/uk,
 * the exact defect the registry exists to prevent. A rule that lives in a
 * comment is a rule that depends on attention.
 *
 * A test cannot judge whether five locales MEAN the same thing — that stays
 * human work. What a test can do, and what `heading-claims.spec.ts` does, is
 * guarantee COVERAGE: every heading-class key is either
 *   - listed in `HEADING_CLAIMS` with the claim it must carry in all five
 *     locales, or
 *   - listed in `CLAIMLESS_HEADING_KEYS` as carrying no marketing claim.
 * Nothing can be neither. A new heading fails the build until its author
 * decides which it is.
 */

/**
 * Headings that assert something about the company. The value is the claim
 * every locale must carry — reviewers diff the five wordings against it.
 */
export const HEADING_CLAIMS: Readonly<Record<string, string>> = {
  // ── Home ────────────────────────────────────────────────────────────────
  'home.seoTitle': 'senior engineers, in AI + EdTech + E-Commerce',
  'home.heroChip': 'category: outsourcing/outstaffing across the three domains',
  'home.heroH1Line1': 'we take on the hard work (paired with heroH1Highlight)',
  'home.heroH1Highlight': 'and we deliver it weekly',
  'home.aboutH2Line1': 'the team on your account is small',
  'home.aboutH2Line2': 'and it is senior-only — no juniors on your budget',
  'home.workH2': 'the cases are anonymised but the numbers are real',
  'home.servicesH2Line1': 'we work in exactly three domains',
  'home.servicesH2Line2': 'and we learned them the hard way, in production',
  'home.processH2Line1': 'the engagement is four steps',
  'home.processH2Line2': 'and none of it is a black box to you',
  'home.techStackH2': 'this is the stack we start from by default',
  'home.careersH2': 'you own outcomes from your first week',
  'home.contactH2': 'you have a hard problem and nobody owning it',

  // ── Careers ─────────────────────────────────────────────────────────────
  'careers.seoTitle': 'open senior engineering roles at this company',
  'careers.h1': 'hard problems, and senior people to solve them with',
  'careers.emptyTitle': 'there are no open roles at this moment',

  // ── Footer ──────────────────────────────────────────────────────────────
  'footer.tagline': 'senior engineers, in AI + EdTech + E-Commerce',
}

/**
 * Heading-class keys that carry no marketing claim: navigation, buttons,
 * form labels and placeholders, enum labels, breadcrumbs, aria strings,
 * numeric stat/metric values, and the case-study/service titles (which
 * describe one project, not the company).
 *
 * Listed explicitly rather than matched by prefix: a prefix rule would let
 * a new key under an existing namespace slip in unclassified, which is the
 * failure this registry exists to prevent.
 */
export const CLAIMLESS_HEADING_KEYS: ReadonlySet<string> = new Set([
  // Hiring strip
  'hiringStrip.text.one',
  'hiringStrip.text.few',
  'hiringStrip.text.many',
  'hiringStrip.text.other',
  'hiringStrip.close',

  // Navigation
  'nav.services',
  'nav.work',
  'nav.careers',
  'nav.contact',
  'nav.startProject',
  'nav.toggleMenu',
  'nav.primaryNav',
  'nav.primaryMobileNav',
  'nav.brandHome',

  // Footer link groups
  'footer.studioHeading',
  'footer.selectedWork',
  'footer.howWeWork',
  'footer.companyHeading',
  'footer.careers',
  'footer.aboutUs',
  'footer.contact',
  'footer.getInTouch',
  'footer.writeToUs',

  // Language switcher
  'languageSwitcher.label',
  'languageSwitcher.names.en',
  'languageSwitcher.names.uk',
  'languageSwitcher.names.ru',
  'languageSwitcher.names.es',
  'languageSwitcher.names.pt',

  // Home — section eyebrows (category labels above the claim-bearing H2)
  'home.aboutEyebrow',
  'home.workEyebrow',
  'home.servicesEyebrow',
  'home.processEyebrow',
  'home.techStackEyebrow',
  'home.careersEyebrow',

  // Home — CTAs and inline labels
  'home.ctaStartProject',
  'home.ctaSeeRoles',
  'home.challengeLabel',
  'home.solutionLabel',
  'home.viewAllRoles',
  'home.terminalAriaLabel',

  // Home — stats (the numbers are owner-supplied facts, not claims to word)
  'home.aboutBullets[]',
  'home.stats[].value',
  'home.stats[].suffix',
  'home.stats[].label',

  // Home — per-project and per-service titles
  'home.caseStudies[].domain',
  'home.caseStudies[].domainLabel',
  'home.caseStudies[].title',
  'home.caseStudies[].metrics[].value',
  'home.caseStudies[].metrics[].suffix',
  'home.caseStudies[].metrics[].label',
  'home.services[].domain',
  'home.services[].domainLabel',
  'home.services[].title',
  'home.services[].bullets[]',
  'home.processSteps[].stepNum',
  'home.processSteps[].title',

  // Home — contact form chrome
  'home.contactForm.nameLabel',
  'home.contactForm.namePlaceholder',
  'home.contactForm.companyLabel',
  'home.contactForm.companyPlaceholder',
  'home.contactForm.emailLabel',
  'home.contactForm.emailPlaceholder',
  'home.contactForm.messageLabel',
  'home.contactForm.submit',
  'home.contactForm.submitting',
  'home.contactForm.orEmailUs',
  'home.contactForm.successHeading',

  // Careers index
  'careers.eyebrow',

  // Vacancy card + detail chrome
  'vacancyCard.viewRole',
  'vacancy.notFoundSeoTitle',
  'vacancy.notFoundH1',
  'vacancy.backToCareers',
  'vacancy.allRoles',
  'vacancy.domainLabels.AI',
  'vacancy.domainLabels.EDTECH',
  'vacancy.domainLabels.ECOMMERCE',
  'vacancy.domainLabels.OTHER',
  'vacancy.employmentTypeLabels.FULL_TIME',
  'vacancy.employmentTypeLabels.PART_TIME',
  'vacancy.employmentTypeLabels.CONTRACT',
  'vacancy.salaryPeriodLabels.HOUR',
  'vacancy.salaryPeriodLabels.DAY',
  'vacancy.salaryPeriodLabels.WEEK',
  'vacancy.salaryPeriodLabels.MONTH',
  'vacancy.salaryPeriodLabels.YEAR',
  'vacancy.breadcrumbHome',
  'vacancy.breadcrumbCareers',
  'vacancy.titleSuffix',
  'vacancy.relatedHeading',

  // Vacancy apply form chrome
  'vacancy.apply.heading',
  'vacancy.apply.requiredNote',
  'vacancy.apply.fullNameLabel',
  'vacancy.apply.emailLabel',
  'vacancy.apply.telegramLabel',
  'vacancy.apply.linkedinLabel',
  'vacancy.apply.githubLabel',
  'vacancy.apply.coverLetterLabel',
  'vacancy.apply.namePlaceholder',
  'vacancy.apply.emailPlaceholder',
  'vacancy.apply.telegramPlaceholder',
  'vacancy.apply.linkedinPlaceholder',
  'vacancy.apply.githubPlaceholder',
  'vacancy.apply.cvLabel',
  'vacancy.apply.cvDropPrefix',
  'vacancy.apply.cvBrowse',
  'vacancy.apply.cvHint',
  'vacancy.apply.cvRemoveAriaLabel',
  'vacancy.apply.submit',
  'vacancy.apply.submitting',
  'vacancy.apply.successHeading',
  'vacancy.apply.successThanks',
  'vacancy.apply.successBodyBefore',
  'vacancy.apply.successBrowseMore',

  // 404
  'notFoundPage.seoTitle',
  'notFoundPage.h1',
  'notFoundPage.backHome',
])
