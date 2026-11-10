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
 * Source of a posting. The enum (rather than a bare string) is what makes
 * adding a source a matter of appending a member + a provider implementation.
 * Order is the pg-enum order (`job_source_type`); `DOU_RSS` stays first.
 */
export const jobSourceTypeSchema = z.enum([
  'DOU_RSS',
  'REMOTEOK_API',
  'REMOTIVE_API',
  'HIMALAYAS_API',
  'JOBICY_API',
  'ARBEITNOW_API',
  'WORKINGNOMADS_API',
  'JOBGETHER_API',
  'HN_HIRING',
  'GREENHOUSE_ATS',
  'LEVER_ATS',
  'ASHBY_ATS',
  'WORKABLE_ATS',
  'SMARTRECRUITERS_ATS',
  'RECRUITEE_ATS',
  'PERSONIO_ATS',
  'JOOBLE_API',
  'JSEARCH_API',
  'THEIRSTACK_API',
  'MUSE_API',
  'REED_API',
  'DJINNI_RSS',
  'WWR_RSS',
  'EUREMOTEJOBS_RSS',
  'JUSTJOIN_HTML',
  'NOFLUFF_HTML',
  'LANDINGJOBS_HTML',
  'NEXTLEVELJOBS_HTML',
  'DICE_HTML',
  'THEHUB_HTML',
  'WTTJ_HTML',
])

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

/** The scheme and authority shape; see `externalHttpsUrlSchema` below for what it is and is not. */
const EXTERNAL_HTTPS_URL_PATTERN = /^https:\/\/[^/?#@]+([/?#]\S*)?$/i

/**
 * `https:`-only URL with a host and no embedded credentials.
 *
 * MIRRORS, DELIBERATELY RATHER THAN COINCIDENTALLY, two other guards on the same
 * value, and the three are to be changed together:
 *   * `HTTPS_URL_PATTERN` — the CHECK on every stored navigation URL, in
 *     `apps/api/src/database/schema/job-opportunities.ts`;
 *   * `isSafeExternalUrl` — the last barrier before `window.open`, in
 *     `apps/web/app/components/job-sourcing/open-original.ts`.
 *
 * THIS COMMENT IS ALL THAT HOLDS THE THREE TOGETHER — they are kept in step by
 * hand. A shared corpus (one list of URLs, an absolute verdict per guard, run
 * against all three) was written for this and then taken back out of the PR,
 * because placing it outside the mutation gate's globs and outside this package's
 * public API needed build configuration; it is deferred to a follow-up PR. An
 * earlier revision of this comment named that corpus as the mechanism, which
 * promised a gate that exists nowhere. Until it lands, each guard is pinned only
 * by its own named tests — change one predicate and you must go and read the
 * other two.
 *
 * Enforced here, and not only at ingest, because this is the value the browser
 * hands to `window.open`: a `javascript:` URL smuggled in through a feed would
 * execute in OUR origin, and a credentialed one (`https://user:pw@evil.test/a`)
 * would show the user a plausible host while opening someone else's page.
 *
 * R11-H-4 is why the authority clause exists: the refinement used to be
 * `^https://\S+$`, whose `\S+` matches an authority containing `@`, so this
 * guard was WEAKER than the column the value comes out of — which already
 * refused it. A guard on a value may not be weaker than its column.
 */
export const externalHttpsUrlSchema = z
  .string()
  .url()
  .max(2048)
  // `.url()` alone is NOT enough: `javascript:alert(1)` and `data:text/html,…`
  // are structurally valid URLs and would sail through it. The scheme check is
  // what actually blocks them. Regex rather than `new URL()` because this
  // package is DOM/Node-agnostic (no `URL` global in its tsconfig lib).
  //
  // The authority — everything up to the first `/`, `?` or `#` — must be
  // non-empty and free of `@`. A path, query or fragment may follow and MAY
  // contain `@`: `https://host/a@b` is an ordinary posting URL, and refusing it
  // would silently drop legitimate postings. Whitespace is excluded from the
  // path (`\S*`) because `.url()` does NOT refuse it there — WHATWG
  // percent-encodes a space in a path and accepts the URL — but it is NOT
  // excluded from the authority, where `.url()` already refuses it (a space is
  // illegal in a host, measured: `https:// x` fails `.url()` on its own).
  //
  // That is the one deliberate difference from the column's
  // `^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$`: the CHECK has no
  // `.url()` in front of it and must therefore state the authority's whitespace
  // exclusion itself, as does `isSafeExternalUrl`, which is a bare regex. The
  // authority SHAPE — non-empty, no `@` — is identical in all three, and that is
  // what R11-H-4 was about. The operand was dropped here rather than carried as
  // dead redundancy because no input can distinguish it (`.url()` refuses first),
  // so no test could pin it, and a line-scoped mutation suppression would have
  // hidden the `@` and non-empty mutants too — the two that carry the security
  // property.
  .refine(
    (value) => EXTERNAL_HTTPS_URL_PATTERN.test(value),
    'URL must be https, with a host and no embedded credentials',
  )

/** Upper bound for a posting description (~8000 words of markdown). */
export const DESCRIPTION_MD_MAX = 50000

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
  // SECURITY: UNTRUSTED 3rd-party markdown. Bound caps DoS; must be sanitized (no raw HTML) on render in HR UI — future ingest phase.
  descriptionMd: z.string().max(DESCRIPTION_MD_MAX),
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

/**
 * SFS U10 (ADR 6a, step 2 "Want"): the result of HR/SENIOR/ADMIN opening an opportunity. Opening
 * enqueues one `DETAIL_FETCH` per backing ON_DEMAND record whose detail is still missing — a
 * database write only, never an external call, de-duplicated by the dirty-work unique key (fetch
 * once). `detailEnqueued` counts the rows this call inserted; `detailPending` is whether the
 * opportunity still awaits any detail (so the view shows the degrade state until the pass runs).
 */
export const openJobOpportunityResultSchema = z.object({
  opportunityId: z.string().uuid(),
  detailEnqueued: z.number().int().nonnegative(),
  detailPending: z.boolean(),
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
  /** Postings folded into an existing cross-source twin (`also_seen_on`). */
  merged: z.number().int().nonnegative().default(0),
  /** Postings dropped by the relevance funnel (remote / seniority / stack / exclusions). */
  filtered: z.number().int().nonnegative().default(0),
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
/**
 * What the budget IS, decided server-side — code review MED-4.
 *
 * The UI used to infer this from `limit === null || window === null`, and that
 * inference read a MISCONFIGURED source (a limit with no window, or a limit the
 * arithmetic refuses to believe) as "без лимита запросов" — i.e. it displayed a
 * collector that is refusing everything as one with no restriction at all. A
 * limiter that has received nonsense must present as STRICTER, never weaker, so
 * the distinction is now stated by the server rather than guessed by the client.
 *
 *   UNLIMITED      — no cap published for this source (DOU's feed)
 *   ACTIVE         — cap configured, requests still available
 *   EXHAUSTED      — cap configured, spent for this window (comes back at reset)
 *   MISCONFIGURED  — cap present but unusable (no window, or a value the
 *                    arithmetic will not trust). Collection is REFUSED, and this
 *                    needs a human, not a wait.
 */
export const jobSourceBudgetStateSchema = z.enum([
  'UNLIMITED',
  'ACTIVE',
  'EXHAUSTED',
  'MISCONFIGURED',
])

export const jobSourceBudgetSchema = z.object({
  state: jobSourceBudgetStateSchema,
  /**
   * Requests permitted per window. `null` = no published limit (DOU's feed).
   *
   * `.nonnegative()`, NOT `.positive()`: a broken limit resolves to 0 remaining
   * — the deliberately strictest reading — and `.positive()` rejected exactly
   * that value, turning a misconfigured source into a 400 on the whole
   * `/sources` response instead of a visible warning on one row.
   */
  limit: z.number().int().nonnegative().nullable(),
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

/**
 * The eight health states (ADR section 10; source-fetch-strategy U7). Declared HERE (r5 Task 6.5)
 * so `jobSourceSchema` below can carry the current state: job-source-admin.ts imports this module,
 * so the reverse import would be circular. The vocabulary mirrors `HEALTH_STATE_VALUES` in
 * apps/api/src/database/schema/job-health.ts (held to it by job-source-health-schema.spec.ts).
 */
export const jobHealthStateSchema = z.enum([
  'BLOCKED',
  'CAPPED',
  'PAUSED',
  'FAILING',
  'EMPTY',
  'DEGRADED',
  'SILENT',
  'HEALTHY',
])

export const jobSourceSchema = z.object({
  id: z.string().uuid(),
  type: jobSourceTypeSchema,
  enabled: z.boolean(),
  triggerMode: jobSourceTriggerModeSchema,
  lastCollectedAt: z.string().datetime().nullable(),
  // `minIntervalHours` was removed in U7 (source fetch strategy): U1b stopped it from driving
  // cadence, leaving a stale field no reader used. The cadence now appears on the ADMIN source page
  // as `jobSourceProfileSummarySchema` (job-source-admin.ts). The `min_interval_hours` COLUMN stays
  // until U9 drops it on the owner's separate word.
  disabledReason: z.string().max(500).nullable(),
  budget: jobSourceBudgetSchema,

  // r5 Task 6.5 — ADDITIVE operational facts, every one optional so an older server's answer and
  // an older client's fixture (`SourceBudgetPanel`) still parse. Read off existing columns only:
  // `enabled`, the admin state and readiness are three separate states (pause ≠ disable, A1k).
  // `z.lazy`: these schemas are declared further down this module (a `const` read here at module
  // init would be in its temporal dead zone); the lazy reads them at parse time.
  readiness: z.lazy(() => jobSourceReadinessSchema).optional(),
  readinessReason: z.string().max(500).nullable().optional(),
  adminState: z.lazy(() => jobSourceAdminStateSchema).optional(),
  lastAttemptAt: z.string().datetime().nullable().optional(),
  lastSuccessAt: z.string().datetime().nullable().optional(),
  /** Last attempt that returned at least one record (a SUCCEEDED attempt may return none). */
  lastNonemptyAt: z.string().datetime().nullable().optional(),
  nextAttemptAt: z.string().datetime().nullable().optional(),
  cooldownUntil: z.string().datetime().nullable().optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
  lastErrorCode: z
    .lazy(() => jobErrorCodeSchema)
    .nullable()
    .optional(),
  /** The host's ban pause while it is in force (`job_source_hosts`), else null. */
  hostPausedUntil: z.string().datetime().nullable().optional(),
  hostPauseReason: z
    .lazy(() => jobErrorCodeSchema)
    .nullable()
    .optional(),
  /** The unit of the account meter the source bills against; null without a meter. */
  costUnit: z
    .lazy(() => jobMeterUnitSchema)
    .nullable()
    .optional(),
  /** True when the next run would resume from a stored checkpoint ("Crash resume"). */
  resumeCheckpoint: z.boolean().optional(),
  /** The current health state (the latest TRANSITION's `to_state`); null when none recorded. */
  healthState: jobHealthStateSchema.nullable().optional(),
  /**
   * Task 7.5 — the source's account meter, read-only, for the ADMIN quota bar. `null` = the source
   * bills against no meter. Lazy for the same reason as the fields above.
   */
  meter: z
    .lazy(() => jobSourceMeterSchema)
    .nullable()
    .optional(),
})

export const jobSourceListSchema = z.object({
  items: z.array(jobSourceSchema),
})

export const jobCollectionRunSchema = z.object({
  results: z.array(jobCollectionResultSchema),
  failures: z.array(jobCollectionFailureSchema),
})

// ---------------------------------------------------------------------------
// Vacancy queue (HR-facing, vacancy-sourcing phase 1)
// ---------------------------------------------------------------------------

export const jobSeniorityLevelSchema = z.enum(['MIDDLE', 'SENIOR', 'LEAD', 'UNKNOWN'])
export const jobQueueStatusSchema = z.enum(['NEW', 'IN_PROGRESS', 'DISMISSED'])
export const jobSignalKindSchema = z.enum(['OPENED', 'TAKEN', 'DEAD_LINK', 'SPAM'])

export const jobAlsoSeenOnSchema = z.object({
  source: jobSourceTypeSchema,
  url: externalHttpsUrlSchema,
})

export const jobQueueMatchedSeniorSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().max(255),
})

export const jobQueueItemSchema = z.object({
  id: z.string().uuid(),
  sourceType: jobSourceTypeSchema,
  url: externalHttpsUrlSchema,
  title: z.string().max(500),
  companyName: z.string().max(255),
  location: z.string().max(500).nullable(),
  seniority: jobSeniorityLevelSchema,
  /** Canonical stack keywords the posting mentions (union over seniors). */
  matchedKeywords: z.array(z.string().max(MAX_STACK_KEYWORD_CHARS)).max(200),
  /** ONLY seniors the viewer may see (HR: own active teams). */
  matchedSeniors: z.array(jobQueueMatchedSeniorSchema).max(200),
  /** The posting had nothing to judge the stack by — shown with a low rank. */
  stackUnknown: z.boolean(),
  alsoSeenOn: z.array(jobAlsoSeenOnSchema).max(20),
  publishedAt: z.string().datetime().nullable(),
  firstSeenAt: z.string().datetime(),
  queueStatus: jobQueueStatusSchema,
  takenByName: z.string().max(255).nullable(),
  takenAt: z.string().datetime().nullable(),
})

/** The card = list row + the (markdown, never raw HTML) description. */
export const jobQueueCardSchema = jobQueueItemSchema.extend({
  // SECURITY: UNTRUSTED 3rd-party markdown. Bound caps DoS; must be sanitized (no raw HTML) on render in HR UI — future ingest phase.
  descriptionMd: z.string().max(DESCRIPTION_MD_MAX),
})

export const jobQueueListSchema = z.object({
  items: z.array(jobQueueItemSchema),
  nextCursor: z.string().max(300).nullable(),
  counts: z.object({
    NEW: z.number().int().nonnegative(),
    IN_PROGRESS: z.number().int().nonnegative(),
    DISMISSED: z.number().int().nonnegative(),
  }),
})

export const jobQueueQuerySchema = z.object({
  status: jobQueueStatusSchema.default('NEW'),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/**
 * Why a dismissal happened. Extracted from `dismissJobQueueItemSchema` so the
 * member set is pinnable as an exact list the way every other enum here is
 * (R11-M-7): inline, the suite accepted the three values and refused a fourth
 * it named itself, so ADDING a fourth reason passed every test.
 */
export const jobQueueDismissReasonSchema = z.enum(['NOT_RELEVANT', 'SPAM', 'DEAD_LINK'])

export const dismissJobQueueItemSchema = z.object({
  reason: jobQueueDismissReasonSchema.default('NOT_RELEVANT'),
})

// ---------------------------------------------------------------------------
// Opportunity store (r5 Phase 1 — job_opportunities family)
//
// The NEW canonical store: provider-scoped source records, immutable revisions,
// canonical opportunities, per-senior matches, ADMIN team triage. It lives next
// to the legacy posting DTOs above (extend-in-place) and shares none of their
// identity: records are keyed by NATIVE scoped identity, never by the legacy
// `sha256(sourceType|canonicalUrl)` fingerprint. All content is UNTRUSTED.
//
// "Opportunity" is deliberate: `Vacancy` is reserved for the studio's own
// landing postings (CONTEXT.md).
// ---------------------------------------------------------------------------

/** Whether the posting is still open at the provider. Order = pg enum `job_availability`. */
export const jobAvailabilitySchema = z.enum(['OPEN', 'UNKNOWN', 'CLOSED', 'EXPIRED'])

/** Outcome of one collection attempt. A valid empty feed is SUCCEEDED, not FAILED. */
export const jobCollectionOutcomeSchema = z.enum([
  'STARTED',
  'PARTIAL',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
])

/** How much of the provider's inventory an attempt covered. */
export const jobCollectionCoverageSchema = z.enum(['FULL_INVENTORY', 'WINDOW', 'PARTIAL'])

/** NATIVE_ID = provider-issued id; URL_FALLBACK = canonical URL when no id exists. */
export const jobIdentityKindSchema = z.enum(['NATIVE_ID', 'URL_FALLBACK'])

/** Stored outcome of a per-senior evaluation. A plain mismatch is recomputed on demand, never stored. */
export const jobOpportunityMatchOutcomeSchema = z.enum(['LEAD', 'TRIAGE', 'EXCLUDED'])

/** How a source record was attached to a canonical opportunity. */
export const jobOpportunityLinkDecisionSchema = z.enum(['AUTO', 'CONFIRMED'])

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters')

/** Scoped native identity of a source record: UNIQUE(provider type, namespace, key). */
export const jobSourceIdentitySchema = z
  .object({
    sourceType: jobSourceTypeSchema,
    /** Board / account scope (e.g. an ATS company slug). Empty for global providers. */
    namespace: z.string().max(200).default(''),
    identityKind: jobIdentityKindSchema,
    identityKey: z.string().min(1).max(2048),
  })
  .strict()

/** field name -> id of the revision that supplied the selected value. */
export const jobFieldProvenanceSchema = z
  .record(z.string().min(1).max(60), z.string().uuid())
  .refine((v) => Object.keys(v).length <= 40, 'too many provenance entries')

/** One immutable observation of a source record. */
export const jobSourceRevisionSchema = z.object({
  id: z.string().uuid(),
  sourceRecordId: z.string().uuid(),
  adapterVersion: z.string().min(1).max(100),
  normalizerVersion: z.string().min(1).max(100),
  /** UNIQUE(record, contentHash, normalizerVersion): re-observing identical content adds no row. */
  contentHash: sha256HexSchema,
  /** Key into content-addressed `job_text_blobs`; the description text is not duplicated per revision. */
  descriptionSha256: sha256HexSchema.nullable(),
  title: z.string().max(500),
  companyName: z.string().max(255).nullable(),
  location: z.string().max(500).nullable(),
  applicationUrl: externalHttpsUrlSchema.nullable(),
  /** The date exactly as the provider sent it, and what we parsed from it. */
  publishedAtRaw: z.string().max(200).nullable(),
  publishedAt: z.string().datetime().nullable(),
  fieldProvenance: jobFieldProvenanceSchema,
  /** Monotonic arrival order — revisions can arrive out of order of their publish date. */
  receivedSeq: z.number().int().positive(),
  receivedAt: z.string().datetime(),
})

const countSchema = z.number().int().nonnegative()

/**
 * CR-M-2. The ceiling of a PostgreSQL `integer` column. Zod v4's `.int()`
 * already refuses anything past `Number.MAX_SAFE_INTEGER`, which is what a
 * `bigint` column holds comfortably — so the meter and reservation counters
 * were widened to `bigint` instead of being narrowed here. The counters that
 * rightly stay `integer` (version numbers, retry and failure counts, the
 * per-cycle HTML call budget, and the collection report's received/disposition
 * counts) get the column's own ceiling, so the contract never accepts a value
 * the column answers with 22003.
 *
 * CR-M-3: round 1 claimed this held for every integer-backed counter while two
 * places still lacked it — `jobAccountMeterSchema.policyVersion` and all seven
 * `jobCollectionReportSchema` counts. Declared below the report schema's own
 * fields so the next reader can see the rule applied, not asserted.
 */
const PG_INT_MAX = 2_147_483_647
const intColumnCountSchema = countSchema.max(PG_INT_MAX)
const intColumnPositiveSchema = z.number().int().positive().max(PG_INT_MAX)

/**
 * CR-L-5. The text ceilings of the queue columns, each declared ONCE in this
 * package. They mirror `JOB_HANDLE_MAX` / `JOB_SHORT_TEXT_MAX` /
 * `JOB_SANITIZED_TEXT_MAX` in the api's `job-patterns.ts`; the package
 * boundary keeps them two declarations, and the api unit twin pins the column
 * side of each one by its rendered CHECK.
 */
const JOB_HANDLE_MAX_CHARS = 200
const JOB_SHORT_TEXT_MAX_CHARS = 100
const JOB_REASON_MAX_CHARS = 500

/**
 * Report of one collection attempt. Exactly one disposition per input item;
 * persistence failures are their own bucket (they are OUR fault, not the
 * provider's) and a SUCCEEDED attempt cannot contain any.
 */
export const jobCollectionReportSchema = z
  .object({
    sourceId: z.string().uuid(),
    outcome: jobCollectionOutcomeSchema,
    coverage: jobCollectionCoverageSchema,
    received: intColumnCountSchema,
    created: intColumnCountSchema,
    revised: intColumnCountSchema,
    unchanged: intColumnCountSchema,
    duplicates: intColumnCountSchema,
    invalid: intColumnCountSchema,
    persistenceErrors: intColumnCountSchema,
  })
  .superRefine((r, ctx) => {
    const dispositions =
      r.created + r.revised + r.unchanged + r.duplicates + r.invalid + r.persistenceErrors
    if (dispositions !== r.received) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly one disposition per received item',
        path: ['received'],
      })
    }
    if (r.outcome === 'SUCCEEDED' && r.persistenceErrors > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a SUCCEEDED attempt cannot carry persistence errors',
        path: ['persistenceErrors'],
      })
    }
  })

