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
 * guarantee COVERAGE: every dictionary key is either
 *   - listed with the claim it must carry in all five locales
 *     (`HEADING_CLAIMS` / `PROSE_CLAIMS`), or
 *   - listed as carrying no marketing claim
 *     (`CLAIMLESS_HEADING_KEYS` / `CLAIMLESS_PROSE_KEYS`).
 * Nothing can be neither. A new key fails the build until its author decides
 * which it is.
 *
 * PROSE was added in task-domains-expansion review round 2, and the registry
 * failed the same way a second time to earn it: `home.heroParagraph` promised
 * "Three domains we know cold" — a boundary claim, above the fold, read
 * BEFORE the services section — and sailed through the PR whose entire
 * purpose was removing that promise. Not through inattention: prose is
 * filtered out of `headingKeysOf`, so the registry could not see it by
 * construction. The registry looked like coverage while covering half the
 * copy. Claims do not respect the heading/prose split, so neither does this
 * file any more.
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
  // task-domains-expansion (owner, 2026-08-05) — the previous claim pair was
  // "we work in exactly three domains" + "learned the hard way", i.e. an
  // exclusivity promise. The owner asked for the opposite: no domain lock-in,
  // with the proven experience stated as evidence rather than as a boundary.
  // Both halves are load-bearing — a locale that keeps only "any domain"
  // turns the section into an unsupported boast, and one that keeps only
  // "three in production" re-states the promise this change removed.
  'home.servicesH2Line1': 'we are not limited to one domain — whichever you are in, we take it on',
  'home.servicesH2Line2': 'and three of them are already in production (AI, EdTech, E-Commerce)',
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
 * Prose that asserts something about the COMPANY, and therefore must say the
 * same thing in all five locales. Same contract as `HEADING_CLAIMS`; separate
 * map only because the punctuation rule treats the two classes differently
 * (prose ends in a full stop, headings do not).
 *
 * The line between this and `CLAIMLESS_PROSE_KEYS` is the one the file already
 * draws for headings: copy about the company is a claim; copy about one
 * project, one service card or one form field is not.
 */
export const PROSE_CLAIMS: Readonly<Record<string, string>> = {
  // ── Home ────────────────────────────────────────────────────────────────
  'home.seoDescription': 'senior-only outsourcing/outstaffing, shipping every week',
  // Round 2 HIGH-1: this used to add "three domains we know cold" — a
  // boundary — while the services section said the opposite. The claim is
  // now openness, and the 4h overlap it always carried.
  'home.heroParagraph':
    'senior-only studio for international product companies, any domain, 4+ hours of overlap',
  'home.aboutP1': 'you talk to the engineers writing the code, not to an account manager',
  'home.aboutP2': 'few people on the account, all senior, each owning an outcome',
  'home.workP': 'NDAs hide the logos; the problems, builds and numbers are the real ones',
  'home.servicesP':
    'the hard parts repeat across industries, only the vocabulary changes (learned in discovery) — AI/EdTech/E-Commerce are the three already in production',
  'home.processSteps[].description':
    'what each of the four steps delivers — incl. weekly increments in YOUR repo and stack (step 02) and staying on after release (step 04)',
  'home.careersP': 'remote-first, senior-only hiring, teams small enough that your work is visible',
  'home.contactP': 'a reply within one business day, from engineers rather than sales',
  'home.contactForm.successBody': 'a reply within one business day',

  // ── Careers ─────────────────────────────────────────────────────────────
  'careers.seoDescription': 'remote-first, senior-only roles with real ownership',
  'careers.p1': 'we hire slowly and keep teams small, so every open role is genuinely needed',
  'careers.p2': 'each listing is a real seat on a live product team, not a maybe-someday req',
  'careers.emptyBody': 'we hire in waves and keep every strong profile on file',
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
  // task-domains-expansion — one entry per `VacancyDomain` (`@crm/shared`).
  // Enum labels, not marketing: they name the industry a vacancy is posted
  // in and assert nothing about the company.
  'vacancy.domainLabels.AI',
  'vacancy.domainLabels.EDTECH',
  'vacancy.domainLabels.ECOMMERCE',
  'vacancy.domainLabels.FINTECH',
  'vacancy.domainLabels.IGAMING',
  'vacancy.domainLabels.ADULT',
  'vacancy.domainLabels.SAAS',
  'vacancy.domainLabels.HEALTHTECH',
  'vacancy.domainLabels.ADTECH',
  'vacancy.domainLabels.LOGISTICS',
  'vacancy.domainLabels.PROPTECH',
  'vacancy.domainLabels.TRAVEL',
  'vacancy.domainLabels.MEDIA',
  'vacancy.domainLabels.WEB3',
  'vacancy.domainLabels.HRTECH',
  'vacancy.domainLabels.CYBERSEC',
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
  'vacancy.apply.processing',
  'vacancy.apply.successHeading',
  'vacancy.apply.successThanks',
  'vacancy.apply.successBodyBefore',
  'vacancy.apply.successBrowseMore',

  // 404
  'notFoundPage.seoTitle',
  'notFoundPage.h1',
  'notFoundPage.backHome',
])

/**
 * Prose that carries no company claim: per-project and per-service copy
 * (it describes one engagement, not the studio — same call the heading list
 * makes for `caseStudies[].title`), form chrome, validation errors, and
 * not-found bodies. Listed explicitly, never matched by prefix, for the same
 * reason as the heading list: a prefix rule lets a new key under an existing
 * namespace slip in unclassified.
 */
export const CLAIMLESS_PROSE_KEYS: ReadonlySet<string> = new Set([
  // Footer
  'footer.rights',

  // Home — per-project / per-service copy
  'home.caseStudies[].challenge',
  'home.caseStudies[].solution',
  'home.services[].description',

  // Home — contact form chrome
  'home.contactForm.messagePlaceholder',
  'home.contactForm.protectedBy',
  'home.contactForm.errorName',
  'home.contactForm.errorEmail',
  'home.contactForm.errorMessage',
  'home.contactForm.apiErrorValidation',
  'home.contactForm.apiErrorTurnstile',
  'home.contactForm.apiErrorTurnstileRepeat',
  'home.contactForm.apiErrorRateLimited',
  'home.contactForm.apiErrorUnavailable',
  'home.contactForm.apiErrorNetwork',

  // Vacancy detail — chrome, apply-form hints and errors
  'vacancy.notFoundSeoDescription',
  'vacancy.notFoundBody',
  'vacancy.apply.subheading',
  'vacancy.apply.coverPlaceholder',
  'vacancy.apply.protectedBy',
  'vacancy.apply.errorName',
  'vacancy.apply.errorEmail',
  'vacancy.apply.errorLinkedin',
  'vacancy.apply.errorGithub',
  'vacancy.apply.errorFile',
  'vacancy.apply.cvInvalidType',
  'vacancy.apply.cvTooLarge',
  'vacancy.apply.successBodyAfter',
  'vacancy.apply.apiErrorValidation',
  'vacancy.apply.apiErrorTooLarge',
  'vacancy.apply.apiErrorUnsupportedMedia',
  'vacancy.apply.apiErrorDuplicate',
  'vacancy.apply.apiErrorNetwork',

  // 404
  'notFoundPage.seoDescription',
  'notFoundPage.body',
])
