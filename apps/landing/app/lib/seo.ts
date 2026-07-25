import type {
  PublicVacancy,
  PublicVacancyDetail,
  VacancyEmploymentType,
  VacancyLocale,
} from '@crm/shared'
import { CONTACT_EMAIL } from '@/content/home'
import { DEFAULT_LOCALE, LOCALES, localizedPath, type Locale } from '@/i18n/locale'

/**
 * task-landing-seo-prerender.md — SEO constants + schema.org JSON-LD builders.
 *
 * Kept as pure functions (no `document`/`window`) so they are usable from
 * BOTH the live SPA (`useDocumentHead` injects the result into
 * `<script type="application/ld+json">`, see `use-document-head.ts`) and
 * plain unit tests (`__tests__/seo.spec.ts`) — no browser environment needed.
 *
 * `SITE_ORIGIN` here MUST be kept in sync with the identical literal in
 * `scripts/prerender.mjs` (plain Node ESM — cannot import this `.ts` module
 * without a build step, so the domain is duplicated in exactly those two
 * places; both call this out in a comment).
 */
export const SITE_ORIGIN = 'https://cheekycheese.tech'
export const SITE_NAME = 'CheekyCheeseIT'

/**
 * Absolute canonical/OG URL for a given site-relative pathname (e.g.
 * `/careers`). Always trailing-slash-terminated — matches the router's
 * `trailingSlash: 'always'` (see `router.tsx`) and the directory-per-route
 * layout `scripts/prerender.mjs` writes (`/careers/<slug>` ->
 * `dist/careers/<slug>/index.html`), so the canonical URL is exactly what
 * prod nginx serves as a 200 with no redirect hop in between.
 */
export function canonicalUrl(pathname: string): string {
  const withSlash = pathname.endsWith('/') ? pathname : `${pathname}/`
  return `${SITE_ORIGIN}${withSlash}`
}

export interface HreflangAlternate {
  /** BCP47-ish tag: one of `Locale` (`en`/`uk`/`ru`/`es`/`pt`) or the literal `'x-default'`. */
  hreflang: Locale | 'x-default'
  href: string
}

/**
 * Builds the FULL hreflang cluster (plan §1/§4 A4, task-landing-i18n.md) for
 * a locale-agnostic, root-relative path (e.g. `/`, `/careers`,
 * `/careers/my-slug`) — one `alternate` entry per locale in `LOCALES`, plus
 * `x-default` -> the `en` (default locale) URL.
 *
 * Reciprocal by construction: every locale's own page calls this with the
 * SAME locale-agnostic `path`, so all N locale pages for that logical
 * document emit the identical (N+1)-entry cluster — A ссылается на B, B на
 * A (plan §1's "взаимность обязательна"), verified by
 * `__tests__/seo.spec.ts`'s reciprocity test across every route.
 *
 * `excludeLocales` (plan §3/A10 "непереведённая — оригинал БЕЗ hreflang на
 * неё") drops locales a vacancy has no real translation for — the SAME
 * exclusion set must be passed by every locale's page for that vacancy so
 * the cluster stays reciprocal even with omissions (see
 * `pages/vacancy-detail-page-content.tsx`).
 */
export function buildHreflangAlternates(
  path: string,
  excludeLocales: readonly Locale[] = [],
): HreflangAlternate[] {
  const alternates: HreflangAlternate[] = LOCALES.filter(
    (locale) => !excludeLocales.includes(locale),
  ).map((locale) => ({
    hreflang: locale,
    href: canonicalUrl(localizedPath(locale, path)),
  }))
  // x-default always resolves to the `en` URL (plan §1) — `en` is never
  // realistically in `excludeLocales` (A10's fallback locale IS en, see
  // lib/api.ts), so this is always present.
  alternates.push({
    hreflang: 'x-default',
    href: canonicalUrl(localizedPath(DEFAULT_LOCALE, path)),
  })
  return alternates
}

export interface OrganizationJsonLd {
  '@context': 'https://schema.org'
  '@type': 'Organization'
  name: string
  url: string
  email: string
}

/** `/` — Organization structured data (task §2). */
export function buildOrganizationJsonLd(): OrganizationJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: SITE_ORIGIN,
    email: CONTACT_EMAIL,
  }
}

export interface WebSiteJsonLd {
  '@context': 'https://schema.org'
  '@type': 'WebSite'
  name: string
  url: string
}