// --- team scope --------------------------------------------------------------

/** Every list / card / continuation / action request names the team it acts for. */
export const jobQueueScopedQuerySchema = jobQueueQuerySchema.extend({
  teamId: z.string().uuid(),
})

export const jobQueueSeniorPageSchema = z.object({
  items: z.array(jobQueueMatchedSeniorSchema).max(200),
  totalMatchedSeniorCount: countSchema,
  nextCursor: z.string().max(300).nullable(),
})

export const jobQueueSourceItemSchema = z.object({
  sourceRecordId: z.string().uuid(),
  sourceType: jobSourceTypeSchema,
  /** The source's own posting URL; kept apart from the application URL. */
  url: externalHttpsUrlSchema,
  linkedAt: z.string().datetime(),
})

export const jobQueueSourcePageSchema = z
  .object({
    items: z.array(jobQueueSourceItemSchema).max(50),
    totalSourceCount: countSchema,
    /** Always max(totalSourceCount - 1, 0): the primary source is not "also seen on". */
    totalAlsoSeenOnCount: countSchema,
    primarySourceRecordId: z.string().uuid().nullable(),
    relationVersion: countSchema,
    nextCursor: z.string().max(300).nullable(),
  })
  .refine((p) => p.totalAlsoSeenOnCount === Math.max(p.totalSourceCount - 1, 0), {
    message: 'totalAlsoSeenOnCount must equal max(totalSourceCount - 1, 0)',
    path: ['totalAlsoSeenOnCount'],
  })
  // R11-L-3. The primary exists EXACTLY when the page has sources, and both
  // directions are stated rather than implied: a page with sources has a
  // primary among them (the invariant above already counts the primary as one
  // of `totalSourceCount`), and a page with none has nothing a primary could
  // point at. Before this, `{ totalSourceCount: 7, primarySourceRecordId: null }`
  // parsed — a page claiming seven sources and no canonical one.
  .refine((p) => !(p.totalSourceCount > 0 && p.primarySourceRecordId === null), {
    message: 'a positive totalSourceCount requires primarySourceRecordId',
    path: ['primarySourceRecordId'],
  })
  .refine((p) => !(p.totalSourceCount === 0 && p.primarySourceRecordId !== null), {
    message: 'a zero totalSourceCount forbids primarySourceRecordId',
    path: ['primarySourceRecordId'],
  })

