import type { JobCollectionCoverage, JobCollectionOutcome, JobMeterUnit } from '@crm/shared'
import { jobErrorCodeSchema } from '@crm/shared'
import type { SourceObservation } from '../normalize/observation'

/**
 * The REPORTING provider contract (Task 2.3). A second, richer interface ALONGSIDE
 * `JobSourceProvider` in `../job-source.provider.ts` — the array contract (`collect` ->
 * `NormalizedPosting[]`) is deliberately NOT widened in place. DOU keeps the legacy one; Task 2.5
 * wraps it in an explicit legacy adapter.
 *
 * Every one of phase 3's ~25 adapters binds to `CollectionBatch`, so a field shaped badly here is
 * paid for 25 times. Two consequences the shapes below are built around:
 *
 * 1. THE PHASE-1 STORE OWNS THE VOCABULARY. Its schemas shipped and have production rows, so the
 *    outcome and coverage vocabularies are IMPORTED from `@crm/shared` and narrowed with `Exclude`,
 *    never retyped. Task 2.1's worst defect was a parallel vocabulary (`'NATIVE' | 'URL'` against
 *    the store's `'NATIVE_ID' | 'URL_FALLBACK'`) that a type cast kept from the compiler.
 * 2. OUTCOME AND COVERAGE ARE DERIVED, NEVER SUPPLIED. No adapter and no caller writes them; the
 *    collection loop computes them from what actually happened (`deriveOutcome` / `deriveCoverage`)
 *    and `buildCollectionBatch` is the only producer of a `CollectionBatch`. That is what makes
 *    "a failure never reports SUCCEEDED and never reports FULL_INVENTORY" structural rather than a
 *    rule each adapter author has to remember.
 */

/**
 * A BATCH is terminal by definition: it is what a finished attempt returns. The store's enum also
 * carries `STARTED` for a running attempt, which a returned batch can never be — so the batch's
 * vocabulary is the store's MINUS that one member, derived from it rather than written out.
 * `reporting-provider.store-conformance.spec.ts` pins that this `Exclude` still names exactly the
 * store's terminal members, so adding a sixth outcome upstream fails a test here.
 */
export type CollectionOutcome = Exclude<JobCollectionOutcome, 'STARTED'>

/** Imported wholesale: a provider has no coverage vocabulary of its own. */
export type CollectionCoverage = JobCollectionCoverage

/**
 * The error codes this base emits. The store deliberately keeps `jobErrorCodeSchema` OPEN (a
 * regex, not an enum) because the vocabulary is per adapter — so the closed set lives here, where
 * it is actually closed, and the conformance spec parses every member through the store's regex.
 *
 * `PERSISTENCE` is listed apart from `INVALID_RECORD` on purpose: a database failure is OUR fault
 * and must never be counted as a bad provider record (AC3).
 */
export const COLLECTION_ERROR_CODES = [
  'ACCESS_POLICY',
  'RATE_LIMIT',
  'TRANSIENT_NETWORK',
  'UPSTREAM',
  'PARSE_DRIFT',
  'INVALID_RECORD',
  'PERSISTENCE',
  'COST_STOP',
  'CANCELLED',
  'DEADLINE',
  'PAGE_CAP',
  'CURSOR_CYCLE',
  'PAYLOAD_TOO_LARGE',
  'ADAPTER_INVARIANT',
] as const

export type CollectionErrorCode = (typeof COLLECTION_ERROR_CODES)[number]

/** The redaction placeholder. Asserted BY NAME in tests, so both halves of "the key is gone and
 * something marks where it was" are checkable. */
export const REDACTED = '[REDACTED]'

/** A sample of a refused item is bounded to this many characters before it is ever reported. */
export const MAX_SAMPLE_CHARS = 200

/** At most this many refused items are sampled per attempt, whatever the batch size. */
export const MAX_SAMPLES = 5

/** At most this many request reports are retained per attempt (bounded telemetry). */
export const MAX_REQUEST_REPORTS = 200

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** The time window a scope asked for. A scope with a window can never claim FULL_INVENTORY. */
export interface CollectionWindow {
  from: Date
  to: Date
}

