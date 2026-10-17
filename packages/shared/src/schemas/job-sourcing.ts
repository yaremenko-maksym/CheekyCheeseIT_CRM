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

export const jobSourceSchema = z.object({
  id: z.string().uuid(),
  type: jobSourceTypeSchema,
  enabled: z.boolean(),
  triggerMode: jobSourceTriggerModeSchema,
  lastCollectedAt: z.string().datetime().nullable(),
  minIntervalHours: z.number().int().positive().nullable(),
  disabledReason: z.string().max(500).nullable(),
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

export const dismissJobQueueItemSchema = z.object({
  reason: z.enum(['NOT_RELEVANT', 'SPAM', 'DEAD_LINK']).default('NOT_RELEVANT'),
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
 * per-cycle HTML call budget) get the column's own ceiling, so the contract
 * never accepts a value the column answers with 22003.
 */
const PG_INT_MAX = 2_147_483_647
const intColumnCountSchema = countSchema.max(PG_INT_MAX)
const intColumnPositiveSchema = z.number().int().positive().max(PG_INT_MAX)

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
    received: countSchema,
    created: countSchema,
    revised: countSchema,
    unchanged: countSchema,
    duplicates: countSchema,
    invalid: countSchema,
    persistenceErrors: countSchema,
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

const triageReasonSchema = z.string().trim().min(1).max(500)

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

export const createJobQueueTeamTriageSubscriptionSchema = z
  .object({
    teamId: z.string().uuid(),
    roleFamily: z.string().trim().min(1).max(100),
    /** Empty = every source. Bounded by the number of provider types. */
    sourceTypes: z.array(jobSourceTypeSchema).max(jobSourceTypeSchema.options.length),
    policyVersion: countSchema,
    expiresAt: z.string().datetime(),
    reason: triageReasonSchema,
  })
  .strict()

export const revokeJobQueueTeamTriageSubscriptionSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    expectedSubscriptionVersion: countSchema,
    reason: triageReasonSchema,
  })
  .strict()

export const jobQueueTeamTriageSubscriptionSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  roleFamily: z.string().max(100),
  sourceTypes: z.array(jobSourceTypeSchema).max(jobSourceTypeSchema.options.length),
  policyVersion: countSchema,
  subscriptionVersion: countSchema,
  actorId: z.string().uuid(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
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
export const jobAccountKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,99}$/, 'must be a short lowercase account id without secrets')
  /**
   * SR-M-1. The alphabet above rejects uppercase, base64 (`+ / =`), URLs and
   * anything over 100 characters — but a pasted raw lowercase hex or
   * alphanumeric key still reads as a lawful id. A real identity is SEGMENTED
   * (`jsearch:rapidapi-main`, `dou.rss.jobs`), so a run of 24 or more
   * characters with no separator is refused and the paste fails loudly. Still
   * not a secret detector; it is the one structural difference between an
   * identity and a credential that a pattern CAN see.
   */
  .refine(
    (v) => !/[a-z0-9]{24}/.test(v),
    'must be segmented: a run of 24 or more characters without a separator is a pasted key',
  )

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
    policyVersion: z.number().int().positive(),
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
 */
export const jobCollectionAttemptSchema = jobCollectionAttemptFields.superRefine((a, ctx) => {
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
 * SR-M-4. The shape a NON-WORKER response is built from. `ownerToken` and
 * `fencingEpoch` are lease-and-fencing bookkeeping — who holds the row and with
 * what authority — and an operator screen has no use for either.
 *
 * Omitted structurally rather than documented as "Phase 6 must strip these":
 * a note is honoured by whoever reads it, while a field the schema does not
 * have cannot be serialized by accident. No endpoint consumes the attempt yet,
 * so this costs nothing now and removes the leak before it can exist.
 */
export const jobCollectionAttemptPublicSchema = jobCollectionAttemptFields
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
    manifestId: z.string().max(100).nullable(),
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

/** The WORKER-INTERNAL item shape: it carries the claim and the fencing epoch. */
export const jobDirtyWorkItemSchema = jobDirtyWorkItemFields.superRefine((w, ctx) => {
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
 * `fencingEpoch`. Same reasoning as `jobCollectionAttemptPublicSchema` — the
 * boundary is structural, so Phase 6 cannot forget to strip them.
 */
export const jobDirtyWorkItemPublicSchema = jobDirtyWorkItemFields
  .omit({ claimOwner: true, fencingEpoch: true })
  .superRefine(refineDirtyWorkTermination)

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
export type JobAccountMeterDto = z.infer<typeof jobAccountMeterSchema>
export type JobMeterReservationDto = z.infer<typeof jobMeterReservationSchema>
export type JobCollectionCycleDto = z.infer<typeof jobCollectionCycleSchema>
export type JobCollectionAttemptDto = z.infer<typeof jobCollectionAttemptSchema>
export type JobCollectionAttemptPublicDto = z.infer<typeof jobCollectionAttemptPublicSchema>
export type JobDirtyWorkItemPublicDto = z.infer<typeof jobDirtyWorkItemPublicSchema>
export type JobSourceHealthDto = z.infer<typeof jobSourceHealthSchema>
export type JobDirtyWorkItemDto = z.infer<typeof jobDirtyWorkItemSchema>
