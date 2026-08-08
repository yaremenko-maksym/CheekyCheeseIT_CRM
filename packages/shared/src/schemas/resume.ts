/**
 * Senior resume — canonical structured CV data (task-resume-base).
 *
 * ONE row per senior (`senior_resumes`). The structure below is the SSOT: the
 * uploaded PDF/DOCX is only an INPUT (extracted once, then the system works
 * with the structure, never the file).
 *
 * SECURITY — everything under `content` is UNTRUSTED:
 *   - it originates from a file a human uploaded (or raw text they pasted),
 *   - it then round-trips through an external LLM (Cloudflare Workers AI),
 *     whose output is derived from that same untrusted text and is therefore
 *     equally untrusted.
 * So every field is length-capped here (bounded storage + bounded PDF), and
 * `links[].url` is scheme-restricted to `https:` / `mailto:` — a `javascript:`
 * or `data:` URL must never reach an `<a href>`. The renderers (React escapes
 * by default; the PDF writer draws plain strings) do the rest.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Limits — bounded storage, bounded PDF, bounded prompt
// ---------------------------------------------------------------------------

export const RESUME_LIMITS = {
  summary: 2000,
  shortText: 200,
  bullet: 500,
  skills: 60,
  experience: 30,
  bulletsPerExperience: 20,
  education: 20,
  languages: 20,
  links: 20,
  /** Max characters of raw resume text we ever send to the model (token cap). */
  extractionInputChars: 12_000,
  /**
   * Hard ceiling on how many characters of resume text ever exist in memory —
   * whether pasted by a human or produced by the PDF/DOCX parsers.
   *
   * This is a DoS bound, not a token bound. A perfectly honest 52 KB DOCX can
   * inflate to 50 MiB of characters, and any per-character pass over that
   * (normalisation, regex, JSON) blocks the single-threaded event loop for
   * seconds — with the upload endpoint throttled at 10/min that is tens of
   * seconds of API-wide unavailability per minute. So extraction TRUNCATES to
   * this before it touches the text at all, and the paste endpoint refuses
   * more than this. 200 000 characters is ~25x the longest real CV and
   * normalises in about a millisecond.
   */
  extractionRawChars: 200_000,
  /** Below this the text is not a resume — fail loudly instead of paying for a model call. */
  minExtractableChars: 40,
} as const

// ---------------------------------------------------------------------------
// Extraction state machine
// ---------------------------------------------------------------------------

export const resumeExtractionStatusSchema = z.enum(['QUEUED', 'RUNNING', 'READY', 'FAILED'])
export type ResumeExtractionStatus = z.infer<typeof resumeExtractionStatusSchema>

/**
 * Machine-readable failure reason. The UI maps each to actionable copy — the
 * task is explicit that "something went wrong" is not acceptable, especially
 * for the daily-quota case (which must say WHEN it resets and still let the
 * user fill the form by hand).
 */
export const resumeFailureCodeSchema = z.enum([
  /** File parsed but carried no extractable text (scanned image PDF). */
  'NO_TEXT',
  /** Unsupported / structurally broken source file. */
  'UNREADABLE_FILE',
  /** Model returned non-JSON / schema-invalid output twice in a row. */
  'MODEL_INVALID_JSON',
  /** Cloudflare daily Neuron allowance exhausted (see `quotaResetsAt`). */
  'QUOTA_EXCEEDED',
  /** Workers AI is not configured on this deployment (no account id / token). */
  'AI_NOT_CONFIGURED',
  /** Any other model / transport failure. */
  'MODEL_ERROR',
  /** Swept by the stuck-RUNNING cron (container restarted mid-extraction). */
  'STALLED',
])
export type ResumeFailureCode = z.infer<typeof resumeFailureCodeSchema>

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const shortText = z.string().max(RESUME_LIMITS.shortText)

/**
 * A link carried inside the resume. `url` accepts ONLY `https:` and `mailto:`.
 * This is a `.refine()` on a plain string (NOT a type predicate), so the
 * inferred TS type stays `string` and web forms can bind to it directly (same
 * pattern as the write-boundary refinements in finance.ts).
 */
export const resumeLinkSchema = z.object({
  label: shortText,
  url: z
    .string()
    .max(500)
    .refine((raw) => isSafeResumeUrl(raw), {
      message: 'Ссылка должна начинаться с https:// или mailto:',
    }),
})
export type ResumeLink = z.infer<typeof resumeLinkSchema>

/** ASCII codepoints the WHATWG URL parser removes before reading the scheme. */
const ASCII_TAB = 0x09
const ASCII_LF = 0x0a
const ASCII_CR = 0x0d
/** Everything at or below U+0020 is a "C0 control or space" for trimming. */
const C0_OR_SPACE_MAX = 0x20

/**
 * Reproduce the two normalisation steps the WHATWG URL parser performs BEFORE
 * it reads a URL's scheme:
 *   1. strip leading/trailing C0 controls and spaces;
 *   2. remove EVERY ASCII tab / CR / LF anywhere in the string.
 *
 * Step 2 is the one that matters for safety: a string like
 * `java<TAB>script:alert(1)` is an inert-looking string to a naive prefix
 * check but a live `javascript:` URL to a browser.
 *
 * Written with explicit char codes rather than a regex over control
 * characters — the intent stays readable and no literal control byte has to
 * live in this source file.
 */
