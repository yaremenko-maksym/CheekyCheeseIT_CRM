import type { PublicVacancy, PublicVacancyDetail } from '@crm/shared'
// Runtime schema values come from the narrow '@crm/shared/public' subpath,
// NOT the full '@crm/shared' barrel — see packages/shared/src/public.ts doc
// comment (PR #421 Lighthouse RCA: the full barrel drags all 28 CRM domains'
// Zod schemas into this file's importers because z.object()/z.enum() calls
// aren't tree-shakeable). `import type` above is unaffected — types are
// erased at compile time regardless of which subpath they resolve through.
import { publicVacancyDetailSchema, publicVacancySchema } from '@crm/shared/public'
import { z } from 'zod'
import { DEFAULT_LOCALE, NON_DEFAULT_LOCALES, type Locale } from '@/i18n/locale'

/**
 * Same-origin `fetch` against `/api` (docs/superpowers/specs/2026-07-22-landing-refactor-design.md
 * §2.3) — nginx proxies `/api` in prod, `vite.config.ts` proxies it in dev. No
 * react-query on the landing (product decision — YAGNI for 3 read-mostly
 * routes), no base-URL config needed.
 *
 * `PublicVacancy`/`PublicVacancyDetail` are the REAL `@crm/shared` contract
 * (Block C, PR #422, merged) — `title`/`descriptionMd` are already resolved
 * SERVER-SIDE for whatever `?locale=` was requested (original `en` copy as a
 * fallback + `isFallback: true` when no translation exists, see
 * `VacanciesService.resolveLocalized()`); this file no longer mocks the
 * contract (task-landing-i18n.md round-4 "дорезка" — was a local `.extend()`
 * shim with a `translations` object resolved CLIENT-side, superseded now
 * that Block C's real column + response field exist).
 */
const publicVacancyListSchema = z.array(publicVacancySchema)

/** `?locale=` query suffix — omitted for `en` (the API's own default), matches plan §3 "Публичные эндпоинты принимают `?locale=en|uk|ru|es|pt`". */
function localeQuery(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? '' : `?locale=${locale}`
}

/**
 * GET /api/public/vacancies — only PUBLISHED, mapped to loader data for `/`
 * and `/careers`. Degrades to `[]` on ANY failure (network error, non-2xx,
 * malformed response) instead of throwing — task-landing-seo-prerender.md
 * AC1 requires the build (and `scripts/prerender.mjs`'s headless render of
 * these same routes) to keep working when the API is unreachable, and a
 * transient API blip should never take down the whole landing homepage for a
 * real visitor either (the Careers section already has a real, designed
 * empty state for "0 vacancies" — see `CareersTeaser`/`CareersList` — so this
 * reuses that path rather than an error boundary).
 *
 * PR #398 review MED-1: the 3 failure modes below log a distinct
 * `console.error` prefix (network / HTTP status / malformed body) instead of
 * one generic message — a real multi-hour API outage and a one-off schema
 * regression look identical in the UI ("0 open roles"), but should NOT look
 * identical to whoever is reading browser-console/error-tracking output
 * trying to tell them apart.
 */
export async function fetchVacancies(locale: Locale = DEFAULT_LOCALE): Promise<PublicVacancy[]> {
  let res: Response
  try {
    res = await fetch(`/api/public/vacancies${localeQuery(locale)}`)
  } catch (err) {
    console.error('fetchVacancies: network error — falling back to an empty list', err)
    return []
  }

  if (!res.ok) {
    console.error(`fetchVacancies: API returned HTTP ${res.status} — falling back to an empty list`)
    return []
  }

  try {
    return publicVacancyListSchema.parse(await res.json())
  } catch (err) {
    console.error('fetchVacancies: malformed response body — falling back to an empty list', err)
    return []
  }
}

/**
 * GET /api/public/vacancies/:slug — `null` for the 404 case (DRAFT/missing)
 * AND the 410 case (CLOSED — `VacanciesService.getPublishedRowBySlug` now
 * distinguishes them at the HTTP layer, task-vacancy-i18n-jobposting C5, but
 * this landing route still shows the SAME friendly "Role not found" empty
 * state for both — a closed posting is exactly as unavailable to a visitor
 * as one that never existed; only the 410-vs-404 distinction itself matters
 * for search-engine de-indexing signals, not for what a human sees).
 */