/**
 * WHAT was collected: which board, under which query, at which config version, over which window.
 * `namespace` is the store's own word for a board / account scope (`jobSourceIdentitySchema`), not
 * a synonym invented here.
 *
 * `query` being non-null is what makes a scope a SEARCH scope, and a search scope that hits the
 * page cap is a WINDOW rather than a truncated inventory (AC1). A full-inventory scope that hits
 * the cap is PARTIAL — we were supposed to see everything and did not.
 */
export interface SourceCoverageScope {
  namespace: string
  query: string | null
  configVersion: number
  window: CollectionWindow | null
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/**
 * The PROVIDER-SIDE dispositions. Deliberately NOT the store's seven
 * (`created/revised/unchanged/duplicates/...`): those are persistence outcomes the collector
 * decides in Task 2.5, and a provider that reported them would be guessing.
 *
 * - `raw`        — items the provider handed us, before any validation
 * - `normalized` — items that became a `SourceObservation`
 * - `invalid`    — items the envelope or item schema refused, or whose mapper threw
 * - `quarantined`— items the observation builder refused (no identity, unsafe link, no title...)
 *
 * INVARIANT: `raw === normalized + invalid + quarantined`. Enforced by `assertCountsBalanced`,
 * which is what lets `toStoredReportCounts` hand the collector a `received` it can complete into a
 * report the store's own "exactly one disposition per received item" refine will accept.
 */
export interface CollectionCounts {
  raw: number
  normalized: number
  invalid: number
  quarantined: number
}

export class CountsImbalanceError extends Error {
  constructor(readonly counts: CollectionCounts) {
    super(
      `counts do not balance: raw=${counts.raw} != normalized=${counts.normalized} + invalid=${counts.invalid} + quarantined=${counts.quarantined}`,
    )
    this.name = 'CountsImbalanceError'
  }
}

export function assertCountsBalanced(counts: CollectionCounts): void {
  if (counts.raw !== counts.normalized + counts.invalid + counts.quarantined) {
    throw new CountsImbalanceError(counts)
  }
}

/**
 * The projection onto the store's report counts — the ONLY place the two count vocabularies meet,
 * and production code rather than a test helper, so the conformance spec checks a mapping the
 * system actually uses instead of one the test invented.
 *
 * Both of our refusal buckets land in the store's single `invalid`: from the store's point of view
 * an item it never received a row for is invalid, and it has no column for the distinction between
 * "the schema refused it" and "the identity seam refused it". The remaining store buckets
 * (`created/revised/unchanged/duplicates/persistenceErrors`) are the collector's to fill from
 * `normalized`, which is why they are absent here rather than zero.
 */
export function toStoredReportCounts(counts: CollectionCounts): {
  received: number
  invalid: number
  normalized: number
} {
  assertCountsBalanced(counts)
  return {
    received: counts.raw,
    invalid: counts.invalid + counts.quarantined,
    normalized: counts.normalized,
  }
}

// ---------------------------------------------------------------------------
// Request reports
// ---------------------------------------------------------------------------

/** What one subrequest cost, in the store's own meter units. */
export interface MeterCost {
  unit: JobMeterUnit
  amount: number
}

/**
 * One subrequest, as reported. Carries attempt, status, timestamps, error and metered cost — and
 * NO credentials: `url` and `error.message` pass through `redactSecrets` in
 * `buildRequestReport`, which is the only way to make one. A report assembled as a bare object
 * literal by an adapter would bypass that, which is why phase 3 adapters never build one: the
 * collection loop does.
 */
export interface RequestReport {
  /** 1-based retry ordinal of THIS subrequest. A retried page reports twice, not once. */
  attempt: number
  /** 1-based page ordinal within the attempt. */
  page: number
  /** Credential-free request URL. */
  url: string
  /** HTTP status, or `null` when no response arrived (network failure, abort, deadline). */
  status: number | null
  startedAt: Date
  endedAt: Date
  error: { code: CollectionErrorCode; message: string } | null
  cost: MeterCost | null
}

/**
 * Replace every known secret with `REDACTED`, longest first.
 *
 * Longest-first matters: an API key and a prefix of it can both be registered (a key and its
 * account id share a prefix in several of phase 3's providers), and replacing the short one first
 * would leave the tail of the long one in the string. Empty and one-character secrets are ignored —
 * they would redact the whole URL and tell us nothing.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  const usable = [...new Set(secrets)]
    .filter((s) => s.length > 1)
    .sort((a, b) => b.length - a.length)
  for (const secret of usable) {
    out = out.split(secret).join(REDACTED)
  }
  return out
}

export function buildRequestReport(
  fields: Omit<RequestReport, 'url' | 'error'> & {
    url: string
    error: { code: CollectionErrorCode; message: string } | null
  },
  secrets: readonly string[],
): RequestReport {
  return {
    attempt: fields.attempt,
    page: fields.page,
    url: redactSecrets(fields.url, secrets),
    status: fields.status,
    startedAt: fields.startedAt,
    endedAt: fields.endedAt,
    error: fields.error
      ? {
          code: fields.error.code,
          message: redactSecrets(fields.error.message, secrets).slice(0, 500),
        }
      : null,
    cost: fields.cost,
  }
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

/**
 * A bounded trace of ONE refused item. Isolating a bad item (AC3) is only actionable if we can see
 * what it looked like, and only safe if what we keep is bounded and redacted — so a sample is
 * truncated to `MAX_SAMPLE_CHARS` and passes the same `redactSecrets` as a request URL.
 *
 * Not in the plan's interface sketch, which names counts but not samples while the prose requires
 * "bounded samples". A1 decision: it is a field of the batch, because the batch is the unit a
 * collection attempt reports and a sample belongs to the attempt, not to a page.
 */
export interface InvalidSample {
  page: number
  reason: string
  sample: string
}

export function buildInvalidSample(
  page: number,
  reason: string,
  raw: unknown,
  secrets: readonly string[],
): InvalidSample {
  let text: string
  try {
    text = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? String(raw))
  } catch {
    // Circular or otherwise unserializable: the sample is diagnostics, never a reason to fail.
    text = '[unserializable]'
  }
  return {
    page,
    reason: redactSecrets(reason, secrets).slice(0, MAX_SAMPLE_CHARS),
    sample: redactSecrets(text, secrets).slice(0, MAX_SAMPLE_CHARS),
  }
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/**
 * Where an attempt got to, and under WHICH versions it got there. The three version fields are
 * the whole point: a checkpoint belongs to the config, adapter and policy that produced it
 * (`jobCollectionAttemptSchema` makes the same statement about `configVersion`), and resuming a
 * cursor minted under a different config would silently skip whatever the config change added.
 */
export interface ValidatedCheckpoint {
  configVersion: number
  policyVersion: number
  adapterVersion: string
  /** Opaque provider cursor, or `null` for page-numbered pagination. */
  cursor: string | null
  /** The LAST COMPLETED page — the next attempt starts after it. */
  page: number
  completedAt: Date
}

export type CheckpointDecision =
  | { kind: 'FRESH' }
  | { kind: 'RESUME'; from: ValidatedCheckpoint }
  | { kind: 'RESTART_WITH_OVERLAP'; discarded: ValidatedCheckpoint; mismatch: CheckpointMismatch }

export type CheckpointMismatch = 'CONFIG_VERSION' | 'POLICY_VERSION' | 'ADAPTER_VERSION'

/**
 * Decide what a stored checkpoint is worth. A mismatch on ANY of the three versions discards the
 * cursor and restarts bounded discovery; the caller widens its window by the spec's overlap, so
 * the restart re-reads the boundary rather than trusting that nothing moved across it (AC4).
 *
 * Checked in declaration order so the reported mismatch is deterministic: a test that asserts
 * `'CONFIG_VERSION'` for a checkpoint whose config AND adapter both moved is asserting a fact, not
 * an object-key order.
 */
export function decideCheckpoint(
  stored: ValidatedCheckpoint | null,
  current: { configVersion: number; policyVersion: number; adapterVersion: string },
): CheckpointDecision {
  if (stored === null) return { kind: 'FRESH' }
  const mismatch: CheckpointMismatch | null =
    stored.configVersion !== current.configVersion
      ? 'CONFIG_VERSION'
      : stored.policyVersion !== current.policyVersion
        ? 'POLICY_VERSION'
        : stored.adapterVersion !== current.adapterVersion
          ? 'ADAPTER_VERSION'
          : null
  if (mismatch !== null) return { kind: 'RESTART_WITH_OVERLAP', discarded: stored, mismatch }
  return { kind: 'RESUME', from: stored }
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

export interface CollectionBatch {
  observations: SourceObservation[]
  outcome: CollectionOutcome
  coverage: CollectionCoverage
  scope: SourceCoverageScope
  requests: RequestReport[]
  counts: CollectionCounts
  checkpoint: ValidatedCheckpoint | null
  invalidSamples: InvalidSample[]
}

/** Why an attempt stopped. `EXHAUSTED` is the only one that can carry SUCCEEDED. */
export type StopReason =
  'EXHAUSTED' | 'PAGE_CAP' | 'CURSOR_CYCLE' | 'ERROR' | 'CANCELLED' | 'COST_STOP'

export interface DerivationFacts {
  stop: StopReason
  /** Pages whose observations AND checkpoint were durably persisted. */
  pagesCompleted: number
  counts: CollectionCounts
  scope: SourceCoverageScope
}

/**
 * The outcome, from what happened. `CANCELLED` wins over everything (an aborted run claims
 * nothing); an error with no completed page is `FAILED`; an error after at least one completed page
 * is `PARTIAL`, which is also what "one board failing" means for a multi-board attempt (AC1).
 *
 * A page cap or a cursor cycle is NOT a failure: we stopped on our own bound, having kept
 * everything we read. It reports `SUCCEEDED` and loses its claim on the COVERAGE axis instead,
 * which is the distinction `deriveCoverage` exists to carry.
 */
export function deriveOutcome(facts: DerivationFacts): CollectionOutcome {
  if (facts.stop === 'CANCELLED') return 'CANCELLED'
  if (facts.stop === 'ERROR' || facts.stop === 'COST_STOP') {
    return facts.pagesCompleted > 0 ? 'PARTIAL' : 'FAILED'
  }
  return 'SUCCEEDED'
}

/**
 * The coverage, from what happened. Read top to bottom — the first claim we cannot support wins:
 *
 * - a non-SUCCEEDED attempt has no coverage claim at all -> PARTIAL
 * - any item we could not observe means the inventory we report is demonstrably incomplete ->
 *   PARTIAL. (The store permits SUCCEEDED with `invalid > 0`, so the two axes disagree here on
 *   purpose: the attempt succeeded, the inventory is not full.)
 * - a cap or cycle on a SEARCH scope (`query !== null`) is a WINDOW: a search was never going to
 *   enumerate an inventory, and a bounded slice of it is exactly what WINDOW means (AC1)
 * - the same cap on a FULL-INVENTORY scope is PARTIAL: we were supposed to see everything
 * - a scope that asked for a time window gets WINDOW even when exhausted
 * - only an exhausted, clean, unwindowed, unqueried scope is FULL_INVENTORY
 */
export function deriveCoverage(facts: DerivationFacts): CollectionCoverage {
  const outcome = deriveOutcome(facts)
  if (outcome !== 'SUCCEEDED') return 'PARTIAL'
  if (facts.counts.invalid > 0 || facts.counts.quarantined > 0) return 'PARTIAL'
  const truncated = facts.stop === 'PAGE_CAP' || facts.stop === 'CURSOR_CYCLE'
  if (truncated) return facts.scope.query !== null ? 'WINDOW' : 'PARTIAL'
  if (facts.scope.window !== null || facts.scope.query !== null) return 'WINDOW'
  return 'FULL_INVENTORY'
}

export class BatchInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BatchInvariantError'
  }
}

