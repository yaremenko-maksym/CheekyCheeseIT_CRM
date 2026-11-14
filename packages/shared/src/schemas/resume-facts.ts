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
import {
  RESUME_LIMITS,
  resumeContentSchema,
  resumeExtractionStatusSchema,
  resumeFailureCodeSchema,
  resumeLayoutOptionsSchema,
  resumeLinkSchema,
  resumeRenderStatusSchema,
} from './resume'

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

/** An education year; the completeness check reads its bounds (R66). */
export const resumeYear = z.number().int().min(1950).max(2100)

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

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------
// Lives here, not in resume.ts: it embeds the facts/verification schemas above,
// and resume.ts importing this file back would be a load-order cycle.

/** Staged fields a person edited by hand, and who (the `staged_edited_paths` column). */
export const resumeStagedEditedPathsSchema = z.array(
  z.object({ path: z.string(), userId: z.uuid() }),
)

export const seniorResumeDtoSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  content: resumeContentSchema,
  status: resumeExtractionStatusSchema,
  errorCode: resumeFailureCodeSchema.nullable(),
  /** Human-readable detail for FAILED (already Russian, safe to render). */
  errorMessage: z.string().nullable(),
  /** ISO — when the Cloudflare daily allowance resets (QUOTA_EXCEEDED only). */
  quotaResetsAt: z.string().nullable(),
  sourceFileName: z.string().nullable(),
  sourceFileSizeBytes: z.number().int().nonnegative().nullable(),
  /** True when an original file is stored and downloadable. */
  hasSourceFile: z.boolean(),
  /**
   * Bumped on every content save. task-resume-tailoring uses it to detect
   * tailored variants built from a now-stale base.
   */
  version: z.number().int().nonnegative(),
  updatedByUserId: z.string().uuid().nullable(),
  updatedByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),

  // --- layout half of the "template + data" split ---------------------------
  /** The switches HR flipped. Always normalised (total order, no duplicates). */
  layout: resumeLayoutOptionsSchema,
  /**
   * Which template typesets this resume. A LABEL, never the source: the
   * template is code and stays server-side, which is the property the whole
   * split exists to guarantee.
   */
  templateName: resumeTemplateNameSchema,
  /** False while the senior is still on the repo's default template. */
  hasCustomTemplate: z.boolean(),

  // --- rendered PDF ---------------------------------------------------------
  renderStatus: resumeRenderStatusSchema,
  /** Russian, safe to display — set together with `renderStatus: 'FAILED'`. */
  renderError: z.string().nullable(),
  /**
   * True when a rendered PDF exists AND was built from exactly the current
   * content + layout + template. The UI uses it to decide between "скачать" and
   * "готовим предпросмотр" — a stale PDF is never offered as the current one.
   */
  pdfUpToDate: z.boolean(),

  // --- verification (verified base resume) ----------------------------------
  /** What HR entered. A legacy row never saved since is mapped from `content`. */
  facts: resumeFactsSchema,
  verificationStatus: resumeVerificationStatusSchema,
  verificationErrorCode: resumeVerificationErrorCodeSchema.nullable(),
  verificationReport: resumeVerificationReportSchema.nullable(),
  /** VERIFIED means `verifiedVersion === version`. */
  verifiedVersion: z.number().int().nonnegative().nullable(),
  verifiedAt: z.string().nullable(),
  verifiedByName: z.string().nullable(),
  /** The check run's result awaiting Confirm; null unless a staged PDF exists. */
  staged: z
    .object({
      runId: z.uuid(),
      content: resumeContentSchema,
      layout: resumeLayoutOptionsSchema,
      templateName: resumeTemplateNameSchema,
      pdfAvailable: z.boolean(),
      editedPaths: resumeStagedEditedPathsSchema,
    })
    .nullable(),
  /** A run is in flight (also a template run on a VERIFIED resume): writes answer 409. */
  verificationBusy: z.boolean(),
})
export type SeniorResumeDto = z.infer<typeof seniorResumeDtoSchema>

/**
 * Every resume endpoint answers with this envelope.
 *
 * `resume` is `null` when the senior has no resume row yet — but `canEdit` is
 * a property of the (viewer, target) PAIR, not of the row, so it lives OUTSIDE
 * and is always present. That distinction is load-bearing: with `canEdit`
 * inside a nullable DTO, the empty state carried no permission signal at all
 * and the UI had to either guess (defaulting to read-only, which would hide
 * the upload button from the very people meant to create the resume) or
 * re-derive the RBAC rule client-side. Server-computed, never echoed back.
 */
export const seniorResumeResponseSchema = z.object({
  resume: seniorResumeDtoSchema.nullable(),
  canEdit: z.boolean(),
  /** Confirm is ADMIN/HR only — a viewer property, like `canEdit`. */
  canConfirm: z.boolean(),
})
export type SeniorResumeResponse = z.infer<typeof seniorResumeResponseSchema>
