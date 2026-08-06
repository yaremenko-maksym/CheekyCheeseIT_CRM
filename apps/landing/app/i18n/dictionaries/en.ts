import type { Dictionary } from '../dictionary'

/**
 * `en` — source-of-truth copy. The other four locales mirror this exact key
 * set (enforced by `__tests__/i18n.spec.ts`) but are WRITTEN, not translated
 * (task-landing-copy-refactor.md §2 / skill `copywriting` §5).
 *
 * What is native per locale is the WORDING; the CLAIM is fixed. Review round
 * 1 caught the failure mode: en/uk named the weekly cadence in the hero
 * while ru/es/pt quietly dropped it, leaving three of five heroes saying
 * only "hard work is our thing" — which any agency could sign.
 *
 * The claim each heading must carry in every locale lives in
 * `__tests__/heading-claims.ts`, enforced by `heading-claims.spec.ts`. It is
 * deliberately NOT restated here: a second copy drifts, and this one did —
 * it was left behind describing `servicesH2` and `careersH2` as the wordings
 * that rounds 1 and 2 had already rejected.
 *
 * Copy rules that apply here (skill `copywriting`):
 * - Headings carry no full stop — enforced by `__tests__/heading-punctuation.spec.ts`.
 * - One idea per heading, ~6 words max on the hero.
 * - Every claim is backed by a number, a mechanism or an example; nothing
 *   about the company is invented (stats and case-study metrics are the
 *   pre-existing, owner-supplied figures — only their wording changed).
 *
 * Deliberately NOT touched, because tests anchor on them as selectors:
 * `nav.*`, `ctaSeeRoles`, `languageSwitcher.label`, `hiringStrip.text`
 * (apps/e2e/tests/landing/*, `__tests__/hiring-strip.spec.tsx`).
 */
