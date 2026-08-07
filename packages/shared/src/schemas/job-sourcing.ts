import { z } from 'zod'

/**
 * task-job-sourcing-slice1 — semi-automatic applying to external vacancies.
 *
 * Slice 1 covers the whole working loop: collect vacancies from an external
 * source (DOU RSS), filter them per senior, show one in a modal, open the
 * ORIGINAL posting in a new tab, record the outcome. CV generation and a second
 * source are explicitly the NEXT slices — see §Границы of the task file.
 *
 * UNTRUSTED INPUT (this is the security spine of the module)
 * ---------------------------------------------------------
 * `title`, `companyName`, `descriptionMd` and `url` all originate in a THIRD
 * PARTY's RSS feed. Nothing here may be treated as safe:
 *   - `url` is `https:`-only at BOTH ends (ingest + wire), so a
 *     `javascript:`/`data:` URL from the feed can never reach `window.open`;
 *   - `descriptionMd` is markdown-with-no-raw-HTML by construction — the API
 *     converts the feed's HTML into markdown and drops every tag it does not
 *     understand (apps/api/src/job-sourcing/html-to-markdown.ts), and the web
 *     renders it with react-markdown WITHOUT rehype-raw;
 *   - lengths are capped so a hostile feed cannot blow up a payload.
 *
 * NOT exported from `packages/shared/src/public.ts` — this is CRM-internal and
 * must never end up in the public landing bundle.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Source of a posting. Slice 1 ships exactly ONE value; the enum (rather than a
 * bare string) is what makes adding LinkedIn/Indeed aggregators in slice 2 a
 * matter of appending a member + a provider implementation.
 */
export const jobSourceTypeSchema = z.enum(['DOU_RSS'])

/** Lifecycle of a posting offered to one senior. */
export const jobSuggestionStatusSchema = z.enum(['NEW', 'APPLIED', 'REJECTED'])

/** What an exclusion entry matches on. */
export const jobExclusionKindSchema = z.enum(['COMPANY', 'KEYWORD'])

/**
 * Who the exclusion applies to:
 *   GLOBAL — the whole studio (set by ADMIN/HR);
 *   SENIOR — one senior's personal list.
 */
export const jobExclusionScopeSchema = z.enum(['GLOBAL', 'SENIOR'])

/**
 * Where an exclusion came from:
 *   MANUAL  — typed in by a human, stored in `job_exclusion_filters`;
 *   PROJECT — DERIVED at query time from the senior's own projects (their
 *             clients). Derived entries have no row and cannot be deleted —
 *             they are recomputed on every read, so they can never go stale
 *             (and can never be forgotten, which is the point: the senior's own
 *             client is the one company they must never be offered).
 */
export const jobExclusionOriginSchema = z.enum(['MANUAL', 'PROJECT'])

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

/**
 * `https:`-only URL. Enforced here (not just at ingest) because this is the
 * value the browser hands to `window.open` — a `javascript:` URL smuggled in
 * through the feed would otherwise execute in OUR origin.
 */
export const externalHttpsUrlSchema = z
  .string()
  .url()
  .max(2048)
  // `.url()` alone is NOT enough: `javascript:alert(1)` and `data:text/html,…`
  // are structurally valid URLs and would sail through it. The scheme check is
  // what actually blocks them. Regex rather than `new URL()` because this
  // package is DOM/Node-agnostic (no `URL` global in its tsconfig lib).
  .refine((value) => /^https:\/\/\S+$/i.test(value), 'URL must use https')

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export const jobPostingSchema = z.object({
  id: z.string().uuid(),
  sourceType: jobSourceTypeSchema,
  /** Stable per-source identity — the canonical (query-stripped) posting URL. */
  externalId: z.string().max(2048),
  url: externalHttpsUrlSchema,
  title: z.string().max(500),
  companyName: z.string().max(255),
  /** Cities / "remote" as advertised by the source. */
  location: z.string().max(500).nullable(),
  /** Markdown WITHOUT raw HTML — see the module header. */
  descriptionMd: z.string(),
  publishedAt: z.string().datetime().nullable(),
  collectedAt: z.string().datetime(),
})