/**
 * The invariant above all others, as a check rather than a convention: a failure never reports
 * SUCCEEDED and never reports FULL_INVENTORY.
 *
 * With `deriveOutcome` / `deriveCoverage` as the only producers this can never fire today — it is
 * the second line of defence for phase 3, where 25 adapters arrive and someone will eventually
 * assemble a batch by hand. It is tested DIRECTLY, against hand-made batches, because that is the
 * only way a guard against a future caller can have a failing test at all.
 */
export function assertBatchInvariant(
  batch: Pick<CollectionBatch, 'outcome' | 'coverage' | 'counts'>,
): void {
  if (batch.outcome !== 'SUCCEEDED' && batch.coverage === 'FULL_INVENTORY') {
    throw new BatchInvariantError(`a ${batch.outcome} attempt cannot claim FULL_INVENTORY coverage`)
  }
  assertCountsBalanced(batch.counts)
}

/** The ONLY producer of a `CollectionBatch`. Outcome and coverage are arguments to nothing. */
export function buildCollectionBatch(input: {
  observations: SourceObservation[]
  facts: DerivationFacts
  requests: RequestReport[]
  checkpoint: ValidatedCheckpoint | null
  invalidSamples: InvalidSample[]
}): CollectionBatch {
  const batch: CollectionBatch = {
    observations: input.observations,
    outcome: deriveOutcome(input.facts),
    coverage: deriveCoverage(input.facts),
    scope: input.facts.scope,
    requests: input.requests.slice(0, MAX_REQUEST_REPORTS),
    counts: input.facts.counts,
    checkpoint: input.checkpoint,
    invalidSamples: input.invalidSamples.slice(0, MAX_SAMPLES),
  }
  assertBatchInvariant(batch)
  return batch
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The runtime marker a validated config carries. A phantom type alone would be free but invisible:
 * `apps/api/tsconfig.json` EXCLUDES `**\/*.spec.ts`, so a `@ts-expect-error` pinning the brand
 * would never be compiled by `pnpm typecheck` and the brand would be unverifiable. A
 * non-enumerable symbol is checkable at runtime, by a test that can actually fail.
 *
 * Non-enumerable so it never reaches `JSON.stringify`, a log line, or a database row.
 */
const CONFIG_VALIDATED: unique symbol = Symbol('crm.jobSourcing.configValidated')

/**
 * The minimum every source config carries, whatever the adapter. `namespace` and `configVersion`
 * are the store's words for the same two facts (`jobSourceIdentitySchema.namespace`,
 * `jobCollectionAttemptSchema.configVersion`).
 */
export interface SourceConfigFields {
  namespace: string
  configVersion: number
  query?: string | null
  window?: CollectionWindow | null
}

/**
 * An adapter's own config type, branded. Exported so that `defineApiJsonProvider` can name the
 * type `parseConfig` returns WITHOUT a cast of its own: the brand symbol is module-private, so a
 * caller that had to spell the intersection itself would be forced to approximate it
 * (`{ [k: symbol]: true }`) and then cast across the gap — which is how a cast stops being a
 * formality and starts masking a mismatch.
 */
export type Validated<T extends SourceConfigFields> = T & {
  readonly [CONFIG_VALIDATED]: true
}

export type ValidatedSourceConfig = Validated<SourceConfigFields>

/**
 * Stamp a config that a schema has just accepted.
 *
 * THE CAST: `as Validated<T>`. It is not masking a contract, and the reason is the call site, not
 * good intentions — `markValidated` is applied to the RESULT of a `.parse()`, so every structural
 * field has already been checked by Zod and the cast adds only the phantom property that
 * `defineProperty` just installed on the line above. Contrast the cast this feature was burned by
 * in Task 2.1, which asserted a VALUE's shape that nothing had checked.
 */
export function markValidated<T extends SourceConfigFields>(config: T): Validated<T> {
  Object.defineProperty(config, CONFIG_VALIDATED, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return config as Validated<T>
}

export function isValidatedConfig(value: unknown): value is ValidatedSourceConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[CONFIG_VALIDATED] === true
  )
}

