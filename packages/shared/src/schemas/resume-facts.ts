/**
 * Verified base resume — the FACTS HR enters, the template catalog, and the
 * verification state the server reports.
 *
 * Facts are the input: HR types them, the AI writer later turns them into
 * summary/bullets (`resumeContentSchema`), and HR/ADMIN confirms the result.
 * Facts are as UNTRUSTED as content (a human typed them, and they are sent to
 * a model), so every field is length-capped with the same `RESUME_LIMITS` and
 * links reuse the scheme-restricted `resumeLinkSchema`.
 *
 * A DRAFT may be incomplete (e.g. `start: null`); completeness is enforced at
 * Submit, not by this schema.
 */
import { z } from 'zod'
import { RESUME_LIMITS, resumeLinkSchema } from './resume'

const shortText = z.string().max(RESUME_LIMITS.shortText)

/** `YYYY-MM`, year 1950-2100 (as `resumeYear`), month 01-12. */
export const resumeMonthSchema = z.string().regex(/^(19[5-9]\d|20\d\d|2100)-(0[1-9]|1[0-2])$/)

export const resumeFactsExperienceSchema = z.object({
  company: shortText,
  role: shortText,
  location: shortText.nullable(),
  start: resumeMonthSchema.nullable(),
  end: resumeMonthSchema.nullable(),
  current: z.boolean(),
  technologies: z.array(shortText).max(RESUME_LIMITS.skills),
  notes: z.array(z.string().max(RESUME_LIMITS.bullet)).max(RESUME_LIMITS.bulletsPerExperience),
})
export type ResumeFactsExperience = z.infer<typeof resumeFactsExperienceSchema>

export const RESUME_WORK_FORMATS = ['remote', 'hybrid', 'onsite'] as const
export const RESUME_LANGUAGE_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'] as const

const resumeYear = z.number().int().min(1950).max(2100)

export const resumeFactsSchema = z.object({
  headline: shortText,
  location: z.object({ city: shortText, country: shortText }),
  workFormat: z.enum(RESUME_WORK_FORMATS).nullable(),
  skills: z.array(shortText).max(RESUME_LIMITS.skills),
  experience: z.array(resumeFactsExperienceSchema).max(RESUME_LIMITS.experience),
  education: z
    .array(
      z.object({
        institution: shortText,
        degree: shortText,
        startYear: resumeYear.nullable(),
        endYear: resumeYear.nullable(),
      }),
    )
    .max(RESUME_LIMITS.education),
  languages: z
    .array(
      z.object({
        name: shortText,
        level: z.enum(RESUME_LANGUAGE_LEVELS),
      }),
    )
    .max(RESUME_LIMITS.languages),
  links: z.array(resumeLinkSchema).max(RESUME_LIMITS.links),
})
export type ResumeFacts = z.infer<typeof resumeFactsSchema>

/** Empty facts — a brand-new resume and the UI's starting form. */
export const EMPTY_RESUME_FACTS: ResumeFacts = {
  headline: '',
  location: { city: '', country: '' },
  workFormat: null,
  skills: [],
  experience: [],
  education: [],
  languages: [],
  links: [],
}

// ---------------------------------------------------------------------------
// Template catalog
// ---------------------------------------------------------------------------

export const RESUME_TEMPLATE_NAMES = ['classic', 'modern', 'compact', 'technical'] as const
export const resumeTemplateNameSchema = z.enum(RESUME_TEMPLATE_NAMES)
export type ResumeTemplateName = z.infer<typeof resumeTemplateNameSchema>

// ---------------------------------------------------------------------------
// Verification state
// ---------------------------------------------------------------------------

export const resumeVerificationStatusSchema = z.enum([
  'DRAFT',
  'QUEUED',
  'CHECKING',
  'AWAITING_CONFIRM',
  'VERIFIED',
  'FAILED',
])
export type ResumeVerificationStatus = z.infer<typeof resumeVerificationStatusSchema>

export const resumeVerificationErrorCodeSchema = z.enum([
  'INCOMPLETE',
  'CUSTOM_TEMPLATE',
  'WRITER_UNAVAILABLE',
  'ENTAILMENT_UNAVAILABLE',
  'RENDER_FAILED',
  'ATS_CHECK_FAILED',
  'GLYPH_CHECK_FAILED',
  'LAYOUT_UNFIXABLE',
  'VISUAL_CHECK_FAILED',
  'VISUAL_CHECK_UNAVAILABLE',
  'STALLED',
])
export type ResumeVerificationErrorCode = z.infer<typeof resumeVerificationErrorCodeSchema>

export const resumeVerificationReportSchema = z.object({
  gates: z.array(
    z.object({
      gate: z.string(),
      ok: z.boolean(),
      items: z.array(z.object({ path: z.string(), reason: z.string() })),
    }),
  ),
  /** Content paths that reverted to the HR note text. */
  fallbacks: z.array(z.string()),
})
export type ResumeVerificationReport = z.infer<typeof resumeVerificationReportSchema>

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const updateResumeFactsSchema = z.object({ facts: resumeFactsSchema })
export type UpdateResumeFactsInput = z.infer<typeof updateResumeFactsSchema>

export const updateResumeTemplateSchema = z.object({ templateName: resumeTemplateNameSchema })
export type UpdateResumeTemplateInput = z.infer<typeof updateResumeTemplateSchema>

export const confirmResumeSchema = z.object({ runId: z.uuid(), version: z.number().int().min(0) })
export type ConfirmResumeInput = z.infer<typeof confirmResumeSchema>

export const editStagedFieldSchema = z.object({
  runId: z.uuid(),
  path: shortText,
  // The larger of the summary/bullet caps; the server enforces the per-path cap.
  text: z.string().max(RESUME_LIMITS.summary),
})
export type EditStagedFieldInput = z.infer<typeof editStagedFieldSchema>

export const regenerateStagedFieldSchema = z.object({ runId: z.uuid(), path: shortText })
export type RegenerateStagedFieldInput = z.infer<typeof regenerateStagedFieldSchema>