export const jobPossibleDuplicateSchema = z.object({
  opportunityId: z.string().uuid(),
  title: z.string().max(500),
  companyName: z.string().max(255).nullable(),
})

/** Bounded preview; the full set is paged separately. */
export const jobPossibleDuplicatesPreviewSchema = z.object({
  items: z.array(jobPossibleDuplicateSchema).max(5),
  totalCount: z.number().int().positive(),
})

export const confirmPossibleDuplicateSchema = z
  .object({
    opportunityId: z.string().uuid(),
    duplicateOpportunityId: z.string().uuid(),
    expectedRelationVersion: countSchema,
  })
  .strict()
  .refine((v) => v.opportunityId !== v.duplicateOpportunityId, {
    message: 'an opportunity cannot be a duplicate of itself',
    path: ['duplicateOpportunityId'],
  })

// --- ADMIN team triage -------------------------------------------------------

/**
 * CR-M-3 (PR #1017 round 2). What Postgres's `[[:space:]]` matches on the
 * catalog these columns live in, ENUMERATED on PG16 / en_US.utf8 (every BMP
 * code point tested with `chr(cp) ~ '[[:space:]]'`): the ASCII six, U+0085,
 * U+2000-2006, U+2008-200A, U+2028, U+2029, U+205F, U+3000. A value with no
 * character outside this set is what a `~ '[^[:space:]]'` CHECK refuses.
 *
 * `.trim()` is NOT enough: JS `trim()` keeps U+0085, so a reason of only
 * U+0085 parsed here and the column answered with a raw 23514 instead of a
 * 400. The set is locale-measured: the production catalog's locale must match
 * (it is the same postgres:16-alpine image); a locale that treated FEWER code
 * points as space would only make this refusal stricter than the column,
 * never looser.
 */
const PG_NOT_BLANK = /[^\t\n\v\f\r \u0085\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]/

/** A REQUEST string bound for a non-blank column: refuses what the column refuses. */
const requestTextSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => PG_NOT_BLANK.test(v), 'must not be blank')

const triageReasonSchema = requestTextSchema(JOB_REASON_MAX_CHARS)

export const createJobQueueTeamTriageGrantSchema = z
  .object({
    opportunityId: z.string().uuid(),
    teamId: z.string().uuid(),
    expectedOpportunityRevision: countSchema,
    policyVersion: countSchema,
    reason: triageReasonSchema,
    expiresAt: z.string().datetime(),
  })
  .strict()

export const revokeJobQueueTeamTriageGrantSchema = z
  .object({
    opportunityId: z.string().uuid(),
    teamId: z.string().uuid(),
    expectedGrantVersion: countSchema,
    reason: triageReasonSchema,
  })
  .strict()

export const jobQueueTeamTriageGrantSchema = z.object({
  id: z.string().uuid(),
  opportunityId: z.string().uuid(),
  teamId: z.string().uuid(),
  assignedBy: z.string().uuid(),
  policyVersion: countSchema,
  opportunityRevision: countSchema,
  grantVersion: countSchema,
  evidence: z.record(z.string(), z.unknown()),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
})

/**
 * The layer-1 classifier's role families (`RoleFamily` in the API funnel).
 * UNKNOWN is what the classifier says when it cannot tell.
 */
export const jobRoleFamilySchema = z.enum([
  'SOFTWARE',
  'DEVOPS',
  'DATA',
  'QA',
  'DESIGN',
  'PRODUCT',
  'OTHER',
  'UNKNOWN',
])

/**
 * SR-L-2: a triage subscription names a real family. UNKNOWN is refused — a
 * standing subscription to "the classifier could not tell" would route every
 * unclassified job to one team.
 */
export const jobTriageRoleFamilySchema = jobRoleFamilySchema.exclude(['UNKNOWN'])

export const createJobQueueTeamTriageSubscriptionSchema = z
  .object({
    teamId: z.string().uuid(),
    roleFamily: jobTriageRoleFamilySchema,
    /** Empty = every source. Bounded by the number of provider types. */
    sourceTypes: z.array(jobSourceTypeSchema).max(jobSourceTypeSchema.options.length),
    // r5 Task 1.2c: `job_team_triage_subscriptions.policy_version` is an
    // integer column, so the contract carries its ceiling (lesson CR-M-2).
    policyVersion: intColumnCountSchema,
    expiresAt: z.string().datetime(),
    reason: triageReasonSchema,
  })
  .strict()

export const revokeJobQueueTeamTriageSubscriptionSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    // The column starts at 1 (`ck_job_team_triage_subscriptions_version_positive`),
    // so 0 can never match a row and is refused here instead of at the UPDATE.
    expectedSubscriptionVersion: intColumnPositiveSchema,
    reason: triageReasonSchema,
  })
  .strict()

/**
 * SR-M-6 (PR #1017 round 2). The stored subscription row, WORKER-internal: it
 * carries `actorId`, the ADMIN who created it. Same convention as the queue
 * shapes below (plain name = what a client may receive).
 */
export const jobQueueTeamTriageSubscriptionWorkerSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  roleFamily: z.string().max(JOB_SHORT_TEXT_MAX_CHARS),
  sourceTypes: z.array(jobSourceTypeSchema).max(jobSourceTypeSchema.options.length),
  policyVersion: intColumnCountSchema,
  subscriptionVersion: intColumnPositiveSchema,
  actorId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
})

/**
 * The public subscription: no actor identity. `teamId` stays — it is the
 * SUBJECT of the subscription (the team that gains visibility), not an actor,
 * and every subscription endpoint is ADMIN-only (Phase-6 obligation).
 */
export const jobQueueTeamTriageSubscriptionSchema = jobQueueTeamTriageSubscriptionWorkerSchema.omit(
  {
    actorId: true,
  },
)

// --- Queue workflow store (r5 Task 1.2 part 3) -------------------------------
//
// The DTOs of `job_queue_assignments`, `job_queue_dismissals`,
// `job_queue_actions`, `job_queue_generations` and their entries. Every
// cross-field rule below is ALSO a database CHECK on the matching table
// (apps/api/src/database/schema/job-queue.ts). These are STORED-ROW shapes:
// every row the database accepted parses unchanged. The one place the two
// sides are not identical is non-blank text — see `storedTextSchema`.
//
// Naming follows part 2 (SR-M-5): the plain name is the shape a client may
// receive; a `...Worker...` shape carries server-internal fields (actor
// identities, policy signatures, rank) and is never serialized to a client.
//
// What NO schema here can carry is the actor's ROLE: "STUDIO scope is
// ADMIN-only", "release / reassign / suppress are ADMIN-only". Those are
// Phase-6 service obligations, listed on the tables.

/**
 * Whose view a queue decision belongs to. TEAM = one team's view; STUDIO = the
 * studio-wide view, which only an ADMIN may act in (Phase-6 obligation — the
 * role is not visible to a schema).
 */
export const jobQueueScopeKindSchema = z.enum(['TEAM', 'STUDIO'])

/** A claim row is kept after release, so a re-take is a versioned UPDATE. */
export const jobQueueAssignmentStateSchema = z.enum(['TAKEN', 'RELEASED'])

/**
 * Kinds of the action log (append-only by intent; NOT yet enforced by the
 * database — see `schema/job-queue.ts`, Task 1.3 obligation). The first four
 * keep the legacy signal names (`jobSignalKindSchema`, which stays untouched
 * with its own table).
 */
export const jobQueueActionKindSchema = z.enum([
  'OPENED',
  'TAKEN',
  'DEAD_LINK',
  'SPAM',
  'DISMISSED',
  'UNDONE',
  'RELEASED',
  'REASSIGNED',
  'SUPPRESSED',
  'TRIAGE_GRANTED',
  'TRIAGE_REVOKED',
  'TRIAGE_SUBSCRIBED',
  'TRIAGE_UNSUBSCRIBED',
  // The redaction evidence row (r5 Task 1.4b-ii) — the one kind whose subject is
  // another row OF THIS LOG rather than an opportunity or a subscription.
  'REASON_REDACTED',
])

/** BUILDING -> PUBLISHED -> INVALIDATED; a BUILDING one may be abandoned straight to INVALIDATED. */
export const jobQueueGenerationStatusSchema = z.enum(['BUILDING', 'PUBLISHED', 'INVALIDATED'])

/**
 * The scope's shape per kind — the same rule as the `..._scope_shape` CHECKs:
 * a TEAM scope names exactly one team, a STUDIO scope names none.
 */
export const jobQueueScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TEAM'), teamId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('STUDIO'), teamId: z.null() }).strict(),
])

/**
 * CR-L-2. A STORED text column (`~ '[^[:space:]]' AND length(x) <= max`),
 * described — never normalised. Two rules:
 *   - no `.trim()`: a row schema that rewrites the value it reads is not
 *     describing the row;
 *   - "blank" here means ASCII whitespace only (` \t\n\v\f\r`). Postgres's
 *     `[[:space:]]` is locale-dependent beyond ASCII — measured on PG16 /
 *     en_US.utf8 it EXCLUDES U+00A0, U+2007, U+202F, U+FEFF and INCLUDES
 *     U+0085, i.e. it disagrees with JS `\s` in both directions. The ASCII set
 *     is a space in every locale, so what this refuses is a subset of what the
 *     CHECK refuses: every stored row parses. The rest is the CHECK's call.
 * Request DTOs (the triage create/revoke reason) keep their `.trim()`.
 */
const storedTextSchema = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/[^ \t\n\v\f\r]/, 'must not be blank')

/** A stored sentence a person typed — the column bound of a reason. */
const queueReasonSchema = storedTextSchema(JOB_REASON_MAX_CHARS)

/** The full range of a PostgreSQL `integer` (a rank score may be negative). */
const intColumnSchema = z
  .number()
  .int()
  .min(-PG_INT_MAX - 1)
  .max(PG_INT_MAX)

const jobQueueAssignmentFields = z.object({
  id: z.string().uuid(),
  opportunityId: z.string().uuid(),
  state: jobQueueAssignmentStateSchema,
  /** The scope the claimer acted in: their team, or STUDIO for an ADMIN. */
  scope: jobQueueScopeSchema,
  assigneeId: z.string().uuid(),
  takenAt: z.string().datetime(),
  version: intColumnPositiveSchema,
  releasedAt: z.string().datetime().nullable(),
  releasedBy: z.string().uuid().nullable(),
  releaseReason: queueReasonSchema.nullable(),
  reassignedAt: z.string().datetime().nullable(),
  reassignedBy: z.string().uuid().nullable(),
  reassignedFromId: z.string().uuid().nullable(),
  updatedAt: z.string().datetime(),
  /** The senior this submission is for (`senior_id`, staged 2026-11-04 per-senior DDL). */
  seniorId: z.string().uuid(),
})

/** `ck_job_queue_assignments_release_pair`, the half both shapes carry. */
const refineAssignmentRelease = (
  a: { state: string; releasedAt: string | null },
  ctx: z.RefinementCtx,
) => {
  const releasedState = a.state === 'RELEASED'
  if (releasedState ? a.releasedAt === null : a.releasedAt !== null) {
    ctx.addIssue({
      code: 'custom',
      message: 'a RELEASED assignment records when it was released, and only a released one does',
      path: ['releasedAt'],
    })
  }
}

/**
 * The server-internal claim row. Two explicit branches per pair (CR-M-1 of
 * #1015), never an equality of two booleans.
 */
