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

/** GET /api/public/vacancies — only PUBLISHED, mapped to loader data for `/` and `/careers`. */
export async function fetchVacancies(): Promise<PublicVacancy[]> {
  const res = await fetch('/api/public/vacancies')
  if (!res.ok) {
    throw new Error(`Failed to load vacancies (HTTP ${res.status})`)
  }
  return publicVacancyListSchema.parse(await res.json())
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