function normalizeUrlForSchemeCheck(raw: string): string {
  let start = 0
  let end = raw.length
  while (start < end && raw.charCodeAt(start) <= C0_OR_SPACE_MAX) start += 1
  while (end > start && raw.charCodeAt(end - 1) <= C0_OR_SPACE_MAX) end -= 1

  let out = ''
  for (let i = start; i < end; i += 1) {
    const code = raw.charCodeAt(i)
    if (code === ASCII_TAB || code === ASCII_LF || code === ASCII_CR) continue
    out += raw.charAt(i)
  }
  return out
}

/**
 * Single definition of "safe link", shared by the API (extraction sanitiser),
 * the write schema above and the web renderer — so one layer can never judge a
 * URL safe while another judges it unsafe.
 *
 * Deliberately an ALLOW-LIST of two schemes, and deliberately NOT
 * `new URL(...)`: this package compiles with `lib: ["ES2022"]` (no DOM, no
 * Node globals), so the URL constructor is not in scope here. The scheme is
 * read off the NORMALISED string (see `normalizeUrlForSchemeCheck`),
 * lower-cased and compared. `https:` additionally requires a real `//host`
 * part, so scheme-relative junk (`https:foo`) and empty hosts are rejected.
 *
 * The authority must ALSO be free of a `user:password@` part. Credentials in
 * a URL are a phishing primitive, not a resume feature: `https://github.com@evil.tld`
 * reads as "github.com" to a human skimming the link text but sends the browser
 * to `evil.tld`, and this link comes from an uploaded file plus an LLM — i.e.
 * from an attacker's keyboard. Nothing legitimate in a CV needs them.
 */
export function isSafeResumeUrl(raw: string): boolean {
  // No `normalized === ''` short-circuit: the scheme regex already fails to
  // match an empty string, so the guard would be unreachable-by-outcome — a
  // line no test could ever distinguish from its own deletion.
  const normalized = normalizeUrlForSchemeCheck(raw)

  const scheme = /^([a-zA-Z][a-zA-Z0-9+\-.]*):/.exec(normalized)?.[1]?.toLowerCase()
  if (scheme === 'https') {
    const authority = /^https:\/\/([^/?#\s]+)/i.exec(normalized)?.[1]
    if (authority === undefined) return false
    // `@` anywhere in the authority means credentials (the host is whatever
    // follows the LAST `@`) — reject rather than try to out-parse the browser.
    return !authority.includes('@')
  }
  if (scheme === 'mailto') return normalized.length > 'mailto:'.length
  return false
}

export const resumeExperienceItemSchema = z.object({
  company: shortText,
  role: shortText,
  /** Free-form period ("2021 — наст. время"). Deliberately not a date range. */
  period: shortText,
  bullets: z.array(z.string().max(RESUME_LIMITS.bullet)).max(RESUME_LIMITS.bulletsPerExperience),
})
export type ResumeExperienceItem = z.infer<typeof resumeExperienceItemSchema>

export const resumeEducationItemSchema = z.object({
  institution: shortText,
  degree: shortText,
  period: shortText,
})
export type ResumeEducationItem = z.infer<typeof resumeEducationItemSchema>

export const resumeLanguageItemSchema = z.object({
  name: shortText,
  level: shortText,
})
export type ResumeLanguageItem = z.infer<typeof resumeLanguageItemSchema>

export const resumeContentSchema = z.object({
  summary: z.string().max(RESUME_LIMITS.summary),
  skills: z.array(shortText).max(RESUME_LIMITS.skills),
  experience: z.array(resumeExperienceItemSchema).max(RESUME_LIMITS.experience),
  education: z.array(resumeEducationItemSchema).max(RESUME_LIMITS.education),
  languages: z.array(resumeLanguageItemSchema).max(RESUME_LIMITS.languages),
  links: z.array(resumeLinkSchema).max(RESUME_LIMITS.links),
})
export type ResumeContent = z.infer<typeof resumeContentSchema>

/** Empty canonical content — used for a brand-new resume and by the UI. */
export const EMPTY_RESUME_CONTENT: ResumeContent = {
  summary: '',
  skills: [],
  experience: [],
  education: [],
  languages: [],
  links: [],
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

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
})
export type SeniorResumeResponse = z.infer<typeof seniorResumeResponseSchema>

// ---------------------------------------------------------------------------
// Write payloads
// ---------------------------------------------------------------------------

/**
 * PUT /users/:userId/resume — replaces the whole canonical content. The UI
 * edits section by section but always submits the full object, so a save can
 * never leave two sections written by different base versions.
 */
export const updateResumeContentSchema = z.object({
  content: resumeContentSchema,
})
export type UpdateResumeContentInput = z.infer<typeof updateResumeContentSchema>

/**
 * POST /users/:userId/resume/text — the "no usable file" fallback: the user
 * pastes the resume as plain text and it goes through the SAME extraction
 * pipeline as an uploaded file.
 */
export const ingestResumeTextSchema = z.object({
  text: z
    .string()
    .min(RESUME_LIMITS.minExtractableChars, 'Текст резюме слишком короткий')
    // Same ceiling the file path truncates to — one number, so pasted text and
    // extracted text can never disagree about how much text may exist.
    .max(RESUME_LIMITS.extractionRawChars),
})
export type IngestResumeTextInput = z.infer<typeof ingestResumeTextSchema>

// ---------------------------------------------------------------------------
// Source-file constraints (upload endpoint)
// ---------------------------------------------------------------------------

export const RESUME_SOURCE_MAX_BYTES = 10 * 1024 * 1024
export const RESUME_PDF_MIME = 'application/pdf'
export const RESUME_DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