/** `/` — WebSite structured data (task §2). */
export function buildWebSiteJsonLd(): WebSiteJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: SITE_ORIGIN,
  }
}

// -----------------------------------------------------------------------------
// JobPosting (Google Jobs) — owner requirement 2026-07-24: full compliance so
// vacancies actually surface in Google Jobs + rank for title-bearing queries.
// -----------------------------------------------------------------------------

// schema.org/Google's EmploymentType enum uses CONTRACTOR, not CONTRACT — our
// internal enum (packages/shared vacancyEmploymentTypeSchema, used by the
// admin CRM's data-entry UI + already-live prod rows) intentionally stays
// CONTRACT; renaming it is out of this task's apps/landing-only scope and is
// a breaking schema change elsewhere. Map only at this JSON-LD boundary.
const GOOGLE_EMPLOYMENT_TYPE: Record<VacancyEmploymentType, string> = {
  FULL_TIME: 'FULL_TIME',
  PART_TIME: 'PART_TIME',
  CONTRACT: 'CONTRACTOR',
}

const VALID_THROUGH_DAYS = 60

/**
 * `validThrough` = generation time + 60 days, ROLLING — owner decision
 * 2026-07-24: every prerender rebuild recomputes this from `Date.now()` at
 * the moment this function runs, which (when driven by
 * `scripts/prerender.mjs`'s headless snapshot, not a live visitor's
 * browser) IS "prerender generation time" — the snapshot freezes whatever
 * this evaluates to at build time into the static file. A stale
 * `validThrough` that keeps slipping into the past is exactly what makes
 * Google stop showing a listing, so this must be recomputed on every build,
 * not hardcoded once.
 */
