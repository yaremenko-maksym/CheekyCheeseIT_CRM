import { createHash } from 'node:crypto'
import { type ZodType, z } from 'zod'
import {
  SourceBlockedError,
  SourceHttpStatusError,
  SourcePayloadTooLargeError,
  SourceRateLimitedError,
} from '../../http/source-errors'
import { checkStoredLink } from '../../normalize/url-policy'
import { isRunFenced } from '../../ownership/run-ownership'
import type { AiInputSignal, ModelInputPolicy } from '../../structuring/ai-input-gate'
import type {
  DiscoveredRecord,
  HtmlStructurer,
  StructurerOutcome,
} from '../../structuring/html-structurer.port'
import type { RobotsCheck } from '../../structuring/robots-policy'
import { collectPages, type DecodedEnvelope, type PageTarget } from '../api-json.provider'
import {
  assertValidatedConfig,
  buildCollectionBatch,
  buildRequestReport,
  type CollectionBatch,
  collectionCodeOf,
  type CollectionContext,
  type CollectionErrorCode,
  type FetchedText,
  type FetchRequest,
  type MeterReservation,
  markValidated,
  type ReportingJobSourceProvider,
  type ReservationResolution,
  type SourceConfigFields,
  type SourceCoverageScope,
  type Validated,
} from '../reporting-provider'
import {
  type EnrichmentRecord,
  type EnrichmentStatePort,
  type HostGatePort,
  type HtmlDetailFields,
  type HtmlDiscoveryStrategy,
  type HtmlListingPage,
  hostGapMs,
  type RobotsPort,
} from './html-ports'
import type { HtmlSourceType } from './html-source-types'

/**
 * The `HtmlProvider` base (r5 Task 5.5) for the seven `*_HTML` source types. Three stages:
 *
 *  A. DISCOVERY — listing pages only, through the shared page loop (`collectPages`), so checkpoint
 *     resume, metering, the page cap and cursor-cycle detection are the loop's and are not
 *     re-derived here (the decision `rss.provider.ts` records). Its result is the `CollectionBatch`.
 *  B. DETAIL — due detail pages of discovered, approved-host items, under robots, the host gap, the
 *     detail quota and the aggregate caps, with unchanged-content reuse from `EnrichmentStatePort`.
 *  C. MODEL — the optional `HtmlStructurer` (5.4b), only for fields B could not recover.
 *
 * B and C ENRICH; they never change the batch. A failed or exhausted enrichment is reported in its
 * own stage and leaves discovery as it was — nothing here closes a job.
 *
 * Page text is never logged and never placed in an error message: every refusal carries a fixed
 * code. Model-named URLs are never fetched and never carried out of Stage C.
 */

export interface HtmlLimits {
  /** Listing pages per attempt (the loop's `maxPages`). */
  maxPages: number
  /** Items one listing page may carry; more is drift (the loop's rule). */
  maxItemsPerPage: number
  maxListingBytes: number
  /** Detail fetches per attempt: the per-source quota. */
  maxDetails: number
  maxDetailBytes: number
  /** All response bytes of the attempt, listing and detail together. */
  maxTotalBytes: number
  /** A succeeded detail is due again after this long. */
  revisitAfterMs: number
  /** A failed detail is due again after this long. */
  retryAfterMs: number
}

export const DEFAULT_HTML_LIMITS: HtmlLimits = {
  maxPages: 5,
  maxItemsPerPage: 100,
  maxListingBytes: 2 * 1024 * 1024,
  maxDetails: 15,
  maxDetailBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  revisitAfterMs: 72 * 60 * 60 * 1000,
  retryAfterMs: 6 * 60 * 60 * 1000,
}

/** The fields Stage C may fill when Stage B left them empty. */
export const MODEL_FILLABLE_FIELDS = [
  'description',
  'location',
  'employmentType',
  'remote',
] as const

export type StageStatus = 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'POLICY_BLOCKED' | 'SKIPPED'

export interface HtmlDiscoveryReport {
  readonly method: 'HTML_LISTING'
  readonly status: StageStatus
  /** What the discovery covers: board, query, config version, window. */
  readonly scope: SourceCoverageScope
  readonly items: number
  /** Why discovery stopped short, or `null` when it read to the end. */
  readonly stop: CollectionErrorCode | null
  /** Every stop code the attempt recorded, counted. */
  readonly stops: Readonly<Partial<Record<CollectionErrorCode, number>>>
  readonly duplicatePages: number
  /** Posting links refused by `checkStoredLink` (the observation builder quarantines the item). */
  readonly rejectedLinks: number
  /** Items whose posting URL is off the approved hosts: kept as navigation, never detail-fetched. */
  readonly navigationOnly: number
  /** The robots reason when the whole source is policy-blocked. */
  readonly policyReason: string | null
}

