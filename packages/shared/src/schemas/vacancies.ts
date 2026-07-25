import { z } from 'zod'

/**
 * task-vacancies-api — public vacancies (landing) + admin CRUD (CRM).
 *
 * Contract source of truth for:
 *   - public landing endpoints (`GET /api/public/vacancies`, `GET /api/public/
 *     vacancies/:slug`, `POST /api/public/vacancies/:slug/apply`)
 *   - admin CRM endpoints (`/api/vacancies/**`)
 *
 * Vacancies are a hiring channel for new SENIORs — completely separate from
 * the interviews Kanban (that board tracks a candidate a SENIOR is already
 * placing on a project; this module tracks public applicants before they
 * exist as a user at all). No salary fields exist anywhere in this module —
 * do not add them speculatively.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const vacancyDomainSchema = z.enum(['AI', 'EDTECH', 'ECOMMERCE', 'OTHER'])
export type VacancyDomain = z.infer<typeof vacancyDomainSchema>

export const vacancySenioritySchema = z.enum(['SENIOR', 'LEAD'])
export type VacancySeniority = z.infer<typeof vacancySenioritySchema>

export const vacancyEmploymentTypeSchema = z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT'])
export type VacancyEmploymentType = z.infer<typeof vacancyEmploymentTypeSchema>

export const vacancyStatusSchema = z.enum(['DRAFT', 'PUBLISHED', 'CLOSED'])
export type VacancyStatus = z.infer<typeof vacancyStatusSchema>

export const vacancyApplicationStatusSchema = z.enum(['NEW', 'VIEWED', 'REJECTED'])
export type VacancyApplicationStatus = z.infer<typeof vacancyApplicationStatusSchema>

// ---------------------------------------------------------------------------
// i18n — task-vacancy-i18n-jobposting (plan-landing-i18n-seo.md §1/§3,
// owner scope-change 2026-07-25: 5 locales, data-driven so a 6th language is
// a one-line addition to `VACANCY_TRANSLATION_LOCALES` — no controller/form
// changes). `en` is the DB row's own language (title/descriptionMd) and
// never needs a translation entry; the other 4 are optional per-vacancy
// overrides, independently — a vacancy may be translated into some but not
// all of them.
// ---------------------------------------------------------------------------

/** Locales a vacancy CAN be translated into — everything except the `en` default. */
export const VACANCY_TRANSLATION_LOCALES = ['uk', 'ru', 'es', 'pt'] as const
export type VacancyTranslationLocale = (typeof VACANCY_TRANSLATION_LOCALES)[number]

/** All site locales, `en` (default/x-default) first — plan §1 URL scheme. */
export const VACANCY_LOCALES = ['en', ...VACANCY_TRANSLATION_LOCALES] as const

/**
 * `.catch('en')` makes this schema the single safe parser for the public
 * endpoints' `?locale=` query param — garbage/missing input silently
 * resolves to the site default instead of 400ing a public, unauthenticated
 * GET (mirrors the edge's own "unrecognised -> en" fallback, plan §2).
 */
export const vacancyLocaleSchema = z.enum(VACANCY_LOCALES).catch('en')
export type VacancyLocale = z.infer<typeof vacancyLocaleSchema>

/** One locale's translated copy — plan §3 contract shape `{ title, description }`. */
export const vacancyTranslationSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().min(10).max(20_000),
})
export type VacancyTranslation = z.infer<typeof vacancyTranslationSchema>

/**
 * `vacancies.translations` jsonb column — nullable, every locale key
 * optional (built FROM `VACANCY_TRANSLATION_LOCALES`, not hand-enumerated —
 * adding a locale to that one array is the only shared-schema change a 6th
 * language needs).
 */
export const vacancyTranslationsSchema = z.object(
  Object.fromEntries(
    VACANCY_TRANSLATION_LOCALES.map((locale) => [locale, vacancyTranslationSchema.optional()]),
  ) as Record<VacancyTranslationLocale, z.ZodOptional<typeof vacancyTranslationSchema>>,
)
export type VacancyTranslations = z.infer<typeof vacancyTranslationsSchema>

