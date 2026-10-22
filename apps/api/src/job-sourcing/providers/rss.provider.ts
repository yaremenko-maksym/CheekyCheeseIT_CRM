import { type ZodType, z } from 'zod'
import { type FeedDocument, type FeedEntry, readFeed } from '../feed/read-feed'
import type { RawObservationFields } from '../normalize/observation'
import { type XmlPort, xmlPort } from '../xml'
import {
  collectPages,
  type DecodedEnvelope,
  definePagedProvider,
  type PagedSourceSpec,
  type PageTarget,
} from './api-json.provider'
import type {
  CollectionBatch,
  CollectionContext,
  FetchRequest,
  ReportingJobSourceProvider,
  SourceConfigFields,
  Validated,
} from './reporting-provider'
import {
  decodeXmlBody,
  honestRequest,
  resolveXmlSourceLimits,
  type XmlSourceLimits,
} from './xml-source.provider'

/**
 * The `RssProvider` base (r5 Task 2.4): RSS 2.0, RSS 1.0 and Atom feeds collected through the SAME
 * page loop as the API providers, returning the same `CollectionBatch`.
 *
 * NOT `../rss.ts`. That file is DOU's hand-rolled scanner and stays DOU-only (constraint C-20), with
 * its own caps and its legacy timestamp-query identity via `canonicalizePostingUrl` — DOU's `<guid>`
 * carries a fresh timestamp on every fetch, so the opaque-GUID policy below would mint a new
 * identity per run for it. This base is new, beside it, and does not import it.
 *
 * THE DECISION THIS FILE STANDS ON: it does not have a loop of its own. Feeds are usually one
 * document with no pagination, which makes a small dedicated loop look cheaper — and that loop would
 * have had to re-derive checkpoint validation, reserve -> reconcile, the conditional cache,
 * outcome/coverage derivation and failure classification, the surface Task 2.3 hardened over two
 * review rounds (a resumed run reporting SUCCEEDED after zero fetches, an unvalidated checkpoint, a
 * cursor that poisons the source). Each of those would be re-introducible by a second
 * implementation. So the feed base is a binding: the XML helper's decode (`decodeXmlBody`) and
 * request policy (`honestRequest`) are composed with Seam 2 (`readFeed`) and the feed's identity
 * and coverage policy.
 *
 * WHAT IS THE BASE'S, NOT THE ADAPTER'S — each a decision an adapter author cannot get wrong:
 *  - identity: `nativeId` is the entry's GUID (Atom `id`, RSS `guid` including
 *    `isPermaLink="false"`, RSS 1.0 `rdf:about`), verbatim. `mapEntry` has no slot for it.
 *  - coverage: `inventory` is REQUIRED, so every feed adapter states whether its feed is the whole
 *    inventory or only a recent window. A time-limited feed gets a real window and therefore never
 *    claims FULL_INVENTORY.
 *  - the cache key, and the user agent.
 */

/**
 * What a feed shows of the provider's inventory — a claim about the provider, written down.
 *
 * `RECENT`: the feed carries only postings from the last `windowMs`. Its scope is the window
 * `[now - windowMs, now]`, so `deriveCoverage` reports WINDOW however the attempt ends.
 */
export type FeedInventory = { kind: 'COMPLETE' } | { kind: 'RECENT'; windowMs: number }

/** `type`, `adapterVersion`, `meter` and `overlapMs` mean exactly what they mean to the loop. */
export interface RssSourceSpec<TConfig extends SourceConfigFields> extends Pick<
  PagedSourceSpec<TConfig, FeedDocument, FeedEntry>,
  'type' | 'adapterVersion' | 'meter' | 'overlapMs'
> {
  readonly configSchema: ZodType<TConfig>
  /** Required: see `FeedInventory`. There is no default because both defaults would be a guess. */
  readonly inventory: FeedInventory
  /**
   * The request for one feed document. Build it from `at` (see `PageTarget`), never from a
   * provider-chosen URL. The user agent and browser client hints are replaced by the base.
   */
  feedRequest(config: TConfig, at: PageTarget): FetchRequest
  /**
   * Map one entry. May throw: the entry is isolated with a bounded sample and the feed goes on.
   * `nativeId` is absent from the return type on purpose — the base sets it from the GUID.
   */
  mapEntry(
    entry: FeedEntry,
    config: TConfig,
  ): Omit<RawObservationFields, 'provider' | 'adapterVersion' | 'nativeId'>
  /**
   * The cursor for the next document, for the minority of feeds that paginate. Omitted, a feed is
   * one document. The same rules as `PagedSourceSpec.nextCursor` apply: the cursor is untrusted
   * input and must not become the request target.
   */
  nextCursor?(feed: FeedDocument, at: PageTarget): string | null
  readonly limits?: Partial<XmlSourceLimits>
}