export const en: Dictionary = {
  hiringStrip: {
    text: {
      one: "We're hiring — 1 open position",
      few: "We're hiring — {count} open positions",
      many: "We're hiring — {count} open positions",
      other: "We're hiring — {count} open positions",
    },
    close: 'Dismiss',
  },
  nav: {
    services: 'Services',
    work: 'Work',
    careers: 'Careers',
    contact: 'Contact',
    startProject: 'Start a project',
    toggleMenu: 'Toggle menu',
    primaryNav: 'Primary',
    primaryMobileNav: 'Primary mobile',
    brandHome: 'CheekyCheeseIT home',
  },
  footer: {
    // Was a full sentence ending in a full stop; a footer tagline is a label,
    // not prose — shortened to the one fact that identifies us.
    tagline: 'Senior engineers for AI, EdTech and E-Commerce',
    studioHeading: 'Studio',
    selectedWork: 'Selected work',
    howWeWork: 'How we work',
    companyHeading: 'Company',
    careers: 'Careers',
    aboutUs: 'About us',
    contact: 'Contact',
    getInTouch: 'Get in touch',
    writeToUs: 'Write to us',
    rights: '© 2026 CheekyCheeseIT. All rights reserved.',
  },
  languageSwitcher: {
    label: 'Language',
    names: { en: 'English', uk: 'Українська', ru: 'Русский', es: 'Español', pt: 'Português' },
  },
  home: {
    // ≤60 chars (SEO), keeps "senior" + all three domain keywords.
    seoTitle: 'CheekyCheeseIT — Senior engineers for AI, EdTech, E-Commerce',
    // ≤155 chars. No longer a copy of `heroParagraph` — the description
    // carries the search keywords, the hero carries the pitch.
    seoDescription:
      'Senior-only engineering studio for international product teams. Outsourcing and outstaffing in AI, EdTech and E-Commerce — shipping every week.',
    heroChip: 'Outsource & outstaffing · AI · EdTech · E-Commerce',
    // "We build products that scale" failed the logo-swap test outright — any
    // studio on earth could sign it. This says what we take on and how often
    // we deliver, which is checkable.
    heroH1Line1: 'Hard parts,',
    heroH1Highlight: 'every week',
    // task-domains-expansion, review round 2 (HIGH-1): this used to read
    // "Three domains we know cold" — a statement about the BOUNDARY of what we
    // take on, sitting above the fold, i.e. read before the services section
    // that now says the opposite. (`heroChip`/`seoTitle` still name the three
    // domains, deliberately: they LIST them as keywords, which is compatible
    // with "three already in production". This sentence did not list, it
    // limited.) Claim now: senior-only studio for international product
    // companies + any domain + 4h overlap — all three in all five locales.
    heroParagraph:
      'A senior-only engineering studio for international product companies. Whatever domain you are in, four-plus hours of overlap with your working day.',
    ctaStartProject: 'Start a project',
    ctaSeeRoles: 'See open roles',
    aboutEyebrow: 'About us',
    aboutH2Line1: 'Small teams,',
    aboutH2Line2: 'no juniors',
    aboutP1:
      'We plug into your product team as an extension of it — or take the mandate end to end. Either way you talk to the people writing the code, not to an account manager standing in front of them.',
    aboutP2:
      "The approach is deliberately narrow, and the trade is explicit: fewer people on the account, all of them senior, each owning an outcome instead of a queue of tickets. Most of what we build carries someone else's name — that suits us.",
    aboutBullets: [
      'Senior-only pods',
      'A shippable increment weekly',
      'Outcomes, not tickets',
      '4+ hours timezone overlap',
    ],
    stats: [
      { value: '40', suffix: '+', label: 'Projects shipped' },
      { value: '15', suffix: '+', label: 'Product clients' },
      { value: '3', suffix: '+', label: 'Years operating' },
      { value: '20', suffix: '+', label: 'Senior engineers' },
    ],
    workEyebrow: 'Selected work',
    workH2: 'Anonymised, but real',
    workP:
      'NDAs keep the logos off this page. The problems, the builds and the numbers are exactly as they happened.',
    caseStudies: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Real-time inference for a vision SaaS',
        challenge:
          'Model latency spiked past 400ms under load, and inference cost was growing faster than revenue.',
        solution:
          'We rebuilt the serving layer: batched GPU inference, a warm model cache and autoscaling on demand.',
        metrics: [
          { value: '80', suffix: 'ms', label: 'p95 latency' },
          { value: '-64', suffix: '%', label: 'Inference cost' },
          { value: '5', suffix: '×', label: 'Throughput' },
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Adaptive learning for a K-12 network',
        challenge:
          'One curriculum for everyone left advanced learners bored and strugglers behind — completion kept sliding.',
        solution:
          'We built a per-learner path engine that picks the next lesson from live mastery signals.',
        metrics: [
          { value: '+38', suffix: '%', label: 'Completion' },
          { value: '120', suffix: 'k', label: 'Active learners' },
          { value: '+22', suffix: '%', label: 'Retention' },
        ],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'Headless storefront for a global DTC brand',
        challenge:
          'The legacy monolith buckled on launch days, and checkout abandonment climbed with every slow page.',
        solution:
          'We re-platformed to an edge-rendered headless storefront with an idempotent, zero-downtime checkout.',
        metrics: [
          { value: '1.2', suffix: 's', label: 'LCP, global' },
          { value: '+27', suffix: '%', label: 'Conversion' },
          { value: '99.99', suffix: '%', label: 'Uptime' },
        ],
      },
    ],
    challengeLabel: 'Challenge',
    solutionLabel: 'Solution',
    servicesEyebrow: 'Services',
    // task-domains-expansion (owner, 2026-08-05): the old heading — "Three
    // domains, learned the hard way" — promised exactly three and nothing
    // outside them, which is the opposite of the positioning the owner asked
    // for. The claim now has two halves and both must survive translation:
    // any domain is on the table, AND three of them are already in production.
    servicesH2Line1: 'Any domain,',
    // Round 2 (MED-2): "three already in production" hung `production` alone on
    // a third line at 320 AND 375 (measured via `Range.getClientRects()`; the
    // old heading gave clean two-liners in the same DOM, so it was a
    // regression, not inherited). `text-balance` cannot fix it — the explicit
    // `<br/>` makes each line its own balancing box, so this is a text defect
    // and the fix is words.
    //
    // Review proposed "three already shipped"; A/B-ing five candidates in the
    // real <h2> showed that still wraps at 320 (fits from 375 up), so it is
    // dropped in favour of the two that hold two lines at BOTH widths —
    // "three already live" and this one. Chose "in production" to keep one
    // shared formulation across all five locales; "already" was emphasis, not
    // the claim, so dropping it costs nothing.
    //
    // Round 3: this note used to assert the other four locales all carried
    // "in production" — while the very commit that wrote it moved Spanish to
    // "tres ya lanzados". Rather than soften the note to match, es came back
    // to "tres en producción" (re-measured: two lines at 320/375/768). What
    // varies now is only the adverb, and only where width forces it: en/es
    // drop it, ru/uk/pt keep it (в проде / в проді / em produção).
    servicesH2Line2: 'three in production',
    servicesP:
      'The hard parts repeat across industries: latency, data models, payments, scale. Only the vocabulary changes, and we pick that up in discovery. AI, EdTech and E-Commerce are where we have shipped already — the rest we take on the same way.',
    services: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Applied AI & ML',
        description:
          'Model serving for a vision SaaS, RAG pipelines and recommendation systems — fast, observable and affordable once they are in production.',
        bullets: ['Model serving & MLOps', 'LLM & RAG applications', 'Data & feature pipelines'],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'EdTech platforms',
        description:
          'Adaptive learning paths for a K-12 network, assessment engines and content tooling — engaging for learners, measurable for the institutions paying for them.',
        bullets: ['Adaptive learning paths', 'Assessment & analytics', 'Authoring & LMS tooling'],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'E-Commerce systems',
        description:
          'A headless storefront for a global DTC brand, checkout and inventory at scale — resilient on launch days, fast for shoppers everywhere.',
        bullets: ['Headless storefronts', 'Edge checkout & payments', 'Inventory & fulfilment'],
      },
      // The fourth card is the openness claim made concrete. It names the
      // absence of a case study out loud — the alternative (inventing a
      // fourth "client" in FinTech or iGaming) would contradict `workP` two
      // sections above, which promises the numbers on this page are real.
      {
        domain: 'neutral',
        domainLabel: 'Any domain',
        title: "The domain you're in",
        description:
          'No case study here yet, and we would rather say that than invent one. What carries over is the practice: discovery first, a senior pod, something shippable in the first week — the same way the three above started.',
        bullets: ['Discovery before code', 'Senior-only pod', 'Your repo, your stack'],
      },
    ],
    processEyebrow: 'How we work',
    processH2Line1: 'Four steps,',
    // "no surprises" was a promise; "no black box" names the actual fear —
    // and step 02 below ("in your repo, in your stack, in the open") is the
    // evidence for it.
    processH2Line2: 'no black box',
    processSteps: [
      {
        stepNum: '01 / Discovery',
        title: 'Discovery',
        description:
          'We scope the problem, de-risk the unknowns and agree a plan you can hold us to.',
      },
      {
        stepNum: '02 / Build',
        title: 'Build',
        description: 'Senior pods ship weekly increments in your repo, in your stack, in the open.',
      },
      {
        stepNum: '03 / Ship',
        title: 'Ship',
        description:
          'We release to production with monitoring, load tests and a rollback you never need.',
      },
      {
        stepNum: '04 / Support',
        title: 'Support',
        description:
          'We stay on for the long tail — performance, reliability and the next iteration.',
      },
    ],
    techStackEyebrow: 'Tech stack',
    // "Tools we reach for" was filler. "Default" says these are opinionated
    // choices we start from, which is the actual message of the section.
    techStackH2: 'Our default stack',
    careersEyebrow: 'Careers',
    careersH2: 'Ownership from week one',
    careersP:
      "We hire people who have already shipped hard things in AI, EdTech or commerce. Remote-first, and the teams stay small enough that nothing you build disappears into a backlog — if that's you, we should talk.",
    viewAllRoles: 'View all roles',
    contactH2: 'A hard problem and no one to own it?',
    contactP:
      "Tell us what you're building. You'll get a reply within one business day — from engineers, not a sales deck.",
    terminalAriaLabel:
      'Animated code editor previewing CheekyCheeseIT project source across AI, EdTech and E-Commerce',
    contactForm: {
      nameLabel: 'Name',
      namePlaceholder: 'Ada Lovelace',
      companyLabel: 'Company',
      companyPlaceholder: 'Acme Inc. (optional)',
      emailLabel: 'Email',
      emailPlaceholder: 'you@company.com',
      messageLabel: 'What are you building?',
      messagePlaceholder: 'Tell us about the problem, the timeline and the team you have today.',
      submit: 'Send message',
      submitting: 'Sending…',
      protectedBy: 'Protected by invisible captcha — no puzzles, ever.',
      orEmailUs: 'or email us directly at',
      errorName: 'Please enter your name.',
      errorEmail: 'Enter a valid email.',
      errorMessage: 'Tell us a bit more (at least 10 characters).',
      successHeading: 'Message received',
      successBody: "Thanks — we've got it and will reply within one business day.",
      apiErrorValidation:
        'Something went wrong sending your message. Please check your details and try again.',
      apiErrorTurnstile: 'The "I\'m not a robot" check didn\'t go through — please try again.',
      apiErrorTurnstileRepeat:
        'The "I\'m not a robot" check failed again. Please try once more, or email us directly at',
      apiErrorRateLimited:
        "You've sent a few messages recently — please try again in a bit, or email us directly.",
      apiErrorUnavailable:
        'The contact form is temporarily unavailable — please email us directly.',
      apiErrorNetwork:
        'Something went wrong sending your message. Please check your details and try again.',
    },
  },
  careers: {
    seoTitle: 'Careers — CheekyCheeseIT',
    seoDescription:
      'Open senior engineering roles at CheekyCheeseIT — remote-first, senior-only, real ownership.',
    eyebrow: 'Careers',
    h1: 'Hard problems, senior peers',
    p1: 'We hire slowly and keep teams small, so every role here is one we genuinely need filled. Remote-first, and the ownership is real — you own the outcome, not a queue of tickets.',
    p2: 'Browse the open remote engineering roles below. Each one is a real seat on a live product team, not a maybe-someday requisition.',
    emptyTitle: 'No open roles right now',
    emptyBody:
      "We hire in waves and we're between them. Send your CV anyway — we keep every strong profile on file and reach out the moment something fits.",
  },
  vacancyCard: {
    viewRole: 'View role',
  },
  vacancy: {
    notFoundSeoTitle: 'Role not found — CheekyCheeseIT Careers',
    notFoundSeoDescription: 'This role is no longer available.',
    notFoundH1: 'Role not found',
    notFoundBody: "This role isn't open anymore — but there may be others.",
    backToCareers: 'Back to careers',
    allRoles: 'All roles',
    domainLabels: {
      AI: 'AI / ML',
      EDTECH: 'EdTech',
      ECOMMERCE: 'E-Commerce',
      FINTECH: 'FinTech',
      IGAMING: 'iGaming',
      ADULT: 'Adult',
      SAAS: 'SaaS',
      HEALTHTECH: 'HealthTech',
      ADTECH: 'AdTech',
      LOGISTICS: 'Logistics',
      PROPTECH: 'PropTech',
      TRAVEL: 'Travel',
      MEDIA: 'Media',
      WEB3: 'Web3',
      HRTECH: 'HR Tech',
      CYBERSEC: 'Cybersecurity',
      OTHER: 'Other',
    },
    employmentTypeLabels: { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACT: 'Contract' },
    salaryPeriodLabels: {
      HOUR: 'per hour',
      DAY: 'per day',
      WEEK: 'per week',
      MONTH: 'per month',
      YEAR: 'per year',
    },
    breadcrumbHome: 'Home',
    breadcrumbCareers: 'Careers',
    titleSuffix: 'CheekyCheeseIT Careers',
    relatedHeading: 'Similar roles',
    apply: {
      heading: 'Apply for this role',
      subheading: 'Takes about 3 minutes. Fields marked * are required.',
      requiredNote: 'required',
      fullNameLabel: 'Full name',
      emailLabel: 'Email',
      telegramLabel: 'Telegram',
      linkedinLabel: 'LinkedIn URL',
      githubLabel: 'GitHub URL',
      coverLetterLabel: 'Cover letter',
      namePlaceholder: 'Ada Lovelace',
      emailPlaceholder: 'you@domain.com',
      telegramPlaceholder: '@handle',
      linkedinPlaceholder: 'linkedin.com/in/…',
      githubPlaceholder: 'github.com/…',
      coverPlaceholder:
        "Tell us about something hard you shipped and what you'd want to build here.",
      cvLabel: 'CV / Resume',
      cvDropPrefix: 'Drop your CV here, or',
      cvBrowse: 'browse',
      cvHint: 'PDF only · up to 5 MB',
      cvRemoveAriaLabel: 'Remove file',
      errorName: 'Please enter your name.',
      errorEmail: 'Enter a valid email.',
      errorLinkedin: 'Enter a valid LinkedIn URL (https://…).',
      errorGithub: 'Enter a valid GitHub URL (https://…).',
      errorFile: 'Please attach your CV (PDF).',
      cvInvalidType: 'CV must be a PDF file.',
      cvTooLarge: 'File is larger than 5 MB.',
      submit: 'Submit application',
      submitting: 'Sending…',
      processing: 'Processing…',
      protectedBy: 'Protected by invisible captcha — no puzzles, ever.',
      successHeading: 'Application received',
      successThanks: 'Thanks',
      successBodyBefore: "— we've got your application for",
      successBodyAfter: '. We review every one and reply within a few business days.',
      successBrowseMore: 'Browse more roles',
      apiErrorValidation:
        'Something went wrong sending your application. Please check your details and try again.',
      apiErrorTooLarge: 'Your CV file is larger than 5 MB. Please compress it and try again.',
      apiErrorUnsupportedMedia: 'Your CV must be a valid PDF file.',
      apiErrorDuplicate: "You've already applied to this role recently.",
      apiErrorNetwork:
        'Something went wrong sending your application. Please check your details and try again.',
    },
  },
  notFoundPage: {
    seoTitle: 'Page not found — CheekyCheeseIT',
    seoDescription: "The page you're looking for doesn't exist or has moved.",
    h1: 'Page not found',
    body: "The page you're looking for doesn't exist or has moved.",
    backHome: 'Back home',
  },
}