// ---------------------------------------------------------------------------
// JobPosting (Google for Jobs) enrichment — task-vacancy-i18n-jobposting C3.
// All admin-entered, all optional (nullable, never invented): `industry`
// (derived from `domain`) and `occupationalCategory` (constant — the
// business exclusively hires software developers) are computed at the
// seo.ts JSON-LD-builder layer instead, so they are NOT stored fields here.
// ---------------------------------------------------------------------------

export const vacancySeoFieldsSchema = z.object({
  /** Individual skill tags — joined for the JobPosting `skills` Text property. */
  skills: z.array(z.string().min(1).max(60)).max(20).nullable(),
  /** Feeds JobPosting `experienceRequirements.monthsOfExperience`. */
  experienceMonths: z.number().int().min(0).max(600).nullable(),
  qualifications: z.string().max(4000).nullable(),
  responsibilities: z.string().max(4000).nullable(),
  jobBenefits: z.string().max(4000).nullable(),
  workHours: z.string().max(120).nullable(),
})
export type VacancySeoFields = z.infer<typeof vacancySeoFieldsSchema>

// ---------------------------------------------------------------------------
// Public vacancy DTOs
// ---------------------------------------------------------------------------

export const publicVacancySchema = z.object({
  slug: z.string(),
  title: z.string(),
  domain: vacancyDomainSchema,
  seniority: vacancySenioritySchema,
  employmentType: vacancyEmploymentTypeSchema,
  location: z.string(),
  publishedAt: z.string(), // ISO
  /**
   * true when a non-`en` `?locale=` was requested but this vacancy has no
   * translation for it yet — `title`/description below fall back to the
   * original (EN) copy. Landing MUST NOT print hreflang to this locale's
   * URL for this vacancy while true (duplicate-content guard, plan §3).
   */
  isFallback: z.boolean(),
})
export type PublicVacancy = z.infer<typeof publicVacancySchema>

export const publicVacancyDetailSchema = publicVacancySchema.extend({
  descriptionMd: z.string(),
  ...vacancySeoFieldsSchema.shape,
  /** Up to 3 other PUBLISHED vacancies in the same domain (task C8), same locale-resolution as this DTO. */
  relatedVacancies: z.array(publicVacancySchema).max(3),
})
export type PublicVacancyDetail = z.infer<typeof publicVacancyDetailSchema>

// ---------------------------------------------------------------------------
// Admin vacancy DTO (superset — includes DRAFT/CLOSED + admin-only fields)
// ---------------------------------------------------------------------------

export const vacancySchema = publicVacancyDetailSchema
  .omit({ isFallback: true, relatedVacancies: true })
  .extend({
    id: z.uuid(),
    status: vacancyStatusSchema,
    publishedAt: z.string().nullable(), // admin видит и DRAFT
    closedAt: z.string().nullable(),
    applicationsCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    translations: vacancyTranslationsSchema.nullable(),
  })
export type Vacancy = z.infer<typeof vacancySchema>

// ---------------------------------------------------------------------------
// Admin create/update
// ---------------------------------------------------------------------------