export type DetailStop =
  | 'DETAIL_QUOTA'
  | 'BYTE_BUDGET'
  | 'COST_STOP'
  | 'DEADLINE'
  | 'CANCELLED'
  | 'METER_FAILED'
  | CollectionErrorCode

export interface HtmlDetailReport {
  readonly method: 'HTML_DETAIL'
  readonly status: StageStatus
  readonly fetched: number
  readonly unchanged: number
  readonly notDue: number
  readonly failed: number
  readonly policyDenied: number
  readonly navigationOnly: number
  readonly stop: DetailStop | null
  /** The items still due when the stage stopped early; the next attempt resumes from them. */
  readonly checkpoint: {
    readonly reason: DetailStop
    readonly remainingIds: readonly string[]
  } | null
}

export interface HtmlModelReport {
  readonly method: 'MODEL'
  readonly status: StageStatus
  /** The structurer's outcome kind (or `NOT_CONFIGURED` / `PORT_THREW`), never model text. */
  readonly reason: string | null
  readonly requested: number
  readonly applied: number
  /** Records naming an id discovery never produced: dropped. */
  readonly falseIdentity: number
  readonly remainingIds: readonly string[]
}

export type FieldMethod = 'DETAIL_HTML' | 'MODEL'

export interface HtmlEnrichment {
  readonly id: string
  readonly fields: HtmlDetailFields
  readonly methods: Readonly<Partial<Record<keyof HtmlDetailFields, FieldMethod>>>
  /** Model quotes for the fields the model filled. */
  readonly evidence: readonly { readonly field: string; readonly quote: string }[]
}

export interface HtmlCollectionResult {
  readonly batch: CollectionBatch
  readonly discovery: HtmlDiscoveryReport
  readonly detail: HtmlDetailReport
  readonly model: HtmlModelReport
  readonly enrichments: readonly HtmlEnrichment[]
  /** Every subrequest this provider sent (listing and detail), and their response bytes. */
  readonly usage: { readonly requests: number; readonly bytes: number }
}

export interface HtmlProviderDeps {
  readonly robots: RobotsPort
  readonly hostGate: HostGatePort
  readonly enrichment: EnrichmentStatePort
  readonly strategy: HtmlDiscoveryStrategy
  /** Optional: absent, Stage C is skipped and A/B complete on their own. */
  readonly model?: { readonly structurer: HtmlStructurer; readonly policy: ModelInputPolicy }
  readonly limits?: Partial<HtmlLimits>
}

const MAX_ID_CHARS = 256
const MAX_RAW_LINK_CHARS = 4_096
const optionalText = z.string().max(20_000).nullable().optional()

/**
 * One listing item. The id is trimmed and NFC-normalised HERE, the same normalisation identity
 * applies, so the id discovery recorded is the `nativeId` the observation carries.
 */
const listingItemSchema = z.object({
  id: z
    .string()
    .transform((s) => s.trim().normalize('NFC'))
    .pipe(z.string().min(1).max(MAX_ID_CHARS)),
  postingUrl: z.string().min(1).max(MAX_RAW_LINK_CHARS),
  applicationUrl: z.string().max(MAX_RAW_LINK_CHARS).nullable().optional(),
  title: optionalText,
  companyName: optionalText,
  location: optionalText,
})

type ListingItem = z.infer<typeof listingItemSchema>

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const strictestAiInput = (signals: readonly AiInputSignal[]): AiInputSignal =>
  signals.includes('no') ? 'no' : signals.includes('unspecified') ? 'unspecified' : 'yes'

/** A Stage B result that left a fillable field empty: what Stage C needs to fill it. */
interface ModelCandidate {
  readonly url: string
  /** The detail page text, passed to the structurer and nowhere else. */
  readonly text: string
  readonly aiInput: AiInputSignal
  readonly enrichment: HtmlEnrichment
  /** The enrichment-state key and the record Stage B wrote, for settling `modelPending`. */
  readonly key: string
  readonly record: EnrichmentRecord
}

/** What `admit` lets through: the checked URL and the robots answer it was admitted under. */
interface Admitted {
  readonly url: URL
  readonly robots: RobotsCheck
}

type Admission = Admitted | { readonly refused: 'POLICY' | 'BYTE_BUDGET'; readonly reason: string }

/** Detail stops after which the model stage does not run: the run is out of time or permission. */
const RUN_ENDING_STOPS: ReadonlySet<DetailStop | null> = new Set([
  'CANCELLED',
  'DEADLINE',
  'METER_FAILED',
])

/** One discovered item as Stage B sees it. `detailUrl` is null for a navigation-only item. */
interface DiscoveredItem {
  readonly id: string
  readonly detailUrl: string | null
}

/** Per-attempt mutable state shared by the three stages. */
interface Attempt {
  readonly ctx: CollectionContext
  readonly approved: ReadonlySet<string>
  requests: number
  bytes: number
}

