import { z } from 'zod'
// The keyword caps are OWNED by the matcher (which is what builds a canonical
// keyword) and imported here rather than restated. Security review HIGH-1: the
// two numbers had drifted apart — the resume layer allowed 200 characters per
// skill while this contract allowed 100 — and the gap surfaced as a 400 on
// GET /suggestions for the first senior with a filled-in resume.
import { MAX_STACK_KEYWORD_CHARS, MAX_STACK_KEYWORDS } from '../utils/stack-keywords'

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
 *     understand (apps/api/src/job-sourcing/html-to-markdown.ts). Note that
 *     "no raw HTML" is only half the story: a MARKDOWN-level payload (an image
 *     beacon, a phishing link) needs its own defence, which lives in the web
 *     renderer's explicit `urlTransform` / `img` / `a` props — see
 *     apps/web/app/components/job-sourcing/JobSuggestionDialog.tsx;
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
 * The period a source's request budget is measured over — task-vacancy-matching
 * §4. Deliberately an enum of the windows real providers actually publish
 * rather than a free interval: Adzuna caps 250 A DAY, JSearch 200 A MONTH.
 */
export const jobSourceBudgetWindowSchema = z.enum(['DAY', 'MONTH'])

/**
 * How a source is allowed to be collected — task-vacancy-matching §5.
 *
 * The distinction is forced by arithmetic, not taste: JSearch allows 200
 * requests A MONTH, i.e. about six a day. On a schedule it is useless; aimed by
 * hand at one senior it is plenty. So each source declares whether the cron may
 * touch it, whether a human may, or both.
 */
export const jobSourceTriggerModeSchema = z.enum(['SCHEDULED', 'MANUAL', 'BOTH'])

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

  // --- stack match (task-vacancy-matching §2/§3) ----------------------------
  /**
   * Share of the senior's stack this posting mentions, `0..1`.
   *
   * `null` means NOT RANKED — the senior has no stack on file, so the queue
   * falls back to pure freshness. Deliberately distinct from `0` ("we compared
   * and it matches nothing"): the UI must be able to say "ранжирование
   * выключено, заполните резюме" instead of implying every vacancy is a bad fit.
   */
  matchScore: z.number().min(0).max(1).nullable(),
  /**
   * Canonical stack keywords the posting actually mentions — the WHY behind the
   * score. Shown as chips so a hidden vacancy is auditable rather than a mystery.
   */
  matchedKeywords: z.array(z.string().max(MAX_STACK_KEYWORD_CHARS)).max(MAX_STACK_KEYWORDS),
})

export const jobSuggestionListSchema = z.object({
  /** Above-threshold suggestions, best match first, then newest first. */
  items: z.array(jobSuggestionSchema),
  /**
   * Below-threshold suggestions. Carried in the SAME payload on purpose:
   * "скрытая вакансия — это нерассмотренная вакансия", so the UI collapses them
   * behind a counter it can expand instantly, and nothing is quietly dropped.
   */
  lowMatch: z.array(jobSuggestionSchema),
  /**
   * How many suggestions fell below the threshold. Its own field rather than
   * `lowMatch.length` because the array is page-capped and the COUNT is the
   * honest number the counter has to show.
   */
  lowMatchCount: z.number().int().nonnegative(),
  /** How many NEW suggestions are left for this senior after filtering. */
  total: z.number().int().nonnegative(),
  /** The threshold actually applied, echoed so the UI can explain the split. */
  threshold: z.number().min(0).max(1),
  /**
   * The senior's effective stack (canonical form). EMPTY means unranked — see
   * `matchScore`. Echoed so the UI can name what it matched on.
   */
  stackKeywords: z.array(z.string().max(MAX_STACK_KEYWORD_CHARS)).max(MAX_STACK_KEYWORDS),
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

/**
 * One source that could not be collected. Reported ALONGSIDE the successful
 * results rather than only logged: `POST /job-sourcing/collect` used to answer
 * `200 []` when a source was broken, which is byte-for-byte what a quiet day
 * looks like — the admin who pressed the button had no way to tell "nothing new
 * today" from "the feed changed shape and we have been blind for a week".
 */
export const jobCollectionFailureSchema = z.object({
  sourceType: jobSourceTypeSchema,
  message: z.string().max(1000),
  /**
   * True when the source refused because its request budget is spent, rather
   * than because the feed broke. A budget stop is a NORMAL, expected state that
   * resolves itself when the window rolls over; a broken feed is not. The UI
   * must not dress the first up as an incident, nor the second down as routine.
   */
  budgetExhausted: z.boolean(),
})

// ---------------------------------------------------------------------------
// Source budgets (task-vacancy-matching §4/§5)
// ---------------------------------------------------------------------------

/**
 * A source's request budget, as the UI sees it.
 *
 * The remaining allowance is shown the same way the model's daily quota is
 * (ResumeStatusPanel): a number plus WHEN it comes back. A collector that has
 * stopped must never look like a collector that found nothing.
 */
export const jobSourceBudgetSchema = z.object({
  /** Requests permitted per window. `null` = no published limit (DOU's feed). */
  limit: z.number().int().positive().nullable(),
  window: jobSourceBudgetWindowSchema.nullable(),
  /** Requests already spent in the CURRENT window. */
  used: z.number().int().nonnegative(),
  /**
   * Requests left in the current window. `null` when unlimited — deliberately
   * not `Infinity`, which does not survive JSON.
   */
  remaining: z.number().int().nonnegative().nullable(),
  /** ISO instant at which `used` resets to 0. `null` when unlimited. */
  resetsAt: z.string().datetime().nullable(),
})

export const jobSourceSchema = z.object({
  id: z.string().uuid(),
  type: jobSourceTypeSchema,
  enabled: z.boolean(),
  triggerMode: jobSourceTriggerModeSchema,
  lastCollectedAt: z.string().datetime().nullable(),
  budget: jobSourceBudgetSchema,
})

export const jobSourceListSchema = z.object({
  items: z.array(jobSourceSchema),
})

export const jobCollectionRunSchema = z.object({
  results: z.array(jobCollectionResultSchema),
  failures: z.array(jobCollectionFailureSchema),
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
export type JobCollectionFailureDto = z.infer<typeof jobCollectionFailureSchema>
export type JobCollectionRunDto = z.infer<typeof jobCollectionRunSchema>
export type JobSourceBudgetWindow = z.infer<typeof jobSourceBudgetWindowSchema>
export type JobSourceTriggerMode = z.infer<typeof jobSourceTriggerModeSchema>
export type JobSourceBudgetDto = z.infer<typeof jobSourceBudgetSchema>
export type JobSourceDto = z.infer<typeof jobSourceSchema>
export type JobSourceListDto = z.infer<typeof jobSourceListSchema>