export class UnvalidatedConfigError extends Error {
  constructor() {
    super('collectReport was given a config that parseConfig never validated')
    this.name = 'UnvalidatedConfigError'
  }
}

export function assertValidatedConfig(value: unknown): asserts value is ValidatedSourceConfig {
  if (!isValidatedConfig(value)) throw new UnvalidatedConfigError()
}

// ---------------------------------------------------------------------------
// Context and provider
// ---------------------------------------------------------------------------

/** One response body, as the fetch seam delivers it. TEXT, not parsed JSON: byte bounds and
 * egress policy are Task 2.2's; JSON depth and item bounds are ours. */
export interface FetchedText {
  status: number
  bodyText: string
  /** Lowercased header names. `null` for a response that carried none. */
  headers: Readonly<Record<string, string>>
  /** Validator for conditional requests; `null` when the provider sent none. */
  etag: string | null
}

export interface FetchRequest {
  url: string
  method?: 'GET' | 'POST'
  body?: string
  headers?: Readonly<Record<string, string>>
}

export interface MeterReservation {
  id: string
  unit: JobMeterUnit
  amount: number
}

/** How a reservation resolved. The store's own statuses minus the two the caller cannot assert
 * (`RESERVED` is where it starts; `SENT` is the transport's claim, not the loop's). */