export const jobQueueAssignmentWorkerSchema = jobQueueAssignmentFields.superRefine((a, ctx) => {
  refineAssignmentRelease(a, ctx)
  const releasedState = a.state === 'RELEASED'
  if (releasedState ? a.releasedBy === null : a.releasedBy !== null) {
    ctx.addIssue({
      code: 'custom',
      message: 'a RELEASED assignment records who released it, and only a released one does',
      path: ['releasedBy'],
    })
  }
  // One direction only: a release reason is optional, but a TAKEN row (a
  // re-take included) must not keep the previous holder's reason.
  if (!releasedState && a.releaseReason !== null) {
    ctx.addIssue({
      code: 'custom',
      message: 'only a RELEASED assignment carries a release reason',
      path: ['releaseReason'],
    })
  }
  const all = a.reassignedAt !== null && a.reassignedBy !== null && a.reassignedFromId !== null
  const none = a.reassignedAt === null && a.reassignedBy === null && a.reassignedFromId === null
  if (!all && !none) {
    ctx.addIssue({
      code: 'custom',
      message: 'reassignment metadata (when, by whom, from whom) is all present or all absent',
      path: ['reassignedAt'],
    })
  }
})

/**
 * The public claim shape: NO actor identity and NO claimer scope. "Already
 * taken" is shown without a name outside the viewer's scope (r5 Task 6.3), and
 * the claimer's team id is itself a cross-team disclosure — the name is added
 * by the Phase-6 projection only after authorization.
 */
export const jobQueueAssignmentSchema = jobQueueAssignmentFields
  .pick({
    id: true,
    opportunityId: true,
    state: true,
    takenAt: true,
    releasedAt: true,
    version: true,
  })
  .superRefine(refineAssignmentRelease)

const jobQueueDismissalFields = z.object({
  id: z.string().uuid(),
  opportunityId: z.string().uuid(),
  scope: jobQueueScopeSchema,
  reason: queueReasonSchema,
  dismissedBy: z.string().uuid(),
  dismissedAt: z.string().datetime(),
  version: intColumnPositiveSchema,
  undoneAt: z.string().datetime().nullable(),
  undoneBy: z.string().uuid().nullable(),
})

/**
 * One scoped dismissal, as stored — WORKER-internal (CR-M-2 / SR-M-4): it
 * carries the actor identities `dismissedBy` / `undoneBy`. UNIQUE(opportunity,
 * scope kind, scope team) in the database: an undo keeps the row and a
 * re-dismiss UPDATEs it.
 */
export const jobQueueDismissalWorkerSchema = jobQueueDismissalFields.superRefine((d, ctx) => {
  const undone = d.undoneAt !== null && d.undoneBy !== null
  const live = d.undoneAt === null && d.undoneBy === null
  if (!undone && !live) {
    ctx.addIssue({
      code: 'custom',
      message: 'an undo records who undid it and when — both or neither',
      path: ['undoneAt'],
    })
  }
})

/** The public dismissal: no actor identity; who dismissed is a Phase-6 authorized projection. */
export const jobQueueDismissalSchema = jobQueueDismissalFields.omit({
  dismissedBy: true,
  undoneBy: true,
})

const SUBSCRIPTION_ACTIONS: ReadonlySet<string> = new Set([
  'TRIAGE_SUBSCRIBED',
  'TRIAGE_UNSUBSCRIBED',
])
const TELEMETRY_ACTIONS: ReadonlySet<string> = new Set(['OPENED', 'DEAD_LINK', 'SPAM'])
/**
 * The redaction evidence kind (r5 Task 1.4b-ii). Deliberately NOT a member of
 * `TELEMETRY_ACTIONS`: that set also drives the clicked-source rule, which a
 * redaction cannot satisfy — it references no source record. Same seam decision
 * as `TELEMETRY_KINDS` in `schema/job-queue.ts`; the two must agree.
 */
const REDACTION_ACTION = 'REASON_REDACTED'

/**
 * One row of the action log (the audit trail of every queue mutation and
 * click; append-only by intent, NOT yet enforced by the database — see
 * `schema/job-queue.ts`). Each rule mirrors a CHECK on `job_queue_actions`.
 *
 * WORKER-internal only (CR-M-2 / SR-M-4): it carries `actorId`,
 * `idempotencyKey` and `subjectUserId`. There is deliberately no plain-named
 * action shape yet — no client reads the log, and an ADMIN audit view is a
 * Phase-6 projection with its own authorization.
 */
export const jobQueueActionWorkerSchema = z
  .object({
    id: z.string().uuid(),
    kind: jobQueueActionKindSchema,
    opportunityId: z.string().uuid().nullable(),
    sourceRecordId: z.string().uuid().nullable(),
    subscriptionId: z.string().uuid().nullable(),
    actorId: z.string().uuid(),
    scope: jobQueueScopeSchema,
    /** The team a TRIAGE_* action grants to / subscribes for. */
    subjectTeamId: z.string().uuid().nullable(),
    /** The new assignee of a REASSIGNED action. */
    subjectUserId: z.string().uuid().nullable(),
    /**
     * The row of this same log that a `REASON_REDACTED` row evidences, and the
     * only target that points INSIDE this log. It has no foreign key in the
     * database on purpose — the subject is purged before its evidence row falls
     * due — so a non-null value here may name a row that no longer exists.
     */
    subjectActionId: z.string().uuid().nullable(),
    beforeVersion: intColumnCountSchema.nullable(),
    afterVersion: intColumnPositiveSchema.nullable(),
    /** UNIQUE per actor in the database. */
    idempotencyKey: storedTextSchema(JOB_HANDLE_MAX_CHARS),
    reason: queueReasonSchema.nullable(),
    createdAt: z.string().datetime(),
  })
  .superRefine((a, ctx) => {
    const redaction = a.kind === REDACTION_ACTION
    const onSubscription =
      a.opportunityId === null &&
      a.subscriptionId !== null &&
      a.sourceRecordId === null &&
      a.subjectActionId === null
    const onOpportunity =
      a.opportunityId !== null && a.subscriptionId === null && a.subjectActionId === null
    // The third branch of `ck_job_queue_actions_target`: a redaction names the
    // action row it is about and nothing outside this log.
    const onRedactedAction =
      a.subjectActionId !== null &&
      // SR-M-2: not itself. An evidence row that is its own subject is not
      // evidence of anything.
      a.subjectActionId !== a.id &&
      a.opportunityId === null &&
      a.subscriptionId === null &&
      a.sourceRecordId === null
    const targeted = redaction
      ? onRedactedAction
      : SUBSCRIPTION_ACTIONS.has(a.kind)
        ? onSubscription
        : onOpportunity
    if (!targeted) {
      ctx.addIssue({
        code: 'custom',
        message:
          'a subscription action targets a subscription only; a REASON_REDACTED action targets the action row it redacts; every other action targets an opportunity and no subscription',
        // Point at the column the reader must fix, which for a redaction is the
        // new one rather than the opportunity it deliberately does not carry.
        path: [redaction ? 'subjectActionId' : 'opportunityId'],
      })
    }
    const telemetry = TELEMETRY_ACTIONS.has(a.kind)
    if (telemetry && a.sourceRecordId === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'OPENED / DEAD_LINK / SPAM reference the clicked source record',
        path: ['sourceRecordId'],
      })
    }
    if (a.kind.startsWith('TRIAGE_') ? a.subjectTeamId === null : a.subjectTeamId !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a TRIAGE_* action names the team it concerns, and only a TRIAGE_* action does',
        path: ['subjectTeamId'],
      })
    }
    if (a.kind === 'REASSIGNED' ? a.subjectUserId === null : a.subjectUserId !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a REASSIGNED action names the new assignee, and only a REASSIGNED action does',
        path: ['subjectUserId'],
      })
    }
    const unversioned = a.beforeVersion === null && a.afterVersion === null
    // SPEC-M-1: no r5 entity holds suppression state, so SUPPRESSED may carry
    // none; a triage grant targets `grant_version` and stays versioned.
    const versionless = a.kind === 'SUPPRESSED' && unversioned
    // A NULL after-version reads as -1, so it can never move forward from a
    // before-version >= 0 (a separate `!== null` operand was redundant — the
    // mutation gate showed it could be replaced by `true` unobserved).
    const forward = a.beforeVersion !== null && (a.afterVersion ?? -1) > a.beforeVersion
    // MUST be unversioned, not MAY: a redaction carries no target state at all,
    // so unlike SUPPRESSED it is excluded from the moving-pair branch rather
    // than also allowed into it. Mirrors `kind <> 'REASON_REDACTED'` on the
    // last branch of `ck_job_queue_actions_versions`.
    const mustBeUnversioned = telemetry || redaction
    if (mustBeUnversioned ? !unversioned : !forward && !versionless) {
      ctx.addIssue({
        code: 'custom',
        message:
          'telemetry (OPENED / DEAD_LINK / SPAM) and REASON_REDACTED carry no version; SUPPRESSED may carry none; every other action moves the version forward',
        path: ['afterVersion'],
      })
    }
  })

const jobQueueGenerationFields = z.object({
  id: z.string().uuid(),
  scope: jobQueueScopeSchema,
  /** Opaque digest of the policy inputs (membership / exclusion versions). */
  policySignature: storedTextSchema(JOB_HANDLE_MAX_CHARS),
  ruleVersion: storedTextSchema(JOB_SHORT_TEXT_MAX_CHARS),
  status: jobQueueGenerationStatusSchema,
  evaluatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  invalidatedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
})

/** `ck_job_queue_generations_expiry_after_evaluation`. */
const refineGenerationExpiry = (
  g: { evaluatedAt: string; expiresAt: string },
  ctx: z.RefinementCtx,
) => {
  if (Date.parse(g.expiresAt) <= Date.parse(g.evaluatedAt)) {
    ctx.addIssue({
      code: 'custom',
      message: 'a generation expires after it was evaluated',
      path: ['expiresAt'],
    })
  }
}

/** The publisher's row. `ck_job_queue_generations_status_instants`, one branch per status. */
export const jobQueueGenerationWorkerSchema = jobQueueGenerationFields.superRefine((g, ctx) => {
  const ok =
    (g.status === 'BUILDING' && g.publishedAt === null && g.invalidatedAt === null) ||
    (g.status === 'PUBLISHED' && g.publishedAt !== null && g.invalidatedAt === null) ||
    (g.status === 'INVALIDATED' && g.invalidatedAt !== null)
  if (!ok) {
    ctx.addIssue({
      code: 'custom',
      message:
        'BUILDING has no publish or invalidation instant; PUBLISHED has a publish instant only; INVALIDATED has an invalidation instant',
      path: ['status'],
    })
  }
  refineGenerationExpiry(g, ctx)
})

/** The public generation: what a cursor is checked against. No policy signature, no lifecycle. */
export const jobQueueGenerationSchema = jobQueueGenerationFields
  .pick({ id: true, evaluatedAt: true, expiresAt: true })
  .superRefine(refineGenerationExpiry)

/**
 * One entry, keyed (generation, opportunity). WORKER-only: the rank score is
 * authorized separately from the payload (r5 Task 6.1), so there is no
 * plain-named entry shape — the public list item is `jobQueueItemSchema`.
 */
export const jobQueueGenerationEntryWorkerSchema = z.object({
  generationId: z.string().uuid(),
  opportunityId: z.string().uuid(),
  rankScore: intColumnSchema,
  /** Position within the generation; UNIQUE(generation, order key) in the database. */
  orderKey: intColumnCountSchema,
  /** The tie-breaker of `(rank_score, first_seen_at, opportunity_id)`, snapshotted. */
  firstSeenAt: z.string().datetime(),
  /** The input version the entry was evaluated against. */
  opportunityRevision: intColumnPositiveSchema,
})

// ---------------------------------------------------------------------------
// Collection machinery (r5 Task 1.2 part 2) — cycles, attempts, metering
// ---------------------------------------------------------------------------
//
// These describe HOW a collection is driven, not what it found (that is
// `jobCollectionReportSchema` above). The legacy one-unit `chargeBudget` path
// and `jobSourceBudgetSchema` stay exactly as they are for DOU (A1h): the
// meters below are the real-unit accounting the new sources need, and the two
// never share a counter.