/**
 * Entries are produced by `readFeed` from a document the port has already bounded and parsed, not
 * received as untrusted JSON, so there is nothing for an item schema to refuse. Stated as an
 * accept-all schema rather than left out because the loop's item step is not optional, and a bad
 * ENTRY is still isolated — by `mapEntry` throwing or the observation builder quarantining it.
 */
const feedEntrySchema: ZodType<FeedEntry> = z.custom<FeedEntry>()

function assertInventory(inventory: FeedInventory): void {
  if (inventory.kind === 'RECENT') {
    const { windowMs } = inventory
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(
        `RECENT inventory windowMs must be a positive, finite number of milliseconds, got ${windowMs}`,
      )
    }
  }
}

/**
 * The cache key for one document: source type, board, config version, page and cursor.
 *
 * The config version is in it so a config change cannot revalidate a body fetched under the old
 * config, and the cursor so two pages of a paginated feed never share an entry. A JSON tuple for
 * the same reason the identity key is one: no component can imitate a boundary.
 */
const cacheKeyOf = (type: string, config: SourceConfigFields, at: PageTarget): string =>
  JSON.stringify([type, config.namespace, config.configVersion, at.page, at.cursor])

function feedPagedSpec<TConfig extends SourceConfigFields>(
  spec: RssSourceSpec<TConfig>,
  port: XmlPort,
): PagedSourceSpec<TConfig, FeedDocument, FeedEntry> {
  const limits = resolveXmlSourceLimits(spec.limits)
  return {
    // `type`, `adapterVersion`, `meter`, `overlapMs` pass through; every other field is set below.
    ...spec,
    itemSchema: feedEntrySchema,
    limits,
    decodeEnvelope: (bodyText): DecodedEnvelope<FeedDocument> => {
      const document = decodeXmlBody(bodyText, limits, port)
      if (!document.ok) return document
      const feed = readFeed(document.value)
      return feed.ok
        ? { ok: true, value: feed.feed }
        : { ok: false, code: 'PARSE_DRIFT', message: `feed: ${feed.reason}` }
    },
    pageRequest: (config, at) => ({
      request: honestRequest(spec.feedRequest(config, at)),
      cacheKey: cacheKeyOf(spec.type, config, at),
    }),
    extractItems: (feed) => feed.entries,
    nextCursor: spec.nextCursor ?? (() => null),
    // The GUID, and nothing the adapter returns, is the native id: `mapItem` writes it AFTER the
    // adapter's fields, and `nativeIdOf` reports the same value so the loop's collision check
    // compares exactly what identity was keyed on.
    nativeIdOf: (entry) => entry.guid,
    mapItem: (entry, config) => ({ ...spec.mapEntry(entry, config), nativeId: entry.guid }),
    scopeOf: (config, now) => ({
      namespace: config.namespace,
      query: config.query ?? null,
      configVersion: config.configVersion,
      window:
        spec.inventory.kind === 'RECENT'
          ? { from: new Date(now.getTime() - spec.inventory.windowMs), to: now }
          : (config.window ?? null),
    }),
  }
}

export function collectFeedPages<TConfig extends SourceConfigFields>(
  spec: RssSourceSpec<TConfig>,
  config: TConfig,
  ctx: CollectionContext,
  port: XmlPort = xmlPort,
): Promise<CollectionBatch> {
  assertInventory(spec.inventory)
  return collectPages(feedPagedSpec(spec, port), config, ctx)
}

/**
 * Turn a feed spec into a `ReportingJobSourceProvider`. Refuses an impossible `inventory` HERE, at
 * definition — module load, in practice — rather than on the first collection, so a misdeclared
 * window fails a deploy's boot instead of a 03:00 run.
 */
export function defineRssProvider<TConfig extends SourceConfigFields>(
  spec: RssSourceSpec<TConfig>,
  port: XmlPort = xmlPort,
): ReportingJobSourceProvider<Validated<TConfig>> {
  assertInventory(spec.inventory)
  return definePagedProvider(spec, (config, ctx) => collectFeedPages(spec, config, ctx, port))
}