export async function fetchVacancy(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<PublicVacancyDetail | null> {
  const res = await fetch(`/api/public/vacancies/${encodeURIComponent(slug)}${localeQuery(locale)}`)
  if (res.status === 404 || res.status === 410) return null
  if (!res.ok) {
    throw new Error(`Failed to load vacancy (HTTP ${res.status})`)
  }
  return publicVacancyDetailSchema.parse(await res.json())
}

/**
 * Locales (of `NON_DEFAULT_LOCALES`) where THIS vacancy is a fallback
 * (untranslated — showing the original `en` copy) — task-landing-i18n.md
 * round-4 "дорезка", plan §3/A10 "непереведённая — оригинал БЕЗ hreflang на
 * неё" (duplicate-content guard). The public API only ever reports
 * `isFallback` for the ONE locale a request asked about (server-side
 * resolution, see this file's module doc) — there is no single endpoint that
 * returns "which locales are translated" for a slug, so this fetches the
 * PUBLISHED list once per `NON_DEFAULT_LOCALES` entry (uk/ru/es/pt — `en` is
 * never a fallback by construction, no fetch needed for it) and reads each
 * one's own `isFallback` flag for this slug off the LIST response (cheap:
 * same payload every OTHER caller of `fetchVacancies` already needs, not a
 * per-vacancy detail fetch). Called from the vacancy-detail route loaders
 * (BLOCKING, alongside the main `fetchVacancy` call) — not a later/async
 * effect — so the value is stable and known BEFORE the first render commits,
 * matching every other `useDocumentHead` input and avoiding a race with
 * `scripts/prerender.mjs`'s single-capture-per-route assumption.
 *
 * A locale whose list fetch itself fails, or that doesn't (yet) list this
 * slug at all, is conservatively treated as a fallback (excluded) — same
 * "safe default" the pre-Block-C mock used.
 */
export async function fetchVacancyHreflangExcludes(slug: string): Promise<Locale[]> {
  const perLocaleLists = await Promise.all(
    NON_DEFAULT_LOCALES.map((locale) => fetchVacancies(locale)),
  )
  return NON_DEFAULT_LOCALES.filter((locale, i) => {
    const entry = perLocaleLists[i]?.find((v) => v.slug === slug)
    return entry?.isFallback !== false
  })
}

export type SubmitApplicationErrorKind =
  | 'validation'
  | 'too-large'
  | 'unsupported-media'
  | 'duplicate'
  | 'network'

export interface SubmitApplicationResult {
  ok: boolean
  errorKind?: SubmitApplicationErrorKind
  message?: string
}

/**
 * English, user-facing copy per HTTP status — the API's own exception
 * messages are Russian (project-wide server convention, see
 * ZodExceptionFilter) and MUST NOT reach the (English-only, task AC) landing
 * UI. `429` gets the exact copy from docs/design/landing-redesign.md §8.
 */
const ERROR_COPY: Record<SubmitApplicationErrorKind, string> = {
  validation:
    'Something went wrong sending your application. Please check your details and try again.',
  'too-large': 'Your CV file is larger than 5 MB. Please compress it and try again.',
  'unsupported-media': 'Your CV must be a valid PDF file.',
  duplicate: "You've already applied to this role recently.",
  network:
    'Something went wrong sending your application. Please check your details and try again.',
}

function errorKindForStatus(status: number): SubmitApplicationErrorKind {
  switch (status) {
    case 413:
      return 'too-large'
    case 415:
      return 'unsupported-media'
    case 429:
      return 'duplicate'
    default:
      return 'validation'
  }
}

/** POST /api/public/vacancies/:slug/apply — multipart (fields + `resume` PDF). */
export async function submitApplication(
  slug: string,
  formData: FormData,
): Promise<SubmitApplicationResult> {
  let res: Response
  try {
    res = await fetch(`/api/public/vacancies/${encodeURIComponent(slug)}/apply`, {
      method: 'POST',
      body: formData,
    })
  } catch {
    return { ok: false, errorKind: 'network', message: ERROR_COPY.network }
  }

  if (res.ok) return { ok: true }

  const kind = errorKindForStatus(res.status)
  return { ok: false, errorKind: kind, message: ERROR_COPY[kind] }
}

// ---------------------------------------------------------------------------
// Contact form — task-landing-contact-and-hiring-strip.md
// ---------------------------------------------------------------------------

export type SubmitContactErrorKind = 'validation' | 'rate-limited' | 'unavailable' | 'network'

export interface SubmitContactResult {
  ok: boolean
  errorKind?: SubmitContactErrorKind
}

export interface ContactPayload {
  name: string
  company?: string
  email: string
  message: string
  turnstileToken: string
  /** Honeypot — always empty for a real visitor, see ContactForm's hidden field. */
  website: string
}

/**
 * 502 (no ADMIN recipients / Resend send failed after retries — see
 * `ContactService.sendWithRetry`) is mapped to the SAME `'unavailable'`
 * bucket as 503 (Resend not configured at all) — from a visitor's point of
 * view both mean "the form can't deliver right now, use the fallback email",
 * the distinction only matters server-side (telemetry).
 */
function contactErrorKindForStatus(status: number): SubmitContactErrorKind {
  switch (status) {
    case 429:
      return 'rate-limited'
    case 502:
    case 503:
      return 'unavailable'
    default:
      return 'validation'
  }
}

/** POST /api/public/contact — plain JSON, no file upload. */
export async function submitContact(payload: ContactPayload): Promise<SubmitContactResult> {
  let res: Response
  try {
    res = await fetch('/api/public/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false, errorKind: 'network' }
  }

  if (res.ok) return { ok: true }
  return { ok: false, errorKind: contactErrorKindForStatus(res.status) }
}