/** What caused an occurrence: the cron, or a human pressing the button. */
export const jobCollectionTriggerSchema = z.enum(['SCHEDULED', 'MANUAL'])

/** A cycle is OPEN until every child run / work item is terminal or deferred. */
export const jobCollectionCycleStatusSchema = z.enum(['OPEN', 'CLOSED'])

/**
 * A seeded row is a CANDIDATE config, not a verified one: HTTP 200 is not
 * readiness (r5 Phase 3 common protocol). BLOCKED is a policy / credential
 * refusal and is reported apart from `enabled` and from the paused admin state.
 */
export const jobSourceReadinessSchema = z.enum(['CANDIDATE', 'VERIFIED', 'BLOCKED'])

/** Administrative state. RETIRED is a soft state: provenance is never deleted. */
export const jobSourceAdminStateSchema = z.enum(['ACTIVE', 'PAUSED', 'RETIRED'])

/**
 * What a meter counts. Request / record / model units never share a counter
 * (r5): TheirStack bills per returned record, JSearch per request, the HTML
 * extractor per model call, OpenRouter in money.
 */
export const jobMeterUnitSchema = z.enum(['REQUEST', 'RECORD', 'MODEL_CALL', 'USD_MICROS'])

/** LIFETIME meters never reset and are kept distinct from the rolling windows. */
export const jobMeterWindowSchema = z.enum(['DAY', 'MONTH', 'LIFETIME'])

/**
 * RESERVED before any I/O; SENT once the request provably left; USED on
 * exactly-once conversion; RELEASED only for provably unsent cost; UNCERTAIN
 * held until reconciliation (a timeout may or may not have been billed).
 */
export const jobMeterReservationStatusSchema = z.enum([
  'RESERVED',
  'SENT',
  'USED',
  'RELEASED',
  'UNCERTAIN',
])

/** The dirty producers r5 names: revisions, senior edits, exclusions, client changes. */
export const jobDirtyWorkEntityKindSchema = z.enum([
  'SOURCE_RECORD',
  'OPPORTUNITY',
  'SENIOR',
  'EXCLUSION',
  'PROJECT_CLIENT',
])

/** DEFERRED is terminal for cycle-closing purposes, not a failure. */
export const jobDirtyWorkStatusSchema = z.enum(['PENDING', 'CLAIMED', 'DONE', 'FAILED', 'DEFERRED'])

/** A stable attempt id: it survives retries, so a retry re-uses the reservation. */
const attemptIdSchema = z.string().min(1).max(200)

/**
 * An account identity that carries NO secrets: a short lowercase id, never a
 * key, a token or a URL with credentials. The same shape the database CHECK
 * enforces (`ck_job_account_meters_account_key_format`), so an identity that
 * parses here is accepted there.
 */
const publicIdSchema = (noun: string) =>
  z
    .string()
    .regex(/^[a-z0-9][a-z0-9._:-]{0,99}$/, `must be a short lowercase ${noun} without secrets`)
    /**
     * SR-M-1. The alphabet above rejects uppercase, base64 (`+ / =`), URLs and
     * anything over 100 characters — but a pasted raw lowercase hex or
     * alphanumeric key still reads as a lawful id. A real identity is SEGMENTED
     * (`jsearch:rapidapi-main`, `dou.rss.jobs`), so a run of 24 or more
     * characters with no separator is refused and the paste fails loudly. Still
     * not a secret detector; it is the one structural difference between an
     * identity and a credential that a pattern CAN see.
     *
     * SR-L-1 — an obligation for Task 3.7, which backfills `manifest_id`: a
     * 32-character hex digest or a UUID with its hyphens stripped is ONE
     * unbroken run and this rule refuses it. The backfill must emit segmented
     * ids (`jsearch:rapidapi-main`), or a hyphenated UUID, not a digest.
     */
    .refine(
      (v) => !/[a-z0-9]{24}/.test(v),
      'must be segmented: a run of 24 or more characters without a separator is a pasted key',
    )

/**
 * A provider account key. One shape, declared once (see `publicIdSchema`),
 * because `manifest_id` and `account_key` carry the SAME column constraints —
 * a second copy is how the two drift apart.
 */
export const jobAccountKeySchema = publicIdSchema('account id')

/**
 * SR-L-2. A manifest id on the wire. The column carries both
 * `ck_job_sources_manifest_id_format` and `..._segmented`, while the response
 * field carried only `.max(100)` — so a value the database refuses used to
 * parse. Response-only is not a reason to disagree with the column.
 */
export const jobManifestIdSchema = publicIdSchema('manifest id')

/**
 * A TYPED error code — never free text, never an upstream body. Upper-snake,
 * at most 64 characters, starting with a letter: the shape a documented status
 * or error classification has (`HTTP_403`, `VERSION_STALE`, `QUOTA_EXHAUSTED`).
 *
 * The bound is the enforceable half of "classify from documented status codes,
 * never from page text" (r5): a 400-character provider body — which may carry a
 * key — cannot be stored in a column documented as holding a code. The same
 * shape the database CHECKs enforce (`ck_job_sources_last_error_code_format`,
 * `ck_job_collection_runs_error_code_format`,
 * `ck_job_dirty_work_last_error_code_format`), so a code that parses here is
 * accepted there. It is NOT a closed enum: the vocabulary is per adapter and
 * r5 does not fix one, so inventing one would constrain Phase 2 on no evidence.
 */
export const jobErrorCodeSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{0,63}$/,
    'must be a typed upper-snake error code of at most 64 characters',
  )

/**
 * One account meter. `limit` NULL = no published limit — the single value that
 * means that, exactly as on `jobSourceBudgetSchema` above.
 *
 * `remaining` is derived, not stored: `limit - (used + reserved + uncertain)`.
 */
export const jobAccountMeterSchema = z
  .object({
    id: z.string().uuid(),
    accountKey: jobAccountKeySchema,
    unit: jobMeterUnitSchema,
    window: jobMeterWindowSchema,
    limit: z.number().int().nonnegative().nullable(),
    used: countSchema,
    reserved: countSchema,
    uncertain: countSchema,
    /** `null` for a LIFETIME meter, which has no window to start. */
    windowStartedAt: z.string().datetime().nullable(),
    /** `null` when unlimited OR when the meter is LIFETIME (it never resets). */
    resetsAt: z.string().datetime().nullable(),
    /** `integer` column, unlike the three amounts above — hence the ceiling (CR-M-3). */
    policyVersion: intColumnPositiveSchema,
  })
  .superRefine((m, ctx) => {
    if (m.limit !== null && m.used + m.reserved + m.uncertain > m.limit) {
      ctx.addIssue({
        code: 'custom',
        message: 'used + reserved + uncertain may not exceed the limit',
        path: ['used'],
      })
    }
    if (m.window === 'LIFETIME' && (m.resetsAt !== null || m.windowStartedAt !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'a LIFETIME meter never resets and has no window start',
        path: ['window'],
      })
    }
  })

/**
 * Task 7.5 — the slice of a meter the ADMIN source list projects. No `id` / `accountKey` /
 * `policyVersion`: the panel needs the three amounts, the limit and the reset instant only.
 * `used` is already zero when the window has elapsed; `reserved` and `uncertain` are shown as
 * stored (an in-place window reset does not touch them).
 */
export const jobSourceMeterSchema = z.strictObject({
  unit: jobMeterUnitSchema,
  window: jobMeterWindowSchema,
  limit: z.number().int().nonnegative().nullable(),
  used: countSchema,
  reserved: countSchema,
  uncertain: countSchema,
  resetsAt: z.string().datetime().nullable(),
})

/** One reservation against a meter, keyed by its attempt so a retry is idempotent. */
export const jobMeterReservationSchema = z
  .object({
    id: z.string().uuid(),
    meterId: z.string().uuid(),
    attemptId: attemptIdSchema,
    /** `null` for a reservation that is not a collection attempt (e.g. a model call). */
    runId: z.string().uuid().nullable(),
    /** Every reservation carries its cycle (r5): reservations are taken before spawn. */
    cycleId: z.string().uuid(),
    status: jobMeterReservationStatusSchema,
    /** Worst-case cost reserved up front. */
    amount: z.number().int().positive(),
    /** Cost provably converted to `used`; never more than was reserved. */
    usedAmount: countSchema,
    reservedAt: z.string().datetime(),
    sentAt: z.string().datetime().nullable(),
    settledAt: z.string().datetime().nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.usedAmount > r.amount) {
      ctx.addIssue({
        code: 'custom',
        message: 'used cost may not exceed the reserved amount',
        path: ['usedAmount'],
      })
    }
    if (r.status === 'RELEASED' && r.usedAmount !== 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'only provably unsent cost may be released',
        path: ['usedAmount'],
      })
    }
    if (r.status !== 'RESERVED' && r.status !== 'RELEASED' && r.sentAt === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a request that left must carry its send instant',
        path: ['sentAt'],
      })
    }
    // CR-L-1, the converse the rule above did not state: a RELEASED
    // reservation spent nothing, so it never left. Mirrors
    // `ck_job_account_meter_reservations_released_unsent`.
    if (r.status === 'RELEASED' && r.sentAt !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a released reservation never left, so it carries no send instant',
        path: ['sentAt'],
      })
    }
  })

/** One trigger occurrence. `triggerKey` is the dedupe key across replicas. */
export const jobCollectionCycleSchema = z
  .object({
    id: z.string().uuid(),
    trigger: jobCollectionTriggerSchema,
    /** Schedule slot for SCHEDULED, the client request id for MANUAL. */
    triggerKey: z.string().min(1).max(200),
    /** The ADMIN who pressed the button; `null` for the cron. */
    requestedBy: z.string().uuid().nullable(),
    /** Shared HTML call budget for this occurrence — 20 across all HTML providers. */
    htmlCallReservation: intColumnPositiveSchema,
    status: jobCollectionCycleStatusSchema,
    startedAt: z.string().datetime(),
    closedAt: z.string().datetime().nullable(),
  })
  .superRefine((c, ctx) => {
    if ((c.trigger === 'MANUAL') !== (c.requestedBy !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'a MANUAL cycle names its actor; a SCHEDULED cycle has none',
        path: ['requestedBy'],
      })
    }
    if ((c.status === 'CLOSED') !== (c.closedAt !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'a CLOSED cycle carries its closing instant',
        path: ['closedAt'],
      })
    }
  })

/**
 * One collection attempt. This is the run/cycle gap `jobCollectionReportSchema`
 * does not cover: the report says what an attempt found, this says who owned
 * it, under which versions, and where it got to.
 */
const jobCollectionAttemptFields = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  cycleId: z.string().uuid(),
  /** Stable across retries: UNIQUE(source, attemptId) in the database. */
  attemptId: attemptIdSchema,
  /** A change here invalidates the checkpoint — it belongs to the old config. */
  configVersion: intColumnPositiveSchema,
  adapterVersion: z.string().min(1).max(100),
  trigger: jobCollectionTriggerSchema,
  outcome: jobCollectionOutcomeSchema,
  coverage: jobCollectionCoverageSchema,
  /** Who holds the run. Present exactly while the run is STARTED. */
  ownerToken: z.string().min(1).max(200).nullable(),
  /** Monotonic epoch: a write from a fenced-out owner is refused. */
  fencingEpoch: z.number().int().positive(),
  leaseExpiresAt: z.string().datetime().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  /** Typed and sanitized — never a provider secret, never a raw upstream body. */
  errorCode: jobErrorCodeSchema.nullable(),
  errorMessage: z.string().max(500).nullable(),
})

/** A terminal attempt carries its end instant; a running one does not. */
const refineAttemptTermination = (
  a: { outcome: string; endedAt: string | null },
  ctx: z.RefinementCtx,
) => {
  if ((a.outcome === 'STARTED') !== (a.endedAt === null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'a terminal attempt carries its end instant; a running one does not',
      path: ['endedAt'],
    })
  }
}