// ---------------------------------------------------------------------------
// Suggestion (posting × senior)
// ---------------------------------------------------------------------------

export const jobSuggestionSchema = z.object({
  id: z.string().uuid(),
  seniorId: z.string().uuid(),
  status: jobSuggestionStatusSchema,
  statusChangedAt: z.string().datetime().nullable(),
  statusChangedByName: z.string().nullable(),
  createdAt: z.string().datetime(),
  posting: jobPostingSchema,
})

export const jobSuggestionListSchema = z.object({
  items: z.array(jobSuggestionSchema),
  /** How many NEW suggestions are left for this senior after filtering. */
  total: z.number().int().nonnegative(),
})

/**
 * Status transitions a client may request. `NEW` is deliberately absent: it is
 * the collector's starting state, and letting a client roll a decision back to
 * NEW would re-surface a posting the senior already rejected (AC4).
 */
export const updateJobSuggestionStatusSchema = z.object({
  status: z.enum(['APPLIED', 'REJECTED']),
})

// ---------------------------------------------------------------------------
// Exclusion filters
// ---------------------------------------------------------------------------

export const jobExclusionSchema = z.object({
  /** `null` for PROJECT-derived entries — they have no row to address. */
  id: z.string().uuid().nullable(),
  scope: jobExclusionScopeSchema,
  seniorId: z.string().uuid().nullable(),
  kind: jobExclusionKindSchema,
  value: z.string().max(200),
  /** Canonical form (`normalizeCompanyName`) — what matching actually uses. */
  normalizedValue: z.string().max(200),
  origin: jobExclusionOriginSchema,
  /** Human-readable provenance for derived entries, e.g. a project name. */
  sourceLabel: z.string().max(255).nullable(),
  createdAt: z.string().datetime().nullable(),
})

export const jobExclusionListSchema = z.object({
  items: z.array(jobExclusionSchema),
})

export const createJobExclusionSchema = z.object({
  scope: jobExclusionScopeSchema,
  /** Required for `SENIOR` scope, ignored for `GLOBAL` (validated server-side). */
  seniorId: z.string().uuid().nullable().optional(),
  kind: jobExclusionKindSchema,
  value: z.string().trim().min(2).max(200),
})

// ---------------------------------------------------------------------------
// Collection run (cron + ADMIN-triggered)
// ---------------------------------------------------------------------------

export const jobCollectionResultSchema = z.object({
  sourceType: jobSourceTypeSchema,
  /** Entries the feed returned. */
  fetched: z.number().int().nonnegative(),
  /** Postings inserted (new fingerprints). */
  created: z.number().int().nonnegative(),
  /** Entries whose fingerprint was already known — the dedupe path (AC1). */
  duplicates: z.number().int().nonnegative(),
  /** Entries dropped because they could not be parsed into a posting. */
  invalid: z.number().int().nonnegative(),
  /** NEW suggestion rows created across all eligible seniors. */
  suggestionsCreated: z.number().int().nonnegative(),
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobSourceType = z.infer<typeof jobSourceTypeSchema>
export type JobSuggestionStatus = z.infer<typeof jobSuggestionStatusSchema>
export type JobExclusionKind = z.infer<typeof jobExclusionKindSchema>
export type JobExclusionScope = z.infer<typeof jobExclusionScopeSchema>
export type JobExclusionOrigin = z.infer<typeof jobExclusionOriginSchema>
export type JobPostingDto = z.infer<typeof jobPostingSchema>
export type JobSuggestionDto = z.infer<typeof jobSuggestionSchema>
export type JobSuggestionListDto = z.infer<typeof jobSuggestionListSchema>
export type UpdateJobSuggestionStatusDto = z.infer<typeof updateJobSuggestionStatusSchema>
export type JobExclusionDto = z.infer<typeof jobExclusionSchema>
export type JobExclusionListDto = z.infer<typeof jobExclusionListSchema>
export type CreateJobExclusionDto = z.infer<typeof createJobExclusionSchema>
export type JobCollectionResultDto = z.infer<typeof jobCollectionResultSchema>