export abstract class HtmlProvider<
  TConfig extends SourceConfigFields,
> implements ReportingJobSourceProvider<Validated<TConfig>> {
  abstract readonly type: HtmlSourceType
  /** Stamped on observations and checkpoints by the page loop. */
  abstract readonly adapterVersion: string
  /** Bumped when `parseDetail` changes: every cached detail is then refetched and reparsed. */
  abstract readonly parserVersion: string
  protected abstract readonly configSchema: ZodType<TConfig>
  /** The site the listing lives on; relative links resolve against it. */
  protected abstract baseUrl(config: TConfig): string
  /** Hosts whose pages may be fetched as detail — the base host and tenant hosts from VERIFIED config. */
  protected abstract approvedHosts(config: TConfig): readonly string[]
  /** One listing page. Built from `at`; a cursor is a parameter, never the URL. */
  protected abstract listingRequest(config: TConfig, at: PageTarget): FetchRequest

  protected readonly limits: HtmlLimits

  constructor(protected readonly deps: HtmlProviderDeps) {
    this.limits = { ...DEFAULT_HTML_LIMITS, ...deps.limits }
  }

  parseConfig(raw: unknown): Validated<TConfig> {
    return markValidated(this.configSchema.parse(raw))
  }

  async collectReport(
    config: Validated<TConfig>,
    ctx: CollectionContext,
  ): Promise<CollectionBatch> {
    return (await this.collectHtml(config, ctx)).batch
  }

  async collectHtml(
    config: Validated<TConfig>,
    ctx: CollectionContext,
  ): Promise<HtmlCollectionResult> {
    assertValidatedConfig(config)
    const base = this.validatedBase(config)
    const attempt: Attempt = {
      ctx,
      approved: new Set(this.approvedHosts(config).map((h) => h.toLowerCase())),
      requests: 0,
      bytes: 0,
    }
    if (!attempt.approved.has(base.hostname)) {
      throw new Error('html provider: the base host is not among the approved hosts')
    }
    const scope = this.scopeOf(config)

    // ALL-ROBOTS-DENIED: the first listing page is refused, so nothing at all is fetched.
    const first = this.listingRequest(config, { page: 1, cursor: null, window: scope.window })
    const preflight = await this.admit(attempt, first.url)
    if ('refused' in preflight) return this.policyBlocked(scope, first.url, preflight.reason, ctx)

    const discovered = new Map<string | null, DiscoveredItem>()
    const linkStats = { rejected: 0, navigationOnly: 0 }
    const seenPages = new Set<string>()
    let duplicatePages = 0

    const listingCtx: CollectionContext = {
      ...ctx,
      fetchText: (request) => this.transmit(attempt, request),
    }
    const batch = await collectPages(
      {
        type: this.type,
        adapterVersion: this.adapterVersion,
        itemSchema: listingItemSchema,
        limits: { maxPages: this.limits.maxPages, maxItemsPerPage: this.limits.maxItemsPerPage },
        requestMaxBytes: this.limits.maxListingBytes,
        meter: { unit: 'REQUEST', amountPerRequest: 1 },
        decodeEnvelope: (bodyText): DecodedEnvelope<HtmlListingPage> => {
          const decoded = this.decodeListing(bodyText)
          if (!decoded.ok) return decoded
          // A page whose item ids repeat an earlier page is a loop the cursor check cannot see.
          // Only string ids identify an item: a page of id-less items repeats nothing.
          const ids = decoded.value.items
            .map((item) => (item as { id?: unknown } | null)?.id)
            .filter((id) => typeof id === 'string')
          const key = JSON.stringify(ids)
          if (ids.length > 0 && seenPages.has(key)) {
            duplicatePages += 1
            return {
              ok: false,
              code: 'CURSOR_CYCLE',
              message: 'listing page repeats an earlier page',
            }
          }
          seenPages.add(key)
          return decoded
        },
        pageRequest: (cfg, at) => ({ request: this.listingRequest(cfg, at) }),
        beforeSend: (request) => this.admitListing(attempt, request),
        extractItems: (page) => page.items,
        nextCursor: (page) => page.nextCursor,
        nativeIdOf: (item) => item.id,
        mapItem: (item, cfg) => {
          const mapped = this.mapListingItem(item, base, attempt.approved, linkStats)
          discovered.set(item.id, mapped.discovered)
          return { ...mapped.fields, namespace: cfg.namespace }
        },
        scopeOf: () => scope,
      },
      config,
      listingCtx,
    )

    // Only what the batch KEPT is enriched: an item of a page that never landed was not discovered.
    // An item identity keyed on its URL (`nativeId` null: the id was refused) has no stable key
    // for enrichment state, so it stays discovery-only.
    const kept: DiscoveredItem[] = []
    for (const observation of batch.observations) {
      const found = discovered.get(observation.identity.nativeId)
      if (found !== undefined) kept.push(found)
    }

    const discovery = this.discoveryReport(batch, scope, {
      duplicatePages,
      rejectedLinks: linkStats.rejected,
      navigationOnly: linkStats.navigationOnly,
    })
    const stageB = await this.runDetailStage(config, attempt, kept)
    const detailStop = stageB.report.stop
    const stageC = RUN_ENDING_STOPS.has(detailStop)
      ? { report: { ...EMPTY_MODEL, status: 'SKIPPED' as const, reason: detailStop } }
      : await this.runModelStage(stageB.enrichments, stageB.modelCandidates, ctx)
    if ('reached' in stageC) await this.settleModelPending(stageB.modelCandidates, stageC.reached)

    return {
      batch,
      discovery,
      detail: stageB.report,
      model: stageC.report,
      enrichments: [...stageB.enrichments.values()],
      usage: { requests: attempt.requests, bytes: attempt.bytes },
    }
  }

  /** What an attempt covers: the configured board, query and window, at its config version. */
  protected scopeOf(config: TConfig): SourceCoverageScope {
    return {
      namespace: config.namespace,
      query: config.query ?? null,
      configVersion: config.configVersion,
      window: config.window ?? null,
    }
  }

  private validatedBase(config: TConfig): URL {
    const checked = checkStoredLink(this.baseUrl(config))
    if (!checked.ok) throw new Error(`html provider: base URL refused (${checked.reason})`)
    return checked.url
  }

  /*
   * THE EGRESS, in three steps every request of this provider takes, listing and detail alike:
   *   admit    — link policy, approved host, robots, aggregate byte budget (no I/O but robots)
   *   pace     — the host gap, abortable
   *   transmit — the context's own fetch, redirects NOT followed, capped at the bytes left
   * The metering (reserve -> markSent) sits between `pace` and `transmit`: the page loop does it
   * for listings (`beforeSend` runs admit + pace before it reserves), `fetchDetail` for details.
   * So nothing refused is ever reserved, and nothing is marked sent while it still waits.
   */

  /** Never throws: a robots port that fails is a refusal. */
  private async admit(attempt: Attempt, raw: string): Promise<Admission> {
    const checked = checkStoredLink(raw)
    if (!checked.ok) return { refused: 'POLICY', reason: checked.reason }
    if (!attempt.approved.has(checked.url.hostname)) {
      return { refused: 'POLICY', reason: 'HOST_NOT_APPROVED' }
    }
    let robots: RobotsCheck
    try {
      robots = await this.deps.robots.check(checked.url.href)
    } catch {
      return { refused: 'POLICY', reason: 'ROBOTS_FAILED' }
    }
    if (robots.verdict !== 'ALLOWED') {
      return { refused: 'POLICY', reason: robots.reason ?? robots.verdict }
    }
    if (attempt.bytes >= this.limits.maxTotalBytes) {
      return { refused: 'BYTE_BUDGET', reason: 'BYTE_BUDGET' }
    }
    return { url: checked.url, robots }
  }

  private pace(attempt: Attempt, admitted: Admitted): Promise<void> {
    return this.deps.hostGate.acquire(
      admitted.url.origin,
      hostGapMs(admitted.robots.crawlDelaySeconds),
      attempt.ctx.signal,
    )
  }

  private async transmit(attempt: Attempt, request: FetchRequest): Promise<FetchedText> {
    const remaining = this.limits.maxTotalBytes - attempt.bytes
    attempt.requests += 1
    const response = await attempt.ctx.fetchText({
      ...request,
      // A redirect comes back as its 3xx: its target was never admitted.
      followRedirects: false,
      maxBytes: Math.min(request.maxBytes ?? remaining, remaining),
    })
    attempt.bytes += Buffer.byteLength(response.bodyText)
    return response
  }

  /** `beforeSend` for the page loop: a refusal here ends discovery with nothing reserved. */
  private async admitListing(
    attempt: Attempt,
    request: FetchRequest,
  ): Promise<{ code: CollectionErrorCode; message: string } | null> {
    const admitted = await this.admit(attempt, request.url)
    if ('refused' in admitted) {
      return {
        code: admitted.refused === 'POLICY' ? 'ACCESS_POLICY' : 'COST_STOP',
        message: `html request refused: ${admitted.reason}`,
      }
    }
    try {
      await this.pace(attempt, admitted)
    } catch {
      return { code: 'CANCELLED', message: 'html request refused: CANCELLED' }
    }
    return null
  }

  /** A run-ending error: it propagates (detail-tail contract) instead of failing one item. */
  private endsRun(error: unknown, ctx: CollectionContext): boolean {
    return (
      ctx.signal.aborted ||
      isRunFenced(error) ||
      error instanceof SourceBlockedError ||
      error instanceof SourceRateLimitedError
    )
  }

  private decodeListing(bodyText: string): DecodedEnvelope<HtmlListingPage> {
    if (Buffer.byteLength(bodyText) > this.limits.maxListingBytes) {
      return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'listing page over the byte cap' }
    }
    let page: HtmlListingPage | null
    try {
      page = this.deps.strategy.parseListing(bodyText)
    } catch {
      page = null
    }
    if (page === null) return { ok: false, code: 'PARSE_DRIFT', message: 'not a listing page' }
    return { ok: true, value: page }
  }

  /**
   * Resolve the posting and application links against the validated base. A refused posting link
   * is passed on unresolved so the observation builder quarantines the item under its real reason;
   * a posting off the approved hosts is kept as navigation and never becomes a detail target.
   */
  private mapListingItem(
    item: ListingItem,
    base: URL,
    approved: ReadonlySet<string>,
    stats: { rejected: number; navigationOnly: number },
  ) {
    const posting = resolveLink(item.postingUrl, base)
    let detailUrl: string | null = null
    if (posting === null) {
      stats.rejected += 1
    } else if (approved.has(posting.hostname)) {
      detailUrl = posting.href
    } else {
      stats.navigationOnly += 1
    }
    // Never fetched: an application URL is navigation by definition.
    const application = item.applicationUrl ? resolveLink(item.applicationUrl, base) : null
    return {
      discovered: { id: item.id, detailUrl },
      fields: {
        nativeId: item.id,
        url: posting?.href ?? item.postingUrl,
        applicationUrl: application?.href ?? null,
        title: item.title ?? null,
        companyName: item.companyName ?? null,
        location: item.location ?? null,
      },
    }
  }

  private discoveryReport(
    batch: CollectionBatch,
    scope: SourceCoverageScope,
    extra: { duplicatePages: number; rejectedLinks: number; navigationOnly: number },
  ): HtmlDiscoveryReport {
    const stops: Partial<Record<CollectionErrorCode, number>> = {}
    let stop: CollectionErrorCode | null = null
    for (const request of batch.requests) {
      if (request.error === null) continue
      stops[request.error.code] = (stops[request.error.code] ?? 0) + 1
      stop = request.error.code
    }
    const failed = batch.outcome === 'FAILED' || batch.outcome === 'CANCELLED'
    const partial = stop !== null || batch.coverage === 'PARTIAL'
    return {
      method: 'HTML_LISTING',
      status: failed ? 'FAILED' : partial ? 'PARTIAL' : 'COMPLETE',
      scope,
      items: batch.observations.length,
      stop,
      stops,
      duplicatePages: extra.duplicatePages,
      rejectedLinks: extra.rejectedLinks,
      navigationOnly: extra.navigationOnly,
      policyReason: null,
    }
  }

  private policyBlocked(
    scope: SourceCoverageScope,
    url: string,
    reason: string,
    ctx: CollectionContext,
  ): HtmlCollectionResult {
    const at = ctx.now()
    const batch = buildCollectionBatch({
      observations: [],
      facts: {
        stop: 'ERROR',
        pagesCompleted: 0,
        counts: { raw: 0, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 },
        scope,
        // Stryker disable next-line BooleanLiteral: equivalent — stop ERROR with zero pages derives outcome FAILED, and deriveCoverage returns PARTIAL for every non-SUCCEEDED outcome before it reads resumed, so true and false build the same batch.
        resumed: false,
      },
      requests: [
        buildRequestReport(
          {
            attempt: 1,
            page: 1,
            url,
            status: null,
            startedAt: at,
            endedAt: at,
            error: { code: 'ACCESS_POLICY', message: `robots: ${reason}` },
            cost: null,
          },
          ctx.secrets,
        ),
      ],
      checkpoint: null,
      invalidSamples: [],
    })
    return {
      batch,
      discovery: {
        method: 'HTML_LISTING',
        status: 'POLICY_BLOCKED',
        scope,
        items: 0,
        stop: 'ACCESS_POLICY',
        stops: { ACCESS_POLICY: 1 },
        duplicatePages: 0,
        rejectedLinks: 0,
        navigationOnly: 0,
        policyReason: reason,
      },
      detail: { ...EMPTY_DETAIL, status: 'SKIPPED' },
      model: { ...EMPTY_MODEL, status: 'SKIPPED', reason: 'POLICY_BLOCKED' },
      enrichments: [],
      usage: { requests: 0, bytes: 0 },
    }
  }

  private enrichmentKey(config: TConfig, id: string): string {
    return JSON.stringify([this.type, config.namespace, id])
  }

  // -------------------------------------------------------------------------
  // Stage B
  // -------------------------------------------------------------------------

  private async runDetailStage(
    config: TConfig,
    attempt: Attempt,
    items: readonly DiscoveredItem[],
  ): Promise<{
    report: HtmlDetailReport
    enrichments: Map<string, HtmlEnrichment>
    modelCandidates: Map<string, ModelCandidate>
  }> {
    const { ctx } = attempt
    const enrichments = new Map<string, HtmlEnrichment>()
    const modelCandidates = new Map<string, ModelCandidate>()
    const counts = {
      fetched: 0,
      unchanged: 0,
      notDue: 0,
      failed: 0,
      policyDenied: 0,
      navigationOnly: 0,
    }
    const remainingIds: string[] = []
    let stop: DetailStop | null = null
    let sent = 0
    /** Did robots allow any detail at all? None allowed (and some denied) is a policy block. */
    let admitted = false

    for (const item of items) {
      const detailUrl = item.detailUrl
      if (detailUrl === null) {
        counts.navigationOnly += 1
        continue
      }
      const key = this.enrichmentKey(config, item.id)
      // One item's state port, robots port or malformed record fails that item, never the batch.
      try {
        const previous = await this.deps.enrichment.get(key)
        const now = ctx.now()
        // A record speaks only for this parser, this policy and this URL.
        const current =
          previous !== null &&
          previous.parserVersion === this.parserVersion &&
          previous.policyVersion === ctx.policyVersion &&
          previous.url === detailUrl
            ? previous
            : null
        if (current !== null && current.nextDueAt.getTime() > now.getTime()) {
          counts.notDue += 1
          continue
        }
        stop ??= this.detailStopBefore(attempt, sent, now)
        if (stop !== null) {
          remainingIds.push(item.id)
          continue
        }

        const admission = await this.admit(attempt, detailUrl)
        if ('refused' in admission) {
          if (admission.refused === 'BYTE_BUDGET') {
            stop = 'BYTE_BUDGET'
            remainingIds.push(item.id)
          } else {
            counts.policyDenied += 1
          }
          continue
        }
        admitted = true
        try {
          await this.pace(attempt, admission)
        } catch {
          stop = 'CANCELLED'
          remainingIds.push(item.id)
          continue
        }

        const result = await this.fetchDetail(attempt, admission.url.href)
        if ('stop' in result) {
          stop = result.stop
          remainingIds.push(item.id)
          continue
        }
        // Counted against the quota whether the host answered well or badly: it was a request.
        sent += 1
        const base = {
          attempts: (previous?.attempts ?? 0) + 1,
          lastAttemptAt: now,
          url: detailUrl,
          parserVersion: this.parserVersion,
          policyVersion: ctx.policyVersion,
        }
        // A failure is written under the CURRENT versions, so its retry window applies, and with
        // no hash: a body that failed is never the reference an unchanged body is reused against.
        const failure = (error: string): EnrichmentRecord => ({
          ...base,
          succeededAt: previous?.succeededAt ?? null,
          error,
          nextDueAt: new Date(now.getTime() + this.limits.retryAfterMs),
          contentHash: null,
          validator: null,
          modelPending: false,
        })
        if ('failure' in result) {
          await this.deps.enrichment.put(key, failure(result.failure))
          counts.failed += 1
          continue
        }

        const { response } = result
        const hash = sha256(response.bodyText)
        const validator = strongValidator(response.etag)
        const unchanged =
          current !== null &&
          current.error === null &&
          !current.modelPending &&
          ((validator !== null && validator === current.validator) || hash === current.contentHash)
        const succeeded = (modelPending: boolean): EnrichmentRecord => ({
          ...base,
          succeededAt: now,
          error: null,
          // An item the model still owes a pass is due again at the retry pace, not the revisit.
          nextDueAt: new Date(
            now.getTime() + (modelPending ? this.limits.retryAfterMs : this.limits.revisitAfterMs),
          ),
          contentHash: hash,
          validator,
          modelPending,
        })
        if (unchanged) {
          await this.deps.enrichment.put(key, succeeded(false))
          counts.unchanged += 1
          continue
        }

        let fields: HtmlDetailFields
        try {
          fields = definedOnly(this.deps.strategy.parseDetail(response.bodyText))
        } catch {
          await this.deps.enrichment.put(key, failure('PARSE_DRIFT'))
          counts.failed += 1
          continue
        }
        const needsModel = MODEL_FILLABLE_FIELDS.some((f) => fields[f] === undefined)
        const record = succeeded(needsModel && this.deps.model !== undefined)
        await this.deps.enrichment.put(key, record)
        counts.fetched += 1
        const methods: Partial<Record<keyof HtmlDetailFields, FieldMethod>> = {}
        for (const field of Object.keys(fields) as (keyof HtmlDetailFields)[]) {
          methods[field] = 'DETAIL_HTML'
        }
        const enrichment: HtmlEnrichment = { id: item.id, fields, methods, evidence: [] }
        enrichments.set(item.id, enrichment)
        if (needsModel) {
          modelCandidates.set(item.id, {
            url: detailUrl,
            text: response.bodyText,
            aiInput: admission.robots.aiInput,
            enrichment,
            key,
            record,
          })
        }
      } catch (error) {
        if (this.endsRun(error, ctx)) throw error
        counts.failed += 1
      }
    }

    const status: StageStatus =
      items.length === 0
        ? 'SKIPPED'
        : stop !== null
          ? 'PARTIAL'
          : counts.policyDenied > 0 && !admitted
            ? 'POLICY_BLOCKED'
            : counts.failed > 0 || counts.policyDenied > 0
              ? 'PARTIAL'
              : 'COMPLETE'
    return {
      report: {
        method: 'HTML_DETAIL',
        status,
        ...counts,
        stop,
        checkpoint: stop === null ? null : { reason: stop, remainingIds },
      },
      enrichments,
      modelCandidates,
    }
  }

  /** The bounds checked before a detail is even admitted. The byte budget is `admit`'s. */
  private detailStopBefore(attempt: Attempt, sent: number, now: Date): DetailStop | null {
    if (attempt.ctx.signal.aborted) return 'CANCELLED'
    if (now.getTime() >= attempt.ctx.deadline.getTime()) return 'DEADLINE'
    if (sent >= this.limits.maxDetails) return 'DETAIL_QUOTA'
    return null
  }

  /**
   * One metered detail request, already admitted and paced: reserve -> mark sent -> transmit ->
   * reconcile, the store's ordering, so UNCERTAIN covers only the send itself. A refusal of the
   * context or of the meter STOPS the stage; a fence, a ban or a cancel ENDS the run (rethrown);
   * a bad answer from the host — status, size, a transport blink — fails only this item.
   *
   * No conditional request: the context asks its conditional question only on the run's first
   * request, so a detail 304 is a failure like any other unexpected status.
   */
  private async fetchDetail(
    attempt: Attempt,
    url: string,
  ): Promise<{ response: FetchedText } | { failure: string } | { stop: DetailStop }> {
    const { ctx } = attempt
    let reservation: MeterReservation | null
    try {
      reservation = await ctx.meter.reserve('REQUEST', 1)
    } catch {
      return { stop: 'METER_FAILED' }
    }
    if (reservation === null) return { stop: 'COST_STOP' }

    let resolution: ReservationResolution = 'RELEASED'
    try {
      try {
        await ctx.meter.markSent(reservation)
      } catch (error) {
        if (isRunFenced(error)) throw error
        return { stop: 'METER_FAILED' }
      }
      resolution = 'UNCERTAIN'
      let response: FetchedText
      try {
        response = await this.transmit(attempt, { url, maxBytes: this.limits.maxDetailBytes })
      } catch (error) {
        if (this.endsRun(error, ctx)) throw error
        // The host answered: the request was used, the item failed.
        if (error instanceof SourceHttpStatusError) {
          resolution = 'USED'
          return { failure: `HTTP_${error.status}` }
        }
        if (error instanceof SourcePayloadTooLargeError) {
          resolution = 'USED'
          return { failure: 'PAYLOAD_TOO_LARGE' }
        }
        const code = collectionCodeOf(error)
        return code === null ? { failure: 'TRANSIENT_NETWORK' } : { stop: code }
      }
      resolution = 'USED'
      // A 3xx is here too: the redirect was not followed, its target never admitted.
      if (response.status < 200 || response.status > 299) {
        return { failure: `HTTP_${response.status}` }
      }
      if (Buffer.byteLength(response.bodyText) > this.limits.maxDetailBytes) {
        return { failure: 'PAYLOAD_TOO_LARGE' }
      }
      return { response }
    } finally {
      try {
        await ctx.meter.reconcile(reservation, resolution)
      } catch {
        // The reservation stays unresolved; the run's end-of-run settlement owns it.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage C
  // -------------------------------------------------------------------------

  private async runModelStage(
    enrichments: Map<string, HtmlEnrichment>,
    candidates: Map<string, ModelCandidate>,
    ctx: CollectionContext,
  ): Promise<{ report: HtmlModelReport; reached: ReadonlySet<string> }> {
    const model = this.deps.model
    const none = new Set<string>()
    if (model === undefined) {
      return {
        report: { ...EMPTY_MODEL, status: 'SKIPPED', reason: 'NOT_CONFIGURED' },
        reached: none,
      }
    }
    if (candidates.size === 0) {
      return {
        report: { ...EMPTY_MODEL, status: 'SKIPPED', reason: 'NOTHING_TO_FILL' },
        reached: none,
      }
    }
    const records: DiscoveredRecord[] = [...candidates].map(([id, c]) => ({
      id,
      url: c.url,
      text: c.text,
    }))
    let outcome: StructurerOutcome
    try {
      outcome = await model.structurer.structure({
        aiInput: strictestAiInput([...candidates.values()].map((c) => c.aiInput)),
        policy: model.policy,
        records,
        extractionVersion: this.parserVersion,
        signal: ctx.signal,
      })
    } catch {
      return {
        report: {
          ...EMPTY_MODEL,
          status: 'FAILED',
          reason: 'PORT_THREW',
          requested: records.length,
        },
        reached: none,
      }
    }

    // Reached: every record the structurer did not hand back as remaining. A skip by the AI-input
    // gate is a decision, so it reaches all; budget, outage and a partial pass leave the rest owed.
    const remainingIds = 'remainingIds' in outcome ? outcome.remainingIds : []
    const reached = new Set([...candidates.keys()].filter((id) => !remainingIds.includes(id)))
    if (outcome.kind !== 'EXTRACTED' && outcome.kind !== 'PARTIAL') {
      return {
        report: {
          ...EMPTY_MODEL,
          status: outcome.kind.startsWith('SKIPPED') ? 'SKIPPED' : 'FAILED',
          reason: outcome.kind,
          requested: records.length,
          remainingIds,
        },
        reached,
      }
    }

    let applied = 0
    let falseIdentity = 0
    const done = new Set<string>()
    for (const record of outcome.records) {
      // FALSE IDENTITY: the model named a record discovery never sent it. Dropped, never fetched.
      const candidate = candidates.get(record.sourceId)
      if (candidate === undefined) {
        falseIdentity += 1
        continue
      }
      if (done.has(record.sourceId)) continue
      done.add(record.sourceId)
      const fields = { ...candidate.enrichment.fields }
      const methods = { ...candidate.enrichment.methods }
      const filled: string[] = []
      const fill = <K extends (typeof MODEL_FILLABLE_FIELDS)[number]>(
        field: K,
        value: HtmlDetailFields[K] | null,
      ) => {
        // Deterministic values win: the model only fills what Stage B left empty.
        if (fields[field] !== undefined || value === null) return
        fields[field] = value
        methods[field] = 'MODEL'
        filled.push(field)
      }
      fill('description', record.description)
      fill('location', record.location)
      fill('employmentType', record.employmentType)
      fill('remote', record.remote)
      if (filled.length === 0) continue
      applied += 1
      enrichments.set(record.sourceId, {
        id: record.sourceId,
        fields,
        methods,
        evidence: record.evidence.filter((e) => filled.includes(e.field)),
      })
    }
    return {
      report: {
        method: 'MODEL',
        status: outcome.kind === 'PARTIAL' ? 'PARTIAL' : 'COMPLETE',
        reason: outcome.kind === 'PARTIAL' ? outcome.stoppedBy.kind : null,
        requested: records.length,
        applied,
        falseIdentity,
        remainingIds,
      },
      reached,
    }
  }

  /** The items the model stage reached no longer owe it a pass: due again at the revisit pace. */
  private async settleModelPending(
    candidates: Map<string, ModelCandidate>,
    reached: ReadonlySet<string>,
  ): Promise<void> {
    for (const [id, { key, record }] of candidates) {
      if (!record.modelPending || !reached.has(id)) continue
      try {
        await this.deps.enrichment.put(key, {
          ...record,
          modelPending: false,
          nextDueAt: new Date(record.lastAttemptAt.getTime() + this.limits.revisitAfterMs),
        })
      } catch {
        // Left pending: the item is offered to the model again, which costs a pass, loses nothing.
      }
    }
  }
}

const EMPTY_DETAIL: Omit<HtmlDetailReport, 'status'> = {
  method: 'HTML_DETAIL',
  fetched: 0,
  unchanged: 0,
  notDue: 0,
  failed: 0,
  policyDenied: 0,
  navigationOnly: 0,
  stop: null,
  checkpoint: null,
}

const EMPTY_MODEL: Omit<HtmlModelReport, 'status' | 'reason'> = {
  method: 'MODEL',
  requested: 0,
  applied: 0,
  falseIdentity: 0,
  remainingIds: [],
}

/** A link from page text, resolved against the validated base and held to `checkStoredLink`. */
function resolveLink(raw: string, base: URL): URL | null {
  // No trim: the URL parser already strips leading/trailing C0 and space. An unparseable link
  // reaches `checkStoredLink` as null, which refuses it as UNPARSEABLE.
  const checked = checkStoredLink(URL.canParse(raw, base.href) ? new URL(raw, base).href : null)
  return checked.ok ? checked.url : null
}

/** A strong ETag, or null: a weak one (`W/...`) does not promise identical bytes. */
function strongValidator(etag: string | null): string | null {
  return etag === null || etag.startsWith('W/') ? null : etag
}

/** Drop `undefined` and `null` values, so "absent" has one spelling. */
function definedOnly(fields: HtmlDetailFields): HtmlDetailFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null),
  ) as HtmlDetailFields
}