/**
 * The WORKER-INTERNAL attempt shape. Carries `ownerToken` and `fencingEpoch`,
 * which a worker needs and nobody else does.
 *
 * SR-M-5 — the NAMING CONVENTION for this module, and the reason for it: the
 * PLAIN name (`jobCollectionAttemptSchema`) is the shape safe to answer a
 * request with, and the internal one is marked `...Worker...`. Round 1 had it
 * the other way round, so the name a Phase-6 endpoint author reaches for first
 * resolved to the leaky shape, with only a doc comment between the import and
 * the leak. A wrong import now has to read "Worker" to be written.
 */
export const jobCollectionAttemptWorkerSchema = jobCollectionAttemptFields.superRefine((a, ctx) => {
  refineAttemptTermination(a, ctx)
  if (a.outcome === 'STARTED' && (a.ownerToken === null || a.leaseExpiresAt === null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'a running attempt is owned under a lease',
      path: ['ownerToken'],
    })
  }
})

/**
 * SR-M-4. The shape a NON-WORKER response is built from — and, per SR-M-5, the
 * one holding the plain name. `ownerToken` and `fencingEpoch` are
 * lease-and-fencing bookkeeping — who holds the row and with what authority —
 * and an operator screen has no use for either.
 *
 * Omitted structurally rather than documented as "Phase 6 must strip these":
 * a note is honoured by whoever reads it, while a field the schema does not
 * have cannot be serialized by accident. No endpoint consumes the attempt yet,
 * so this costs nothing now and removes the leak before it can exist.
 */
export const jobCollectionAttemptSchema = jobCollectionAttemptFields
  .omit({ ownerToken: true, fencingEpoch: true })
  .superRefine(refineAttemptTermination)

/**
 * Operational health of one source. Deliberately a SEPARATE schema rather than
 * fields added to `jobSourceSchema`: that DTO is already on the wire, and
 * disabled / paused / readiness-blocked are three distinct states (r5 6.5, 7.5)
 * that an existing client must not have to understand to keep parsing.
 */
export const jobSourceHealthSchema = z
  .object({
    sourceId: z.string().uuid(),
    /** `null` until Task 3.7 backfills the stable manifest identity (C-16). */
    manifestId: jobManifestIdSchema.nullable(),
    namespace: z.string().max(200),
    manifestVersion: intColumnPositiveSchema,
    policyVersion: intColumnPositiveSchema,
    configVersion: intColumnPositiveSchema,
    readiness: jobSourceReadinessSchema,
    /** Bounded here and by `ck_job_sources_readiness_reason_bounded`. */
    readinessReason: z.string().max(500).nullable(),
    adminState: jobSourceAdminStateSchema,
    lastAttemptAt: z.string().datetime().nullable(),
    lastSuccessAt: z.string().datetime().nullable(),
    /** Last attempt that returned at least one record — a SUCCEEDED attempt may return none. */
    lastNonemptyAt: z.string().datetime().nullable(),
    nextAttemptAt: z.string().datetime().nullable(),
    cooldownUntil: z.string().datetime().nullable(),
    consecutiveFailures: intColumnCountSchema,
    lastErrorCode: jobErrorCodeSchema.nullable(),
    lastErrorMessage: z.string().max(500).nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.readiness === 'BLOCKED' && s.readinessReason === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a BLOCKED source states why',
        path: ['readinessReason'],
      })
    }
  })

/** One durable unit of recompute work, keyed so a producer can enqueue idempotently. */
const jobDirtyWorkItemFields = z.object({
  id: z.string().uuid(),
  entityKind: jobDirtyWorkEntityKindSchema,
  entityId: z.string().uuid(),
  /** The version the worker must reach before installing output. */
  targetVersion: z.number().int().positive(),
  /** UNIQUE(entityKind, entityId, targetVersion, reason) in the database. */
  reason: z.string().min(1).max(100),
  status: jobDirtyWorkStatusSchema,
  claimOwner: z.string().min(1).max(200).nullable(),
  claimedAt: z.string().datetime().nullable(),
  leaseExpiresAt: z.string().datetime().nullable(),
  fencingEpoch: z.number().int().positive(),
  retryCount: intColumnCountSchema,
  cycleId: z.string().uuid().nullable(),
  lastErrorCode: jobErrorCodeSchema.nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
})

/** A terminal item (DONE / FAILED / DEFERRED) carries its completion instant. */
const refineDirtyWorkTermination = (
  w: { status: string; completedAt: string | null },
  ctx: z.RefinementCtx,
) => {
  const terminal = w.status === 'DONE' || w.status === 'FAILED' || w.status === 'DEFERRED'
  if (terminal !== (w.completedAt !== null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'a terminal item (DONE / FAILED / DEFERRED) carries its completion instant',
      path: ['completedAt'],
    })
  }
}

/**
 * The WORKER-INTERNAL item shape: it carries the claim and the fencing epoch.
 * Marked `...Worker...` for the reason given on the attempt above (SR-M-5).
 */
export const jobDirtyWorkItemWorkerSchema = jobDirtyWorkItemFields.superRefine((w, ctx) => {
  // CR-M-1. NOT one equality of two booleans: `status !== 'CLAIMED'` with an
  // owner and NO lease made both sides false, so the equality held and the
  // state this message calls impossible parsed. Each branch therefore names
  // the columns it requires, and the OTHER branch names them cleared.
  const claimed = w.status === 'CLAIMED'
  const owned = w.claimOwner !== null && w.leaseExpiresAt !== null
  const cleared = w.claimOwner === null && w.leaseExpiresAt === null
  if (claimed ? !owned : !cleared) {
    ctx.addIssue({
      code: 'custom',
      message: 'a CLAIMED item is owned under a lease, and only a CLAIMED item is',
      path: ['claimOwner'],
    })
  }
  refineDirtyWorkTermination(w, ctx)
})

/**
 * SR-M-4. The shape a NON-WORKER response is built from: no `claimOwner`, no
 * `fencingEpoch`, and the plain name (SR-M-5). Same reasoning as
 * `jobCollectionAttemptSchema` — the boundary is structural, so Phase 6 cannot
 * forget to strip them.
 */
export const jobDirtyWorkItemSchema = jobDirtyWorkItemFields
  .omit({ claimOwner: true, fencingEpoch: true })
  .superRefine(refineDirtyWorkTermination)

// ---------------------------------------------------------------------------
// Queue HR API (r5 Phase 6, T0) — the `/job-queue` wire contracts
// ---------------------------------------------------------------------------
//
// Built against the owner's queue model of 2026-10-18 (plan r5 §4 "Queue
// model"): a submission is PER SENIOR, there is no global "taken" state, and
// no team may learn anything about another team's activity. So, by
// construction, NO response shape below has a field for another team's
// identity — no assignee, actor, claimer team, "taken by", foreign count or
// foreign name. Every response object is `.strict()`, so a field added by
// mistake on the server is refused at the client's `.parse()` instead of
// leaking silently. The one name carried (`submittedByName`) is a same-team
// recruiter's, on a submission row the server only returns inside the
// viewer's own scope (Phase-6 service obligation).
//
// The legacy phase-1 shapes above (`jobQueueStatusSchema`,
// `jobQueueItemSchema`, `jobQueueListSchema`, `jobQueueQuerySchema`,
// `dismissJobQueueItemSchema`) are unchanged and still parse (extend-in-place).

/** The three tabs: «Нові» · «Подані» · «Приховані». Beside the legacy `jobQueueStatusSchema`. */
export const jobQueueTabSchema = z.enum(['NEW', 'SUBMITTED', 'HIDDEN'])

/** «Тип збігу»: a stack match, or an item that needs review. EXCLUDED is never listed. */
export const jobQueueEligibilitySchema = z.enum(['LEAD', 'TRIAGE'])

/** The viewer's OWN team's activity on an opportunity. Never another team's. */
export const jobQueueActivitySchema = z.enum(['OPENED', 'NOT_OPENED'])

/**
 * A multi-select query parameter: a comma-separated list of enum members,
 * de-duplicated. An empty or unknown member is a 400, never "no restriction".
 */
// Stryker disable next-line ArrowFunction: this helper runs only at module import (schema construction), before any test's per-test coverage window opens, so the vitest runner cannot activate the mutant inside a test (the static-mutant blind spot documented in interviews.ts). Replacing it with `() => undefined` makes `.optional()` throw at import, failing every test file; the multi-select behaviour is pinned by job-sourcing-queue-api.spec.ts.
const csvEnumListSchema = <E extends z.ZodType<string, string>>(member: E) =>
  z
    .string()
    // Every source type, comma-joined, is 396 characters today.
    .max(600)
    .transform((s) => [...new Set(s.split(',').map((v) => v.trim()))])
    .pipe(z.array(member))

/** How many seniors one list request may filter by. */
export const JOB_QUEUE_SENIOR_FILTER_MAX = 50

/**
 * The same comma-separated form for the senior filter, lower-cased here so the
 * de-duplication, the cursor signature and the SQL all see one spelling of an id.
 * The raw bound is 50 canonical ids (36 characters each) and their 49 commas.
 */
const seniorIdListSchema = z
  .string()
  .max(1849)
  .transform((s) => [...new Set(s.split(',').map((v) => v.trim().toLowerCase()))])
  .pipe(z.array(z.string().uuid()).max(JOB_QUEUE_SENIOR_FILTER_MAX))

/**
 * GET `/job-queue`. `teamId` absent = the HR's first active team in stable
 * order, or the STUDIO scope for an ADMIN; when present it must be a team the
 * actor belongs to (Phase-6 obligation — a schema cannot see membership).
 * `seniorIds` is an OR: a row is listed if ANY of them matches. An id outside
 * the scope's own seniors is dropped; none left means an empty result.
 */