function buildValidThrough(): string {
  return new Date(Date.now() + VALID_THROUGH_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

export interface RemoteLocationInfo {
  jobLocationType: 'TELECOMMUTE'
  applicantLocationRequirements: { '@type': 'Country'; name: string }
}

/**
 * Best-effort remote-location parsing for Google Jobs' `jobLocationType` +
 * `applicantLocationRequirements` (owner decision 2026-07-24). Google flags
 * a TELECOMMUTE listing as a Search Console error if
 * `applicantLocationRequirements` is missing, so the two always travel
 * together — https://developers.google.com/search/docs/appearance/structured-data/job-posting.
 *
 * Returns `null` (no jobLocationType at all — correct for a real on-site
 * role, matching Google's guidance that the field is remote-only) unless
 * `location` mentions "remote". Every current vacancy does — CheekyCheeseIT
 * is remote-first by business model — so this is effectively always
 * TELECOMMUTE today; the on-site branch exists for correctness, not because
 * it's exercised by real data yet.
 *
 * "Best-effort" per owner's own framing — this is intentionally simple
 * regex parsing of a free-text admin-entered field, not a geocoder:
 *   - exactly "Remote" (no qualifier)  -> Worldwide (honest: no stated restriction)
 *   - "Remote (Region)"                -> Region, verbatim (owner's own example)
 *   - anything else mentioning remote  -> Country: UA fallback (owner's explicit
 *     instruction for the unparseable case — CheekyCheeseIT is Ukraine-based, so
 *     this is a safe floor, not a guess at an unstated restriction)
 */
export function parseRemoteLocation(location: string): RemoteLocationInfo | null {
  if (!/remote/i.test(location)) return null

  const regionMatch = location.match(/\(([^)]+)\)/)
  const name = regionMatch
    ? regionMatch[1]!.trim()
    : /^remote$/i.test(location.trim())
      ? 'Worldwide'
      : 'UA'

  return {
    jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: { '@type': 'Country', name },
  }
}

export interface JobPostingJsonLd {
  '@context': 'https://schema.org'
  '@type': 'JobPosting'
  title: string
  description: string
  datePosted: string
  validThrough: string
  employmentType: string
  hiringOrganization: { '@type': 'Organization'; name: string; sameAs: string }
  directApply: true
  identifier: { '@type': 'PropertyValue'; name: string; value: string }
  url: string
  jobLocationType?: 'TELECOMMUTE'
  applicantLocationRequirements?: { '@type': 'Country'; name: string }
  skills?: string
  experienceRequirements?: {
    '@type': 'OccupationalExperienceRequirements'
    monthsOfExperience: number
  }
  qualifications?: string
  responsibilities?: string
  industry?: string
  occupationalCategory?: string
  jobBenefits?: string
  workHours?: string
}

// task-vacancy-i18n-jobposting C3 — `industry` is DERIVED from the
// vacancy's own `domain` (never invented, never a separate admin-entered
// field) — every CheekyCheeseIT opening already carries a domain, so this
// is always present. `OTHER` maps to the closest honest umbrella term for
// an IT outstaffing/outsourcing business.
const INDUSTRY_BY_DOMAIN: Record<PublicVacancyDetail['domain'], string> = {
  AI: 'Artificial Intelligence',
  EDTECH: 'Education Technology',
  ECOMMERCE: 'E-Commerce',
  OTHER: 'Information Technology',
}

/**
 * O*NET-SOC occupational classification code for Google's `occupationalCategory`
 * (task C3). CheekyCheeseIT exclusively hires software developers across its
 * AI/EdTech/E-Commerce domains (see `docs/business/overview.md`) — `15-1252.00`
 * ("Software Developers") is accurate for every current and reasonably
 * foreseeable posting, so it's a constant here rather than a per-vacancy admin
 * field nobody would ever need to change. https://www.onetonline.org/link/summary/15-1252.00
 */
const OCCUPATIONAL_CATEGORY = '15-1252.00'

/**
 * `/careers/:slug` — JobPosting structured data for Google Jobs (task §2,
 * extended to full compliance 2026-07-24, further enriched by
 * task-vacancy-i18n-jobposting C3). Deliberately has NO salary field — by
 * product design (see `packages/shared/src/schemas/vacancies.ts` module
 * doc), not an omission.
 *
 * `descriptionHtml` — the FULL rendered vacancy description as HTML, not
 * the raw Markdown source or a truncated snippet (Google explicitly accepts
 * HTML-formatted descriptions and recommends the complete posting text, not
 * an excerpt). The caller (`routes/careers_.$slug.tsx`, a `.tsx` file with
 * JSX available) computes this via
 * `renderToStaticMarkup(<MarkdownBody markdown={...} />)` — the SAME
 * markdown renderer/plugins that render the visible page, so the JSON-LD
 * description can never drift from what a human sees. `seo.ts` stays a
 * plain `.ts` module (no JSX) on purpose, so this function takes the
 * pre-rendered string rather than doing that conversion itself.
 *
 * C3 enrichment fields (`skills`/`experienceRequirements`/`qualifications`/
 * `responsibilities`/`jobBenefits`/`workHours`) are all OPTIONAL admin-entered
 * data on the vacancy row (`packages/shared` `vacancySeoFieldsSchema`) —
 * each is only emitted when actually present, never invented/empty
 * (task-vacancy-i18n-jobposting: "пустых/выдуманных значений быть не должно").
 * `industry`/`occupationalCategory` are always present (derived/constant, see
 * above) since they carry no risk of being fabricated per-vacancy data.
 */
export function buildJobPostingJsonLd(
  vacancy: PublicVacancyDetail,
  descriptionHtml: string,
): JobPostingJsonLd {
  const remote = parseRemoteLocation(vacancy.location)
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: vacancy.title,
    description: descriptionHtml,
    datePosted: vacancy.publishedAt,
    validThrough: buildValidThrough(),
    employmentType: GOOGLE_EMPLOYMENT_TYPE[vacancy.employmentType],
    hiringOrganization: { '@type': 'Organization', name: SITE_NAME, sameAs: SITE_ORIGIN },
    // We accept applications directly through our own form (VacancyApplyForm)
    // with no external redirect — the literal condition Google's docs define
    // `directApply` for.
    directApply: true,
    identifier: { '@type': 'PropertyValue', name: SITE_NAME, value: vacancy.slug },
    url: canonicalUrl(`/careers/${vacancy.slug}`),
    ...(remote ?? {}),
    industry: INDUSTRY_BY_DOMAIN[vacancy.domain],
    occupationalCategory: OCCUPATIONAL_CATEGORY,
    ...(vacancy.skills && vacancy.skills.length > 0 ? { skills: vacancy.skills.join(', ') } : {}),
    ...(vacancy.experienceMonths !== null
      ? {
          experienceRequirements: {
            '@type': 'OccupationalExperienceRequirements',
            monthsOfExperience: vacancy.experienceMonths,
          },
        }
      : {}),
    ...(vacancy.qualifications ? { qualifications: vacancy.qualifications } : {}),
    ...(vacancy.responsibilities ? { responsibilities: vacancy.responsibilities } : {}),
    ...(vacancy.jobBenefits ? { jobBenefits: vacancy.jobBenefits } : {}),
    ...(vacancy.workHours ? { workHours: vacancy.workHours } : {}),
  }
}

