/**
 * Tailored resume + cover letter for one (job opportunity, senior) pair
 * (spec `docs/superpowers/specs/2026-11-10-tailored-resume-design.md`). The API writes the
 * `tailored_resumes` row; these are its enums, its stored verification shape and the wire DTOs.
 * The verification shape never holds posting text or model text (spec §8).
 */
import { z } from 'zod'
import { RESUME_LIMITS, resumeRenderStatusSchema } from './resume'

export const tailoredRunStatusSchema = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'])
export type TailoredRunStatus = z.infer<typeof tailoredRunStatusSchema>

/** Progress of one run, in the order the pipeline passes them (spec §4 step 3). */
export const tailoredRunStageSchema = z.enum([
  'FETCHING_POSTING',
  'ANALYSING',
  'TAILORING',
  'CHECKING',
  'RENDERING',
  'VISUAL_CHECK',
])
export type TailoredRunStage = z.infer<typeof tailoredRunStageSchema>

/**
 * Why a run failed. Every code a reused verified-base-resume gate throws as `RunFailure.code`
 * is a member, so a caught gate failure maps to itself; any other code maps to INTERNAL_ERROR.
 */
export const tailoredResumeErrorCodeSchema = z.enum([
  'BASE_NOT_VERIFIED',
  'BASE_CHANGED',
  'NON_ENGLISH',
  'NON_LATIN_NAME',
  'WRITER_UNAVAILABLE',
  'DECISION_UNAVAILABLE',
  'ENTAILMENT_UNAVAILABLE',
  'LIMITS_EXHAUSTED',
  'COVER_LETTER_UNGROUNDED',
  'RENDER_FAILED',
  'ATS_CHECK_FAILED',
  'GLYPH_CHECK_FAILED',
  'LAYOUT_UNFIXABLE',
  'VISUAL_CHECK_FAILED',
  'VISUAL_CHECK_UNAVAILABLE',
  'STALLED',
  'INTERNAL_ERROR',
])
export type TailoredResumeErrorCode = z.infer<typeof tailoredResumeErrorCodeSchema>

/** Whether a senior's row may start a run (spec Q2, D1, D17). */
export const tailoredEligibilitySchema = z.enum([
  'READY',
  'NO_VERIFIED_RESUME',
  'NON_ENGLISH',
  'NON_LATIN_NAME',
  'POSTING_PENDING',
])
export type TailoredEligibility = z.infer<typeof tailoredEligibilitySchema>

/** The stored `verification` JSONB: gate results and flags only, never posting or model text. */
export const tailoredVerificationSchema = z.object({
  gates: z.array(
    z.object({
      gate: z.string(),
      ok: z.boolean(),
      items: z.array(z.object({ path: z.string(), reason: z.string() })),
    }),
  ),
  revertedPaths: z.array(z.string()),
  keptFromBase: z.number().int().nonnegative(),
  coverage: z.object({
    matched: z.array(z.string()),
    total: z.number().int().nonnegative(),
  }),
  gaps: z.array(z.string()),
  injectionSuspected: z.boolean(),
  postingPartial: z.boolean(),
  postingTruncated: z.boolean(),
  routes: z.array(z.string()),
})
export type TailoredVerification = z.infer<typeof tailoredVerificationSchema>

/** POST body. `teamId` absent = an ADMIN's studio scope or an HR's first team (spec §9). */
export const tailoredGenerateRequestSchema = z
  .object({ teamId: z.string().uuid().optional(), overwrite: z.boolean() })
  .strict()
export type TailoredGenerateRequest = z.infer<typeof tailoredGenerateRequestSchema>

/** PUT body: HR's edit, bounded by the base resume's own limits (spec §9). */
export const tailoredEditRequestSchema = z
  .object({
    teamId: z.string().uuid().optional(),
    summary: z.string().max(RESUME_LIMITS.summary),
    skills: z.array(z.string().max(RESUME_LIMITS.shortText)).max(RESUME_LIMITS.skills),
    bullets: z
      .array(
        z
          .array(z.string().max(RESUME_LIMITS.bullet))
          .min(1)
          .max(RESUME_LIMITS.bulletsPerExperience),
      )
      .max(RESUME_LIMITS.experience),
    coverLetter: z.string().min(1).max(4000),
  })
  .strict()
export type TailoredEditRequest = z.infer<typeof tailoredEditRequestSchema>

/** Seniors one batch status request may name (D10): a 200-row page goes in two requests. */
export const TAILORED_LIST_MAX_SENIORS = 100

/**
 * The batch GET query (D10). `seniorIds` is comma-separated, trimmed, lower-cased and
 * de-duplicated BEFORE the count; an empty segment or a non-uuid is a 400, never "no filter".
 * The raw bound is the maximum canonical list: 100 ids of 36 characters and 99 commas, plus slack
 * for the spaces a trim removes.
 */
export const tailoredListQuerySchema = z.object({
  teamId: z.string().uuid().optional(),
  seniorIds: z
    .string()
    .max(TAILORED_LIST_MAX_SENIORS * 37 * 2)
    .transform((s) => [...new Set(s.split(',').map((v) => v.trim().toLowerCase()))])
    .pipe(z.array(z.string().uuid()).min(1).max(TAILORED_LIST_MAX_SENIORS)),
})
export type TailoredListQuery = z.infer<typeof tailoredListQuerySchema>

/** One row of the batch status answer: state and eligibility, no text. */
export const tailoredResumeRowSchema = z.object({
  seniorId: z.string().uuid(),
  eligibility: tailoredEligibilitySchema,
  runStatus: tailoredRunStatusSchema.nullable(),
  runStage: tailoredRunStageSchema.nullable(),
  runErrorCode: tailoredResumeErrorCodeSchema.nullable(),
  published: z.boolean(),
  pdfStatus: resumeRenderStatusSchema,
  pdfRenderId: z.string().uuid().nullable(),
  baseChanged: z.boolean(),
})
export type TailoredResumeRowDto = z.infer<typeof tailoredResumeRowSchema>

/** The per-senior GET: the row plus the published variant and its short summary (spec §4 step 4). */
export const tailoredResumeDetailSchema = tailoredResumeRowSchema.extend({
  coverLetter: z.string().nullable(),
  editable: z
    .object({
      summary: z.string(),
      skills: z.array(z.string()),
      experience: z.array(
        z.object({
          company: z.string(),
          role: z.string(),
          period: z.string(),
          bullets: z.array(z.string()),
        }),
      ),
    })
    .nullable(),
  summary: z
    .object({
      keptFromBase: z.number().int().nonnegative(),
      gaps: z.array(z.string()),
      coverage: z.object({
        matched: z.array(z.string()),
        total: z.number().int().nonnegative(),
      }),
      postingPartial: z.boolean(),
    })
    .nullable(),
  generatedAt: z.string().nullable(),
  editedAt: z.string().nullable(),
})
export type TailoredResumeDetailDto = z.infer<typeof tailoredResumeDetailSchema>