export const jobQueueListQuerySchema = z
  .object({
    teamId: z.string().uuid().optional(),
    tab: jobQueueTabSchema.default('NEW'),
    search: z.string().trim().min(1).max(200).optional(),
    source: csvEnumListSchema(jobSourceTypeSchema).optional(),
    eligibility: csvEnumListSchema(jobQueueEligibilitySchema).optional(),
    availability: csvEnumListSchema(jobAvailabilitySchema).optional(),
    activity: csvEnumListSchema(jobQueueActivitySchema).optional(),
    seniorIds: seniorIdListSchema.optional(),
    cursor: z.string().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()

/** GET `/job-queue/:id[/sources|/seniors]`: the scope and, for a continuation, its cursor. */
export const jobQueueScopeQuerySchema = z
  .object({
    teamId: z.string().uuid().optional(),
    cursor: z.string().min(1).max(300).optional(),
  })
  .strict()

const jobQueuePrimarySourceSchema = z
  .object({
    sourceRecordId: z.string().uuid(),
    sourceType: jobSourceTypeSchema,
    url: externalHttpsUrlSchema,
  })
  .strict()

/** The list row's keyword chips are a summary, not the card's per-senior evidence. */
export const JOB_QUEUE_ROW_KEYWORDS_MAX = 20

/**
 * One list row. Every count is the VIEWER'S scope only (HR: own team; ADMIN:
 * studio). `stopListedSeniorCount` is how many of those seniors excluded the
 * opportunity — a count, never who (r5 §4). `matchedKeywords` is the union over
 * the same seniors `matchedSeniorCount` counts, never attributed to one of them.
 */
export const jobQueueListItemSchema = z
  .object({
    opportunityId: z.string().uuid(),
    revision: intColumnPositiveSchema,
    title: z.string().max(500),
    companyName: z.string().max(255).nullable(),
    location: z.string().max(500).nullable(),
    /**
     * `null` exactly for a manual card (`POST /job-queue/manual`): a vacancy an HR or ADMIN
     * entered by hand has no source record. A sourced opportunity with no active source is
     * not a row at all, so `null` never means "sourced, source gone".
     */
    primarySource: jobQueuePrimarySourceSchema.nullable(),
    /** The employer's application link, when one is known (a manual card's stated URL). */
    applicationUrl: externalHttpsUrlSchema.nullable(),
    alsoSeenOnCount: countSchema,
    availability: jobAvailabilitySchema,
    eligibility: jobQueueEligibilitySchema,
    seniority: jobSeniorityLevelSchema,
    matchedKeywords: z
      .array(z.string().max(MAX_STACK_KEYWORD_CHARS))
      .max(JOB_QUEUE_ROW_KEYWORDS_MAX),
    matchedSeniorCount: countSchema,
    submittedSeniorCount: countSchema,
    stopListedSeniorCount: countSchema,
    openedByTeam: z.boolean(),
    hidden: z.boolean(),
    publishedAt: z.string().datetime().nullable(),
    firstSeenAt: z.string().datetime(),
  })
  .strict()

/**
 * The facts of the generation a page was read from: the rule and the moment its order was evaluated
 * (r5 Task 6.2). `capped` means it reached its entry cap, so a lower-ranked opportunity may be missing
 * from this list and from its counts.
 */
export const jobQueueGenerationFactsSchema = z
  .object({
    ruleVersion: z.string().min(1).max(100),
    evaluatedAt: z.string().datetime(),
    capped: z.boolean(),
  })
  .strict()

/**
 * The list page. Tab counts are the authorized totals of the scope, not narrowed by filters.
 * `generation` is null only for a scope with no queue, which reads no generation at all.
 */
export const jobQueueListResponseSchema = z
  .object({
    items: z.array(jobQueueListItemSchema).max(50),
    nextCursor: z.string().max(300).nullable(),
    counts: z.object({ NEW: countSchema, SUBMITTED: countSchema, HIDDEN: countSchema }).strict(),
    generation: jobQueueGenerationFactsSchema.nullable(),
  })
  .strict()

/**
 * A submission as the viewer's scope sees it. `TAKEN` = submitted, `RELEASED`
 * = cancelled (the row is kept; a re-submission is a versioned UPDATE).
 * `submittedByName` is a same-team recruiter, or null when the server does not
 * disclose it.
 */
export const jobQueueSubmissionSchema = z
  .object({
    id: z.string().uuid(),
    opportunityId: z.string().uuid(),
    seniorId: z.string().uuid(),
    state: jobQueueAssignmentStateSchema,
    submittedAt: z.string().datetime(),
    cancelledAt: z.string().datetime().nullable(),
    version: intColumnPositiveSchema,
    submittedByName: z.string().max(255).nullable(),
  })
  .strict()
  // One explicit case per state: a state added later has no case, returns
  // undefined and is refused, instead of silently passing as "not cancelled".
  .refine(
    (s) => {
      switch (s.state) {
        case 'TAKEN':
          return s.cancelledAt === null
        case 'RELEASED':
          return s.cancelledAt !== null
      }
    },
    {
      message: 'a cancelled submission records when, and only a cancelled one does',
      path: ['cancelledAt'],
    },
  )

/**
 * Another team's live submission of a SHARED senior (owner decision A3, option
 * (a) — pending): a bare marker, NEVER the submission object. No id, no
 * timestamps, no version, no name, no team. Phase 6's real-DB spec must assert
 * each of those fields is absent from the card JSON, not merely unparsed.
 */
export const jobQueueForeignSubmissionSchema = z
  .object({ submittedElsewhere: z.literal(true) })
  .strict()

/** How many seniors the list filter's picker offers. */
export const JOB_QUEUE_SENIOR_OPTIONS_MAX = 200

/**
 * GET `/job-queue/seniors`: the seniors of the viewer's resolved scope, and only who they are and
 * which team the picker groups them under (`teams.name`, varchar 255; null for a senior with no live
 * membership, which only the STUDIO scope can list).
 */
export const jobQueueSeniorOptionsResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().max(255),
            teamName: z.string().max(255).nullable(),
          })
          .strict(),
      )
      .max(JOB_QUEUE_SENIOR_OPTIONS_MAX),
  })
  .strict()

/** One of the viewer's own seniors on the card. */
export const jobQueueCardSeniorSchema = z
  .object({
    seniorId: z.string().uuid(),
    displayName: z.string().max(255),
    /** «Збіг неточний»: match confidence, not availability. */
    matchApproximate: z.boolean(),
    matchedKeywords: z.array(z.string().max(MAX_STACK_KEYWORD_CHARS)).max(200),
    /** Own scope: the full row. Another team's (shared senior only): the bare marker. */
    submission: z.union([jobQueueSubmissionSchema, jobQueueForeignSubmissionSchema]).nullable(),
  })
  .strict()

/** GET `/job-queue/:id/seniors` — and the card's preview (≤ 200, then continue). */
export const jobQueueSeniorsContinuationSchema = z
  .object({
    items: z.array(jobQueueCardSeniorSchema).max(200),
    totalCount: countSchema,
    nextCursor: z.string().max(300).nullable(),
  })
  .strict()

/** GET `/job-queue/:id/sources` — and the card's preview (≤ 20, then continue). */
export const jobQueueSourcesContinuationSchema = z
  .object({
    items: z.array(jobQueueSourceItemSchema.strict()).max(20),
    totalCount: countSchema,
    nextCursor: z.string().max(300).nullable(),
  })
  .strict()

/** The duplicates preview, strict down to each item. */
const jobQueueDuplicatesPreviewSchema = jobPossibleDuplicatesPreviewSchema
  .extend({ items: z.array(jobPossibleDuplicateSchema.strict()).max(5) })
  .strict()

/** GET `/job-queue/:id` — the latest canonical facts, authorized for the viewer. */
export const jobQueueCardResponseSchema = jobQueueListItemSchema
  .extend({
    // SECURITY: UNTRUSTED 3rd-party markdown; sanitized on render (no raw HTML).
    descriptionMd: z.string().max(DESCRIPTION_MD_MAX),
    /** The opportunity changed after the list was built — informational only. */
    newerThanList: z.boolean(),
    seniors: jobQueueSeniorsContinuationSchema,
    sources: jobQueueSourcesContinuationSchema,
    possibleDuplicates: jobQueueDuplicatesPreviewSchema.nullable(),
  })
  .strict()

/** POST `/job-queue/:id/submissions` — log ONE senior as submitted (it sends nothing). */
export const jobQueueSubmitRequestSchema = z
  .object({
    teamId: z.string().uuid().optional(),
    seniorId: z.string().uuid(),
    /** Client-generated; a retry with the same key returns the earlier success. */
    idempotencyKey: z.string().uuid(),
    expectedOpportunityRevision: intColumnPositiveSchema,
    /** The submission's version when re-submitting a cancelled one; absent for a first one. */
    expectedVersion: intColumnPositiveSchema.optional(),
    /** Required `true` once the server answered `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED`. */
    confirmPossibleDuplicate: z.boolean().default(false),
  })
  .strict()

/**
 * POST `/job-queue/:id/submissions/:submissionId/cancel` — own team's recruiter or ADMIN.
 * A `submissionId` that does not exist, belongs to another opportunity or to another team
 * answers `JOB_OPPORTUNITY_NOT_FOUND` (404) — the same as a missing one; no distinct code.
 */
export const jobQueueCancelSubmissionRequestSchema = z
  .object({
    teamId: z.string().uuid().optional(),
    idempotencyKey: z.string().uuid(),
    expectedVersion: intColumnPositiveSchema,
  })
  .strict()

export const jobQueueSubmissionResponseSchema = z
  .object({ submission: jobQueueSubmissionSchema })
  .strict()

/**
 * POST `/job-queue/manual` (ADMIN, HR) — a card for a vacancy found OUTSIDE the automatic
 * sources, created together with its first submission in ONE transaction. There is no card
 * without a submission and no submission without a resume, so `submission` and its
 * `resumeId` are required here: a body without them is a 400 before any route logic runs.
 * `resumeId` names an existing CRM resume of that senior; this route never uploads one.
 * The answer is `jobQueueSubmissionResponseSchema` (201); `submission.opportunityId` is the
 * new card. An `applicationUrl` some opportunity already carries is `JOB_QUEUE_MANUAL_DUPLICATE`
 * (409); the senior's live submission to a possible duplicate in the actor's scope is
 * `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` (409) until `confirmPossibleDuplicate` is `true`.
 */
export const jobQueueManualCardRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    companyName: z.string().trim().min(1).max(255),
    applicationUrl: externalHttpsUrlSchema.optional(),
    descriptionMd: z.string().min(1).max(DESCRIPTION_MD_MAX),
    /** Client-generated; a retry with the same key returns the earlier success. */
    idempotencyKey: z.string().uuid(),
    submission: z
      .object({
        teamId: z.string().uuid(),
        seniorId: z.string().uuid(),
        resumeId: z.string().uuid(),
      })
      .strict(),
    /** Required `true` once the server answered `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED`. */
    confirmPossibleDuplicate: z.boolean().default(false),
  })
  .strict()

/** The 409 body of `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED`: the viewer-authorized duplicates only. */
export const jobQueuePossibleDuplicateConflictSchema = z
  .object({
    code: z.literal('JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED'),
    possibleDuplicates: jobQueueDuplicatesPreviewSchema,
  })
  .strict()

/** STUDIO = whole studio, ADMIN only. TEAM = the request's own team. */
export const jobQueueDismissScopeSchema = jobQueueScopeKindSchema

/** POST `/job-queue/:id/dismiss`. The reason is a fixed choice — no free text. */
export const jobQueueDismissRequestSchema = z
  .object({
    teamId: z.string().uuid().optional(),
    scope: jobQueueDismissScopeSchema,
    reason: jobQueueDismissReasonSchema,
    idempotencyKey: z.string().uuid(),
    /** The dismissal's version on a re-dismiss; absent for a first one. */
    expectedVersion: intColumnPositiveSchema.optional(),
  })
  .strict()

/** POST `/job-queue/:id/undo` — undoes the dismissal in exactly this scope. */
export const jobQueueUndoRequestSchema = z
  .object({
    teamId: z.string().uuid().optional(),
    scope: jobQueueDismissScopeSchema,
    idempotencyKey: z.string().uuid(),
    expectedVersion: intColumnPositiveSchema,
  })
  .strict()

export const jobQueueDismissalResponseSchema = z
  .object({
    opportunityId: z.string().uuid(),
    scope: jobQueueDismissScopeSchema,
    reason: jobQueueDismissReasonSchema,
    hidden: z.boolean(),
    version: intColumnPositiveSchema,
  })
  .strict()

/** POST `/job-queue/:id/opened` — click telemetry; 204, never blocks navigation. */
export const jobQueueOpenedRequestSchema = z
  .object({
    teamId: z.string().uuid().optional(),
    sourceRecordId: z.string().uuid(),
  })
  .strict()

/**
 * POST `/job-queue/:id/suppress` (ADMIN, studio-wide; 204). Takes the opportunity down for every
 * team scope. A retry with the same key is answered from the log and writes nothing.
 */
export const jobQueueSuppressRequestSchema = z
  .object({ idempotencyKey: z.string().uuid() })
  .strict()

/** POST `/job-queue/recompute` (ADMIN) — enqueued, never inline; 202 + the run id. */
export const jobQueueRecomputeResponseSchema = z.object({ runId: z.string().uuid() }).strict()

/*
 * r5 Task 6.4b — the ADMIN triage writes. The target ids (opportunity, team,
 * subscription) come from the route; the body carries the expected versions,
 * the reason and the per-actor idempotency key every queue write carries.
 */