export interface BreadcrumbListJsonLd {
  '@context': 'https://schema.org'
  '@type': 'BreadcrumbList'
  itemListElement: Array<{ '@type': 'ListItem'; position: number; name: string; item: string }>
}

/** `/careers/:slug` — Home → Careers → <Job Title> (owner decision 2026-07-24). */
export function buildBreadcrumbListJsonLd(
  vacancy: Pick<PublicVacancyDetail, 'title' | 'slug'>,
): BreadcrumbListJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: canonicalUrl('/') },
      { '@type': 'ListItem', position: 2, name: 'Careers', item: canonicalUrl('/careers') },
      {
        '@type': 'ListItem',
        position: 3,
        name: vacancy.title,
        item: canonicalUrl(`/careers/${vacancy.slug}`),
      },
    ],
  }
}

export interface ItemListJsonLd {
  '@context': 'https://schema.org'
  '@type': 'ItemList'
  itemListElement: Array<{ '@type': 'ListItem'; position: number; url: string; name: string }>
}

/** `/careers` — the live PUBLISHED roles as a schema.org list (owner decision 2026-07-24). */
export function buildItemListJsonLd(vacancies: PublicVacancy[]): ItemListJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: vacancies.map((vacancy, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: canonicalUrl(`/careers/${vacancy.slug}`),
      name: vacancy.title,
    })),
  }
}

// -----------------------------------------------------------------------------
// FAQPage (task-vacancy-i18n-jobposting C6) — 4 questions about the hiring
// process, on `/careers/:slug` (rich-snippet eligible). Localized to all 5
// site locales (owner scope-change 2026-07-25) — content authored here
// (same convention as Block A's landing copy: written in-house, flagged for
// owner proofreading before it ships, NOT a machine translation).
// -----------------------------------------------------------------------------

interface FaqEntry {
  q: string
  a: string
}

