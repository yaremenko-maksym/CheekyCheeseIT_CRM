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
})
export type PublicVacancy = z.infer<typeof publicVacancySchema>

export const publicVacancyDetailSchema = publicVacancySchema.extend({
  descriptionMd: z.string(),
})
export type PublicVacancyDetail = z.infer<typeof publicVacancyDetailSchema>

// ---------------------------------------------------------------------------
// Admin vacancy DTO (superset — includes DRAFT/CLOSED + admin-only fields)
// ---------------------------------------------------------------------------

export const vacancySchema = publicVacancyDetailSchema.extend({
  id: z.uuid(),
  status: vacancyStatusSchema,
  publishedAt: z.string().nullable(), // admin видит и DRAFT
  closedAt: z.string().nullable(),
  applicationsCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
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
  seniority: vacancySenioritySchema,
  employmentType: vacancyEmploymentTypeSchema,
  location: z.string().min(2).max(120),
})
export type CreateVacancy = z.infer<typeof createVacancySchema>

export const updateVacancySchema = createVacancySchema
  .partial()
  .extend({ status: vacancyStatusSchema.optional() })
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