/** POST `/job-queue/:id/team-triage` (ADMIN; 201 + the grant). */
export const jobQueueTeamTriageGrantRequestSchema = z
  .object({
    teamId: z.string().uuid(),
    // `job_opportunities.revision` starts at 1, so 0 can never match.
    expectedOpportunityRevision: intColumnPositiveSchema,
    policyVersion: intColumnCountSchema,
    reason: triageReasonSchema,
    expiresAt: z.string().datetime(),
    idempotencyKey: z.string().uuid(),
  })
  .strict()

/** DELETE `/job-queue/:id/team-triage/:teamId` (ADMIN; 200 + the revoked grant). */
export const jobQueueTeamTriageRevokeRequestSchema = z
  .object({
    expectedGrantVersion: intColumnPositiveSchema,
    reason: triageReasonSchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict()

/** POST `/job-queue/team-triage-subscriptions` (ADMIN; 201 + the subscription). */
export const jobQueueTeamTriageSubscribeRequestSchema =
  createJobQueueTeamTriageSubscriptionSchema.extend({ idempotencyKey: z.string().uuid() })

/** DELETE `/job-queue/team-triage-subscriptions/:id` (ADMIN; 200 + the revoked subscription). */
export const jobQueueTeamTriageUnsubscribeRequestSchema = revokeJobQueueTeamTriageSubscriptionSchema
  .omit({ subscriptionId: true })
  .extend({ idempotencyKey: z.string().uuid() })

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
export type OpenJobOpportunityResult = z.infer<typeof openJobOpportunityResultSchema>
export type UpdateJobSuggestionStatusDto = z.infer<typeof updateJobSuggestionStatusSchema>
export type JobExclusionDto = z.infer<typeof jobExclusionSchema>
export type JobExclusionListDto = z.infer<typeof jobExclusionListSchema>
export type CreateJobExclusionDto = z.infer<typeof createJobExclusionSchema>
export type JobCollectionResultDto = z.infer<typeof jobCollectionResultSchema>
export type JobCollectionFailureDto = z.infer<typeof jobCollectionFailureSchema>
export type JobCollectionRunDto = z.infer<typeof jobCollectionRunSchema>
export type JobSourceBudgetWindow = z.infer<typeof jobSourceBudgetWindowSchema>
export type JobSourceBudgetState = z.infer<typeof jobSourceBudgetStateSchema>
export type JobSourceTriggerMode = z.infer<typeof jobSourceTriggerModeSchema>
export type JobSourceBudgetDto = z.infer<typeof jobSourceBudgetSchema>
export type JobSourceDto = z.infer<typeof jobSourceSchema>
export type JobSourceListDto = z.infer<typeof jobSourceListSchema>
export type JobSeniorityLevel = z.infer<typeof jobSeniorityLevelSchema>
export type JobQueueStatus = z.infer<typeof jobQueueStatusSchema>
export type JobSignalKind = z.infer<typeof jobSignalKindSchema>
export type JobAlsoSeenOn = z.infer<typeof jobAlsoSeenOnSchema>
export type JobQueueMatchedSenior = z.infer<typeof jobQueueMatchedSeniorSchema>
export type JobQueueItemDto = z.infer<typeof jobQueueItemSchema>
export type JobQueueCardDto = z.infer<typeof jobQueueCardSchema>
export type JobQueueListDto = z.infer<typeof jobQueueListSchema>
export type JobQueueQuery = z.infer<typeof jobQueueQuerySchema>
export type DismissJobQueueItemDto = z.infer<typeof dismissJobQueueItemSchema>
export type JobAvailability = z.infer<typeof jobAvailabilitySchema>
export type JobCollectionOutcome = z.infer<typeof jobCollectionOutcomeSchema>
export type JobCollectionCoverage = z.infer<typeof jobCollectionCoverageSchema>
export type JobIdentityKind = z.infer<typeof jobIdentityKindSchema>
export type JobOpportunityMatchOutcome = z.infer<typeof jobOpportunityMatchOutcomeSchema>
export type JobOpportunityLinkDecision = z.infer<typeof jobOpportunityLinkDecisionSchema>
export type JobSourceIdentity = z.infer<typeof jobSourceIdentitySchema>
export type JobSourceRevisionDto = z.infer<typeof jobSourceRevisionSchema>
export type JobCollectionReport = z.infer<typeof jobCollectionReportSchema>
export type JobQueueScopedQuery = z.infer<typeof jobQueueScopedQuerySchema>
export type JobQueueSeniorPage = z.infer<typeof jobQueueSeniorPageSchema>
export type JobQueueSourcePage = z.infer<typeof jobQueueSourcePageSchema>
export type JobPossibleDuplicatesPreview = z.infer<typeof jobPossibleDuplicatesPreviewSchema>
export type ConfirmPossibleDuplicateDto = z.infer<typeof confirmPossibleDuplicateSchema>
export type CreateJobQueueTeamTriageGrantDto = z.infer<typeof createJobQueueTeamTriageGrantSchema>
export type RevokeJobQueueTeamTriageGrantDto = z.infer<typeof revokeJobQueueTeamTriageGrantSchema>
export type JobQueueTeamTriageGrantDto = z.infer<typeof jobQueueTeamTriageGrantSchema>
export type CreateJobQueueTeamTriageSubscriptionDto = z.infer<
  typeof createJobQueueTeamTriageSubscriptionSchema
>
export type RevokeJobQueueTeamTriageSubscriptionDto = z.infer<
  typeof revokeJobQueueTeamTriageSubscriptionSchema
>
export type JobQueueTeamTriageSubscriptionDto = z.infer<typeof jobQueueTeamTriageSubscriptionSchema>
export type JobQueueTeamTriageSubscriptionWorkerDto = z.infer<
  typeof jobQueueTeamTriageSubscriptionWorkerSchema
>
export type JobRoleFamily = z.infer<typeof jobRoleFamilySchema>
export type JobTriageRoleFamily = z.infer<typeof jobTriageRoleFamilySchema>
export type JobQueueTeamTriageGrantRequest = z.infer<typeof jobQueueTeamTriageGrantRequestSchema>
export type JobQueueTeamTriageRevokeRequest = z.infer<typeof jobQueueTeamTriageRevokeRequestSchema>
export type JobQueueTeamTriageSubscribeRequest = z.infer<
  typeof jobQueueTeamTriageSubscribeRequestSchema
>
export type JobQueueTeamTriageUnsubscribeRequest = z.infer<
  typeof jobQueueTeamTriageUnsubscribeRequestSchema
>
export type JobQueueScopeKind = z.infer<typeof jobQueueScopeKindSchema>
export type JobQueueScope = z.infer<typeof jobQueueScopeSchema>
export type JobQueueAssignmentState = z.infer<typeof jobQueueAssignmentStateSchema>
export type JobQueueActionKind = z.infer<typeof jobQueueActionKindSchema>
export type JobQueueGenerationStatus = z.infer<typeof jobQueueGenerationStatusSchema>
export type JobQueueAssignmentWorkerDto = z.infer<typeof jobQueueAssignmentWorkerSchema>
export type JobQueueAssignmentDto = z.infer<typeof jobQueueAssignmentSchema>
export type JobQueueDismissalDto = z.infer<typeof jobQueueDismissalSchema>
export type JobQueueDismissalWorkerDto = z.infer<typeof jobQueueDismissalWorkerSchema>
export type JobQueueActionWorkerDto = z.infer<typeof jobQueueActionWorkerSchema>
export type JobQueueGenerationWorkerDto = z.infer<typeof jobQueueGenerationWorkerSchema>
export type JobQueueGenerationDto = z.infer<typeof jobQueueGenerationSchema>
export type JobQueueGenerationEntryWorkerDto = z.infer<typeof jobQueueGenerationEntryWorkerSchema>
export type JobCollectionTrigger = z.infer<typeof jobCollectionTriggerSchema>
export type JobCollectionCycleStatus = z.infer<typeof jobCollectionCycleStatusSchema>
export type JobSourceReadiness = z.infer<typeof jobSourceReadinessSchema>
export type JobSourceAdminState = z.infer<typeof jobSourceAdminStateSchema>
export type JobMeterUnit = z.infer<typeof jobMeterUnitSchema>
export type JobMeterWindow = z.infer<typeof jobMeterWindowSchema>
export type JobMeterReservationStatus = z.infer<typeof jobMeterReservationStatusSchema>
export type JobDirtyWorkEntityKind = z.infer<typeof jobDirtyWorkEntityKindSchema>
export type JobDirtyWorkStatus = z.infer<typeof jobDirtyWorkStatusSchema>
export type JobAccountKey = z.infer<typeof jobAccountKeySchema>
export type JobErrorCode = z.infer<typeof jobErrorCodeSchema>
export type JobSourceMeterDto = z.infer<typeof jobSourceMeterSchema>
export type JobAccountMeterDto = z.infer<typeof jobAccountMeterSchema>
export type JobMeterReservationDto = z.infer<typeof jobMeterReservationSchema>
export type JobCollectionCycleDto = z.infer<typeof jobCollectionCycleSchema>
export type JobCollectionAttemptWorkerDto = z.infer<typeof jobCollectionAttemptWorkerSchema>
export type JobCollectionAttemptDto = z.infer<typeof jobCollectionAttemptSchema>
export type JobDirtyWorkItemDto = z.infer<typeof jobDirtyWorkItemSchema>
export type JobSourceHealthDto = z.infer<typeof jobSourceHealthSchema>
export type JobDirtyWorkItemWorkerDto = z.infer<typeof jobDirtyWorkItemWorkerSchema>
export type JobQueueTab = z.infer<typeof jobQueueTabSchema>
export type JobQueueEligibility = z.infer<typeof jobQueueEligibilitySchema>
export type JobQueueActivity = z.infer<typeof jobQueueActivitySchema>
export type JobQueueListQuery = z.infer<typeof jobQueueListQuerySchema>
export type JobQueueScopeQuery = z.infer<typeof jobQueueScopeQuerySchema>
export type JobQueueSeniorOptionsResponseDto = z.infer<typeof jobQueueSeniorOptionsResponseSchema>
export type JobQueueListItemDto = z.infer<typeof jobQueueListItemSchema>
export type JobQueueListResponseDto = z.infer<typeof jobQueueListResponseSchema>
export type JobQueueSubmissionDto = z.infer<typeof jobQueueSubmissionSchema>
export type JobQueueForeignSubmissionDto = z.infer<typeof jobQueueForeignSubmissionSchema>
export type JobQueueCardSeniorDto = z.infer<typeof jobQueueCardSeniorSchema>
export type JobQueueSeniorsContinuationDto = z.infer<typeof jobQueueSeniorsContinuationSchema>
export type JobQueueSourcesContinuationDto = z.infer<typeof jobQueueSourcesContinuationSchema>
export type JobQueueCardResponseDto = z.infer<typeof jobQueueCardResponseSchema>
export type JobQueueSubmitRequestDto = z.infer<typeof jobQueueSubmitRequestSchema>
export type JobQueueManualCardRequestDto = z.infer<typeof jobQueueManualCardRequestSchema>
export type JobQueueCancelSubmissionRequestDto = z.infer<
  typeof jobQueueCancelSubmissionRequestSchema
>
export type JobQueueSubmissionResponseDto = z.infer<typeof jobQueueSubmissionResponseSchema>
export type JobQueuePossibleDuplicateConflictDto = z.infer<
  typeof jobQueuePossibleDuplicateConflictSchema
>
export type JobQueueDismissRequestDto = z.infer<typeof jobQueueDismissRequestSchema>
export type JobQueueUndoRequestDto = z.infer<typeof jobQueueUndoRequestSchema>
export type JobQueueDismissalResponseDto = z.infer<typeof jobQueueDismissalResponseSchema>
export type JobQueueOpenedRequestDto = z.infer<typeof jobQueueOpenedRequestSchema>
export type JobQueueSuppressRequestDto = z.infer<typeof jobQueueSuppressRequestSchema>
export type JobQueueRecomputeResponseDto = z.infer<typeof jobQueueRecomputeResponseSchema>
