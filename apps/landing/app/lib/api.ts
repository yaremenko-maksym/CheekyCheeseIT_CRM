import { z } from 'zod'
import {
  publicVacancyDetailSchema,
  publicVacancySchema,
  type PublicVacancy,
  type PublicVacancyDetail,
} from '@crm/shared'

/**
 * Same-origin `fetch` against `/api` (docs/superpowers/specs/2026-07-22-landing-refactor-design.md
 * §2.3) — nginx proxies `/api` in prod, `vite.config.ts` proxies it in dev. No
 * react-query on the landing (product decision — YAGNI for 3 read-mostly
 * routes), no base-URL config needed.
 */

const publicVacancyListSchema = z.array(publicVacancySchema)

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
export async function fetchVacancies(): Promise<PublicVacancy[]> {
  let res: Response
  try {
    res = await fetch('/api/public/vacancies')
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
 * GET /api/public/vacancies/:slug — `null` for the 404 case (DRAFT/CLOSED/
 * missing; the API deliberately does not distinguish these, see
 * VacanciesService.getPublicBySlug). The route turns `null` into the
 * "Role not found" empty state (docs/design/landing-redesign.md §8), never a
 * raw browser 404.
 */
export async function fetchVacancy(slug: string): Promise<PublicVacancyDetail | null> {
  const res = await fetch(`/api/public/vacancies/${encodeURIComponent(slug)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to load vacancy (HTTP ${res.status})`)
  }
  return publicVacancyDetailSchema.parse(await res.json())
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
