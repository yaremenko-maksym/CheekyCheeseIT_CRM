import type { Dictionary } from '../dictionary'

/**
 * `en` — source-of-truth copy (1:1 with the original English-only landing,
 * task-landing-redesign.md / task-landing-seo-prerender.md). `ru.ts`/`uk.ts`
 * mirror this exact key set (enforced by `__tests__/i18n.spec.ts`, plan §A2).
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
    tagline:
      'An outsource & outstaffing studio building AI, EdTech and E-Commerce products that scale.',
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
    seoTitle: 'CheekyCheeseIT — Senior engineering studio for AI, EdTech & E-Commerce',
    seoDescription:
      'A senior-only engineering studio for international product companies. From model to storefront — we ship the hard parts, on your timezone.',
    heroChip: 'Outsource & outstaffing · AI · EdTech · E-Commerce',
    heroH1Line1: 'We build products',
    heroH1Highlight: 'that scale.',
    heroParagraph:
      'A senior-only engineering studio for international product companies. From model to storefront — we ship the hard parts, on your timezone.',
    ctaStartProject: 'Start a project',
    ctaSeeRoles: 'See open roles',
    aboutEyebrow: 'About us',
    aboutH2Line1: 'Small teams,',
    aboutH2Line2: 'senior hands.',
    aboutP1:
      "We're an IT studio that plugs into product companies as an extension of their team — or takes a mandate end to end. No layers, no juniors learning on your budget.",
    aboutP2:
      'Our approach is deliberately narrow: three domains we know cold, senior engineers who own outcomes, and weekly shipping so you always see progress. We stay quietly in the background of great products.',
    aboutBullets: [
      'Senior-only pods',
      'Weekly, shippable increments',
      'Own the outcome, not the ticket',
      '4+ hours timezone overlap',
    ],
    stats: [
      { value: '40', suffix: '+', label: 'Projects shipped' },
      { value: '15', suffix: '+', label: 'Product clients' },
      { value: '3', suffix: '+', label: 'Years operating' },
      { value: '20', suffix: '+', label: 'Senior engineers' },
    ],
    workEyebrow: 'Selected work',
    workH2: 'Anonymised, but real.',
    workP:
      "Under NDA we can't name names — but the problems, the builds and the numbers are exactly as they happened.",
    caseStudies: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Real-time inference platform for a vision SaaS',
        challenge:
          'Model latency spiked past 400ms under load and inference costs grew faster than revenue.',
        solution:
          'Rebuilt the serving layer with batched GPU inference, a warm model cache and autoscaling on demand.',
        metrics: [
          { value: '80', suffix: 'ms', label: 'p95 latency' },
          { value: '-64', suffix: '%', label: 'Inference cost' },
          { value: '5', suffix: '×', label: 'Throughput' },
        ],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'Adaptive learning platform for a K-12 network',
        challenge:
          'A one-size curriculum left advanced learners bored and strugglers behind; completion was falling.',
        solution:
          'Built a per-learner path engine that recommends the next lesson from live mastery signals.',
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
          'A legacy monolith buckled on launch days; checkout abandonment climbed with every page slow-down.',
        solution:
          'Re-platformed to an edge-rendered headless storefront with idempotent, zero-downtime checkout.',
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
    servicesH2Line1: 'Three domains,',
    servicesH2Line2: 'learned the hard way.',
    servicesP:
      'We go deep, not wide. Every engineer here has shipped production systems in the domain they work.',
    services: [
      {
        domain: 'ai',
        domainLabel: 'AI / ML',
        title: 'Applied AI & ML',
        description:
          'Inference platforms, RAG pipelines, recommendation and vision systems — built to be fast, observable and affordable in production.',
        bullets: ['Model serving & MLOps', 'LLM & RAG applications', 'Data & feature pipelines'],
      },
      {
        domain: 'edtech',
        domainLabel: 'EdTech',
        title: 'EdTech platforms',
        description:
          'Adaptive learning, assessment engines and content tooling — engaging for learners, measurable for the institutions behind them.',
        bullets: ['Adaptive learning paths', 'Assessment & analytics', 'Authoring & LMS tooling'],
      },
      {
        domain: 'ecommerce',
        domainLabel: 'E-Commerce',
        title: 'E-Commerce systems',
        description:
          'Headless storefronts, checkout and inventory at scale — resilient on launch days and fast for shoppers everywhere.',
        bullets: ['Headless storefronts', 'Edge checkout & payments', 'Inventory & fulfilment'],
      },
    ],
    processEyebrow: 'How we work',
    processH2Line1: 'Four steps,',
    processH2Line2: 'no surprises.',
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
    techStackH2: 'Tools we reach for.',
    careersEyebrow: 'Careers',
    careersH2: "We're hiring senior engineers.",
    careersP:
      "Remote-first, senior-only, real ownership. If you've shipped hard things in AI, EdTech or commerce, we should talk.",
    viewAllRoles: 'View all roles',
    contactH2: 'Have a hard problem worth shipping?',
    contactP:
      "Tell us what you're building. We'll reply within one business day with senior people, not a sales deck.",
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
    h1: 'Build hard things with senior people.',
    p1: 'Remote-first, senior-only, real ownership. We hire slowly and keep teams small — every role here is one we genuinely need filled.',
    p2: 'Browse our open remote IT jobs below — every senior engineering role here is a real seat on a live product team, not a maybe-someday requisition.',
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
    domainLabels: { AI: 'AI / ML', EDTECH: 'EdTech', ECOMMERCE: 'E-Commerce', OTHER: 'Other' },
    employmentTypeLabels: { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACT: 'Contract' },
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