const FAQ_ENTRIES: Record<VacancyLocale, FaqEntry[]> = {
  en: [
    {
      q: 'What does the hiring process look like?',
      a: 'Submit your application with your resume through the form on this page. Our team reviews every application and reaches out directly to candidates who are a good fit for the role.',
    },
    {
      q: 'What happens after I submit my application?',
      a: "Your application and resume go straight to our hiring team. If your profile matches the role, we'll contact you by email or Telegram to schedule an interview.",
    },
    {
      q: 'Do I need to be located in a specific country to apply?',
      a: "Most of our roles are remote-first — check the role's location note for any regional requirement. We're an outstaffing/outsourcing partner working across AI, EdTech and E-Commerce.",
    },
    {
      q: 'Can I apply to more than one open role?',
      a: 'Yes — submit a separate application for each role you are interested in.',
    },
  ],
  uk: [
    {
      q: 'Як виглядає процес найму?',
      a: 'Надішліть заявку з резюме через форму на цій сторінці. Наша команда розглядає кожну заявку та звʼязується напряму з кандидатами, які підходять на цю позицію.',
    },
    {
      q: 'Що відбувається після подачі заявки?',
      a: 'Ваша заявка й резюме одразу потрапляють до команди найму. Якщо ваш профіль підходить, ми звʼяжемося поштою або в Telegram, щоб призначити співбесіду.',
    },
    {
      q: 'Чи обовʼязково перебувати в певній країні, щоб податися?',
      a: 'Більшість наших позицій — full-remote; регіональні вимоги (якщо є) вказані в описі вакансії. Ми — outstaffing/outsourcing-партнер у напрямках AI, EdTech і E-Commerce.',
    },
    {
      q: 'Чи можна податися на кілька вакансій одразу?',
      a: 'Так — надішліть окрему заявку на кожну вакансію, яка вас цікавить.',
    },
  ],
  ru: [
    {
      q: 'Как выглядит процесс найма?',
      a: 'Отправьте заявку с резюме через форму на этой странице. Наша команда рассматривает каждую заявку и связывается напрямую с кандидатами, которые подходят на позицию.',
    },
    {
      q: 'Что происходит после подачи заявки?',
      a: 'Ваша заявка и резюме сразу попадают к команде найма. Если ваш профиль подходит, мы свяжемся по почте или в Telegram, чтобы назначить собеседование.',
    },
    {
      q: 'Обязательно ли находиться в определённой стране, чтобы податься?',
      a: 'Большинство наших позиций — full-remote; региональные требования (если есть) указаны в описании вакансии. Мы — outstaffing/outsourcing-партнёр в направлениях AI, EdTech и E-Commerce.',
    },
    {
      q: 'Можно ли откликнуться на несколько вакансий сразу?',
      a: 'Да — отправьте отдельную заявку на каждую интересующую вас вакансию.',
    },
  ],
  es: [
    {
      q: '¿Cómo es el proceso de contratación?',
      a: 'Envía tu candidatura con tu currículum a través del formulario de esta página. Nuestro equipo revisa cada candidatura y contacta directamente a quienes encajan con el puesto.',
    },
    {
      q: '¿Qué ocurre después de enviar mi candidatura?',
      a: 'Tu candidatura y currículum llegan directamente a nuestro equipo de selección. Si tu perfil encaja, te contactaremos por correo o Telegram para programar una entrevista.',
    },
    {
      q: '¿Necesito estar en un país concreto para aplicar?',
      a: 'La mayoría de nuestros puestos son remotos; cualquier requisito regional se indica en la descripción del puesto. Somos un partner de outstaffing/outsourcing en AI, EdTech y E-Commerce.',
    },
    {
      q: '¿Puedo postularme a más de una vacante?',
      a: 'Sí — envía una candidatura independiente por cada vacante que te interese.',
    },
  ],
  pt: [
    {
      q: 'Como é o processo de contratação?',
      a: 'Envie sua candidatura com o currículo pelo formulário desta página. Nossa equipe analisa cada candidatura e entra em contato diretamente com quem se encaixa na vaga.',
    },
    {
      q: 'O que acontece depois de eu enviar minha candidatura?',
      a: 'Sua candidatura e currículo vão direto para a equipe de recrutamento. Se o seu perfil combinar com a vaga, entraremos em contato por e-mail ou Telegram para agendar uma entrevista.',
    },
    {
      q: 'Preciso estar em um país específico para me candidatar?',
      a: 'A maioria das nossas vagas é remota; qualquer exigência regional é indicada na descrição da vaga. Somos uma parceira de outstaffing/outsourcing em AI, EdTech e E-Commerce.',
    },
    {
      q: 'Posso me candidatar a mais de uma vaga?',
      a: 'Sim — envie uma candidatura separada para cada vaga do seu interesse.',
    },
  ],
}

export interface FAQPageJsonLd {
  '@context': 'https://schema.org'
  '@type': 'FAQPage'
  mainEntity: Array<{
    '@type': 'Question'
    name: string
    acceptedAnswer: { '@type': 'Answer'; text: string }
  }>
}

/**
 * `/careers/:slug` — FAQPage structured data (task C6). `locale` defaults to
 * `en` (site default). Content is generic to the hiring process (not
 * vacancy-specific) — same 4 questions on every posting, localized.
 */
export function buildFAQPageJsonLd(locale: VacancyLocale = 'en'): FAQPageJsonLd {
  const entries = FAQ_ENTRIES[locale]
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entries.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  }
}

// -----------------------------------------------------------------------------
// Markdown -> plain-text meta description (owner decision 2026-07-24: real
// content instead of a synthesized sentence, for title-bearing search queries).
// -----------------------------------------------------------------------------

/**
 * Deliberately simple regex-based Markdown stripping (no new dependency —
 * version-pins.md — and not meant to be a full CommonMark parser). Good
 * enough to turn a vacancy's real description into readable plain-text
 * search-snippet copy instead of hand-synthesized boilerplate.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '') // numbered-list markers
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italic/strikethrough
    .replace(/\s+/g, ' ')
    .trim()
}

const META_DESCRIPTION_MAX_LENGTH = 155

/** Truncates on a word boundary + adds an ellipsis, never mid-word. */
export function truncateForMetaDescription(
  text: string,
  maxLength: number = META_DESCRIPTION_MAX_LENGTH,
): string {
  if (text.length <= maxLength) return text
  const truncated = text.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(' ')
  const clipped = lastSpace > maxLength * 0.6 ? truncated.slice(0, lastSpace) : truncated
  return `${clipped.trimEnd()}…`
}
