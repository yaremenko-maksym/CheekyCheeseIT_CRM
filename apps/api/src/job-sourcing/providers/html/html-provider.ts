import { createHash } from 'node:crypto'
import { type ZodType, z } from 'zod'
import { checkStoredLink } from '../../normalize/url-policy'
import type { AiInputSignal, ModelInputPolicy } from '../../structuring/ai-input-gate'
import type {
  DiscoveredRecord,
  HtmlStructurer,
  StructurerOutcome,
} from '../../structuring/html-structurer.port'
import { collectPages, type DecodedEnvelope, type PageTarget } from '../api-json.provider'
import {
  assertValidatedConfig,
  buildCollectionBatch,
  buildRequestReport,
  type CollectionBatch,
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

/** A refusal raised before a request leaves, carrying a collection code the page loop reads. */
export class HtmlRequestRefused extends Error {
  constructor(
    readonly code: CollectionErrorCode,
    reason: string,
  ) {
    super(`html request refused: ${reason}`)
    this.name = 'HtmlRequestRefused'
  }
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
    const preflight = await this.deps.robots.check(first.url)
    if (preflight.verdict !== 'ALLOWED') {
      return this.policyBlocked(scope, first.url, preflight.reason ?? preflight.verdict, ctx)
    }

    const discovered = new Map<string, DiscoveredItem>()
    const linkStats = { rejected: 0, navigationOnly: 0 }
    const seenPages = new Set<string>()
    let duplicatePages = 0

    const listingCtx: CollectionContext = {
      ...ctx,
      fetchText: (request) => this.send(attempt, request),
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
          const ids = decoded.value.items.map((item) => (item as { id?: unknown } | null)?.id)
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
    const kept = batch.observations
      .map((o) => (o.identity.nativeId === null ? undefined : discovered.get(o.identity.nativeId)))
      .filter((d): d is DiscoveredItem => d !== undefined)

    const discovery = this.discoveryReport(batch, scope, {
      duplicatePages,
      rejectedLinks: linkStats.rejected,
      navigationOnly: linkStats.navigationOnly,
    })
    const stageB = await this.runDetailStage(config, attempt, kept)
    const stageC = await this.runModelStage(stageB.enrichments, stageB.modelCandidates, kept, ctx)

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

  /**
   * The ONE way a request of this provider leaves: robots, approved host, aggregate byte budget and
   * host gap, in that order, then the context's own fetch. Every refusal happens before any I/O.
   */
  private async send(attempt: Attempt, request: FetchRequest): Promise<FetchedText> {
    const checked = checkStoredLink(request.url)
    if (!checked.ok) throw new HtmlRequestRefused('ACCESS_POLICY', checked.reason)
    if (!attempt.approved.has(checked.url.hostname)) {
      throw new HtmlRequestRefused('ACCESS_POLICY', 'HOST_NOT_APPROVED')
    }
    const robots = await this.deps.robots.check(checked.url.href)
    if (robots.verdict !== 'ALLOWED') {
      throw new HtmlRequestRefused('ACCESS_POLICY', robots.reason ?? robots.verdict)
    }
    const remaining = this.limits.maxTotalBytes - attempt.bytes
    if (remaining <= 0) throw new HtmlRequestRefused('COST_STOP', 'BYTE_BUDGET')
    await this.deps.hostGate.acquire(checked.url.origin, hostGapMs(robots.crawlDelaySeconds))
    attempt.requests += 1
    const response = await attempt.ctx.fetchText({
      ...request,
      maxBytes: Math.min(request.maxBytes ?? remaining, remaining),
    })
    attempt.bytes += Buffer.byteLength(response.bodyText)
    return response
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
    const application =
      item.applicationUrl === undefined || item.applicationUrl === null
        ? null
        : resolveLink(item.applicationUrl, base)
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
    modelCandidates: Map<string, { text: string; aiInput: AiInputSignal }>
  }> {
    const { ctx } = attempt
    const enrichments = new Map<string, HtmlEnrichment>()
    const modelCandidates = new Map<string, { text: string; aiInput: AiInputSignal }>()
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

    for (const item of items) {
      if (item.detailUrl === null) {
        counts.navigationOnly += 1
        continue
      }
      const key = this.enrichmentKey(config, item.id)
      const previous = await this.deps.enrichment.get(key)
      const now = ctx.now()
      const reusable =
        previous !== null &&
        previous.parserVersion === this.parserVersion &&
        previous.policyVersion === ctx.policyVersion
      if (reusable && previous.nextDueAt.getTime() > now.getTime()) {
        counts.notDue += 1
        continue
      }
      stop ??= this.detailStopBefore(attempt, sent, now)
      if (stop !== null) {
        remainingIds.push(item.id)
        continue
      }

      const robots = await this.deps.robots.check(item.detailUrl)
      if (robots.verdict !== 'ALLOWED') {
        counts.policyDenied += 1
        continue
      }

      const result = await this.fetchDetail(attempt, item.detailUrl, robots.crawlDelaySeconds)
      sent += result.sent ? 1 : 0
      if (result.kind === 'STOP') {
        stop = result.stop
        remainingIds.push(item.id)
        continue
      }
      const attempts = (previous?.attempts ?? 0) + 1
      if (result.kind === 'FAILED') {
        counts.failed += 1
        await this.deps.enrichment.put(key, {
          attempts,
          lastAttemptAt: now,
          succeededAt: previous?.succeededAt ?? null,
          error: result.code,
          nextDueAt: new Date(now.getTime() + this.limits.retryAfterMs),
          contentHash: previous?.contentHash ?? null,
          validator: previous?.validator ?? null,
          parserVersion: previous?.parserVersion ?? this.parserVersion,
          policyVersion: previous?.policyVersion ?? ctx.policyVersion,
        })
        continue
      }

      const { response } = result
      const hash = sha256(response.bodyText)
      const unchanged =
        reusable &&
        ((response.status === 304 && response.conditional === true) ||
          (response.etag !== null && response.etag === previous.validator) ||
          hash === previous.contentHash)
      const succeeded: EnrichmentRecord = {
        attempts,
        lastAttemptAt: now,
        succeededAt: now,
        error: null,
        nextDueAt: new Date(now.getTime() + this.limits.revisitAfterMs),
        contentHash: unchanged ? previous.contentHash : hash,
        validator: response.etag ?? (unchanged ? previous.validator : null),
        parserVersion: this.parserVersion,
        policyVersion: ctx.policyVersion,
      }
      if (unchanged) {
        counts.unchanged += 1
        await this.deps.enrichment.put(key, succeeded)
        continue
      }

      let fields: HtmlDetailFields
      try {
        fields = definedOnly(this.deps.strategy.parseDetail(response.bodyText))
      } catch {
        counts.failed += 1
        await this.deps.enrichment.put(key, {
          ...succeeded,
          succeededAt: previous?.succeededAt ?? null,
          error: 'PARSE_DRIFT',
          nextDueAt: new Date(now.getTime() + this.limits.retryAfterMs),
        })
        continue
      }
      counts.fetched += 1
      await this.deps.enrichment.put(key, succeeded)
      const methods: Partial<Record<keyof HtmlDetailFields, FieldMethod>> = {}
      for (const field of Object.keys(fields) as (keyof HtmlDetailFields)[]) {
        methods[field] = 'DETAIL_HTML'
      }
      enrichments.set(item.id, { id: item.id, fields, methods, evidence: [] })
      if (MODEL_FILLABLE_FIELDS.some((f) => fields[f] === undefined)) {
        modelCandidates.set(item.id, { text: response.bodyText, aiInput: robots.aiInput })
      }
    }

    const attempted = counts.fetched + counts.unchanged + counts.failed
    const status: StageStatus =
      items.length === 0
        ? 'SKIPPED'
        : stop !== null
          ? 'PARTIAL'
          : counts.policyDenied > 0 && attempted === 0
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

  /** The aggregate bounds checked before a detail request is even reserved. */
  private detailStopBefore(attempt: Attempt, sent: number, now: Date): DetailStop | null {
    if (attempt.ctx.signal.aborted) return 'CANCELLED'
    if (now.getTime() >= attempt.ctx.deadline.getTime()) return 'DEADLINE'
    if (sent >= this.limits.maxDetails) return 'DETAIL_QUOTA'
    if (attempt.bytes >= this.limits.maxTotalBytes) return 'BYTE_BUDGET'
    return null
  }

  /**
   * One metered detail request: reserve -> mark sent -> fetch -> reconcile, the store's ordering.
   * A refusal of the context (fence, ban, deadline) or of the meter STOPS the stage; a bad answer
   * from the host fails only this item.
   */
  private async fetchDetail(
    attempt: Attempt,
    url: string,
    crawlDelaySeconds: number | null,
  ): Promise<
    | { kind: 'OK'; sent: true; response: FetchedText }
    | { kind: 'FAILED'; sent: boolean; code: string }
    | { kind: 'STOP'; sent: boolean; stop: DetailStop }
  > {
    const { ctx } = attempt
    let reservation: MeterReservation | null
    try {
      reservation = await ctx.meter.reserve('REQUEST', 1)
    } catch {
      return { kind: 'STOP', sent: false, stop: 'METER_FAILED' }
    }
    if (reservation === null) return { kind: 'STOP', sent: false, stop: 'COST_STOP' }

    let resolution: ReservationResolution = 'RELEASED'
    try {
      try {
        await ctx.meter.markSent(reservation)
      } catch {
        return { kind: 'STOP', sent: false, stop: 'METER_FAILED' }
      }
      resolution = 'UNCERTAIN'
      let response: FetchedText
      try {
        const origin = new URL(url).origin
        await this.deps.hostGate.acquire(origin, hostGapMs(crawlDelaySeconds))
        attempt.requests += 1
        response = await ctx.fetchText({
          url,
          maxBytes: Math.min(this.limits.maxDetailBytes, this.limits.maxTotalBytes - attempt.bytes),
        })
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        return {
          kind: 'STOP',
          sent: true,
          stop: typeof code === 'string' ? (code as DetailStop) : 'TRANSIENT_NETWORK',
        }
      }
      resolution = 'USED'
      const bytes = Buffer.byteLength(response.bodyText)
      attempt.bytes += bytes
      if (response.status === 304 && response.conditional === true) {
        return { kind: 'OK', sent: true, response }
      }
      if (response.status < 200 || response.status > 299) {
        return { kind: 'FAILED', sent: true, code: `HTTP_${response.status}` }
      }
      if (bytes > this.limits.maxDetailBytes) {
        return { kind: 'FAILED', sent: true, code: 'PAYLOAD_TOO_LARGE' }
      }
      return { kind: 'OK', sent: true, response }
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
    candidates: Map<string, { text: string; aiInput: AiInputSignal }>,
    discovered: readonly DiscoveredItem[],
    ctx: CollectionContext,
  ): Promise<{ report: HtmlModelReport }> {
    const model = this.deps.model
    if (model === undefined) {
      return { report: { ...EMPTY_MODEL, status: 'SKIPPED', reason: 'NOT_CONFIGURED' } }
    }
    if (candidates.size === 0) {
      return { report: { ...EMPTY_MODEL, status: 'SKIPPED', reason: 'NOTHING_TO_FILL' } }
    }
    const urlById = new Map(discovered.map((d) => [d.id, d.detailUrl]))
    const records: DiscoveredRecord[] = [...candidates].map(([id, c]) => ({
      id,
      url: urlById.get(id) ?? '',
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
      }
    }

    const requested = new Set(candidates.keys())
    if (outcome.kind !== 'EXTRACTED' && outcome.kind !== 'PARTIAL') {
      const remainingIds = 'remainingIds' in outcome ? outcome.remainingIds : []
      return {
        report: {
          ...EMPTY_MODEL,
          status: outcome.kind.startsWith('SKIPPED') ? 'SKIPPED' : 'FAILED',
          reason: outcome.kind,
          requested: records.length,
          remainingIds,
        },
      }
    }

    let applied = 0
    let falseIdentity = 0
    const done = new Set<string>()
    for (const record of outcome.records) {
      if (!requested.has(record.sourceId)) {
        falseIdentity += 1
        continue
      }
      if (done.has(record.sourceId)) continue
      done.add(record.sourceId)
      const current = enrichments.get(record.sourceId)
      if (current === undefined) continue
      const fields = { ...current.fields }
      const methods = { ...current.methods }
      const filled: string[] = []
      const fill = <K extends (typeof MODEL_FILLABLE_FIELDS)[number]>(
        field: K,
        value: HtmlDetailFields[K] | null,
      ) => {
        if (fields[field] !== undefined || value === null || value === undefined) return
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
        remainingIds: outcome.kind === 'PARTIAL' ? outcome.remainingIds : [],
      },
    }
  }
}

const EMPTY_DETAIL: HtmlDetailReport = {
  method: 'HTML_DETAIL',
  status: 'SKIPPED',
  fetched: 0,
  unchanged: 0,
  notDue: 0,
  failed: 0,
  policyDenied: 0,
  navigationOnly: 0,
  stop: null,
  checkpoint: null,
}

const EMPTY_MODEL: HtmlModelReport = {
  method: 'MODEL',
  status: 'SKIPPED',
  reason: null,
  requested: 0,
  applied: 0,
  falseIdentity: 0,
  remainingIds: [],
}

/** A link from page text, resolved against the validated base and held to `checkStoredLink`. */
function resolveLink(raw: string, base: URL): URL | null {
  let href: string
  try {
    href = new URL(raw.trim(), base).href
  } catch {
    return null
  }
  const checked = checkStoredLink(href)
  return checked.ok ? checked.url : null
}

/** Drop `undefined` and `null` values, so "absent" has one spelling. */
function definedOnly(fields: HtmlDetailFields): HtmlDetailFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== null),
  ) as HtmlDetailFields
}