export type ReservationResolution = 'USED' | 'RELEASED' | 'UNCERTAIN'

/**
 * Everything the loop needs from the world, as ports. Nothing here is constructed by the loop:
 * accept dependencies, do not create them — which is also what lets the whole loop be tested
 * through its own interface with fakes, rather than from behind it.
 */
export interface CollectionContext {
  /** Run identity. The same four facts `jobCollectionAttemptSchema` stores. */
  run: {
    sourceId: string
    cycleId: string
    attemptId: string
    fencingEpoch: number
  }
  policyVersion: number
  signal: AbortSignal
  /** Hard stop. Checked before every subrequest, so a deadline cannot be overrun by one page. */
  deadline: Date
  now(): Date
  /** Values that must never appear in a report. Redaction happens before anything is reported. */
  secrets: readonly string[]
  fetchText(request: FetchRequest): Promise<FetchedText>
  meter: {
    /** RESERVED before any I/O (the store's own ordering). Returns `null` when the budget refuses,
     * which is a COST_STOP, not an error. */
    reserve(unit: JobMeterUnit, amount: number): Promise<MeterReservation | null>
    reconcile(reservation: MeterReservation, resolution: ReservationResolution): Promise<void>
  }
  checkpoints: {
    load(): Promise<ValidatedCheckpoint | null>
    /**
     * Persist one completed page's observations AND its checkpoint, together, before the loop may
     * continue. One call rather than two because "completed pages and checkpoints persisted before
     * continuing" (AC4) is an ATOMICITY claim: two ports could be called in either order, or one
     * without the other, and the loop would still look right.
     */
    savePage(page: {
      observations: SourceObservation[]
      checkpoint: ValidatedCheckpoint
    }): Promise<void>
  }
  /** Conditional-request cache. A 304 reuses the stored body rather than refetching it. */
  cache: {
    get(key: string): Promise<{ etag: string; bodyText: string } | null>
    put(key: string, value: { etag: string; bodyText: string }): Promise<void>
  }
}

export interface ReportingJobSourceProvider<
  TConfig extends ValidatedSourceConfig = ValidatedSourceConfig,
> {
  readonly type: import('@crm/shared').JobSourceType
  parseConfig(raw: unknown): TConfig
  collectReport(config: TConfig, ctx: CollectionContext): Promise<CollectionBatch>
}

/** Exported for the conformance spec: the store's regex is the authority on an error code's shape. */
export function parseErrorCodeThroughStore(code: string): string {
  return jobErrorCodeSchema.parse(code)
}