export const createVacancySchema = z.object({
  title: z.string().min(3).max(120),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .min(3)
    .max(80),
  descriptionMd: z.string().min(10).max(20_000),
  domain: vacancyDomainSchema,
  // task-vacancies-form-simplify: every position on offer is a full-remote
  // SENIOR role — the create/edit form no longer collects these two fields,
  // so the payload may omit them entirely and let the schema default. Still
  // accepts an explicit override (e.g. a future LEAD/on-site listing created
  // directly via the API) — this only changes what happens when the key is
  // ABSENT, not what's allowed when present.
  seniority: vacancySenioritySchema.default('SENIOR'),
  employmentType: vacancyEmploymentTypeSchema,
  location: z.string().min(2).max(120).default('Remote'),
  // task-vacancy-i18n-jobposting: translations + JobPosting enrichment —
  // deliberately plain `.optional()` (NOT `.default(null)`). `updateVacancySchema`
  // derives from this via `.partial()`; per the Zod v4 `.partial()`+`.default()`
  // gotcha documented below for seniority/location, a `.default()` here would
  // silently inject e.g. `skills: null` into every PATCH that omits it,
  // clobbering an existing value. Plain `.optional()` has no such footgun —
  // an omitted key stays `undefined` both on create AND after `.partial()`,
  // and `VacanciesService.create()` maps `undefined -> null` explicitly.
  translations: vacancyTranslationsSchema.nullable().optional(),
  ...vacancySeoFieldsSchema.partial().shape,
})
export type CreateVacancy = z.infer<typeof createVacancySchema>
/**
 * Input shape (pre-default) — what a caller actually needs to build: a
 * payload that may omit `seniority`/`location` and let the API default them.
 * Use this (not `CreateVacancy`) for anything constructing an outgoing
 * create payload; use `CreateVacancy` for the fully-resolved value (e.g. the
 * `VacanciesService.create()` DTO, which always receives `.parse()` output).
 */
export type CreateVacancyInput = z.input<typeof createVacancySchema>

// NOTE (task-vacancies-form-simplify): do NOT derive `seniority`/`location`
// here via a plain `createVacancySchema.partial()` — Zod v4 changed default
// values to apply even INSIDE `.optional()`-wrapped fields (breaking change
// vs v3: https://zod.dev, "Default values applied within optional fields").
// `.partial()` wraps every field in `.optional()`, so a naive partial would
// silently inject `seniority: 'SENIOR'` / `location: 'Remote'` into EVERY
// partial PATCH that omits them — including pure status transitions like
// `{ status: 'CLOSED' }` — overwriting an existing LEAD / on-site vacancy's
// values on every unrelated edit (verified live against the installed Zod
// version before writing this). Overriding these two keys with a plain
// `.optional()` (no `.default()`) after `.partial()` restores "omitted =
// unchanged" semantics, matching `VacanciesService.update()`'s
// `dto.field !== undefined` no-op guard.
export const updateVacancySchema = createVacancySchema.partial().extend({
  seniority: vacancySenioritySchema.optional(),
  location: z.string().min(2).max(120).optional(),
  status: vacancyStatusSchema.optional(),
})
export type UpdateVacancy = z.infer<typeof updateVacancySchema>

// ---------------------------------------------------------------------------
// Public apply — multipart fields (file `resume` handled separately by the
// controller, not part of this schema)
// ---------------------------------------------------------------------------

export const applyVacancyFieldsSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.email().max(254),
  telegram: z.string().max(120).optional(),
  linkedinUrl: z.url().startsWith('https://').max(300).optional(),
  githubUrl: z.url().startsWith('https://').max(300).optional(),
  coverLetter: z.string().max(2000).optional(),
  turnstileToken: z.string().min(1),
  website: z.string().max(0).optional(), // honeypot
})
export type ApplyVacancyFields = z.infer<typeof applyVacancyFieldsSchema>

// ---------------------------------------------------------------------------
// Admin application DTO
// ---------------------------------------------------------------------------

export const vacancyApplicationSchema = z.object({
  id: z.uuid(),
  vacancyId: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  telegram: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  githubUrl: z.string().nullable(),
  coverLetter: z.string().nullable(),
  resumeSizeBytes: z.number().int(),
  status: vacancyApplicationStatusSchema,
  createdAt: z.string(),
})
export type VacancyApplication = z.infer<typeof vacancyApplicationSchema>

export const updateVacancyApplicationSchema = z.object({
  status: vacancyApplicationStatusSchema,
})
export type UpdateVacancyApplication = z.infer<typeof updateVacancyApplicationSchema>

// ---------------------------------------------------------------------------
// Resume presigned URL
// ---------------------------------------------------------------------------

export const vacancyApplicationResumeUrlSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
})
export type VacancyApplicationResumeUrl = z.infer<typeof vacancyApplicationResumeUrlSchema>
