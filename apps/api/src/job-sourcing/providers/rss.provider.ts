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

/**
 * `type`, `adapterVersion` and `meter` mean exactly what they mean to the loop.
 *
 * `overlapMs` does too — for a `COMPLETE` feed. A `RECENT` feed IGNORES it, and the binding sets it
 * to zero: see `feedPagedSpec`.
 */
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
 * A `RECENT` FEED TAKES NO CONFIGURED WINDOW. Refused, rather than silently replaced (CR-M-2).
 *
 * The configured window used to lose to the feed's own, silently: a config asking for
 * `2026-08-01 .. 2026-08-10` collected a 7-day feed and reported covering
 * `2026-10-13 .. 2026-10-20`. The precedence itself is right — a feed shows what it shows, and the
 * scope must report what was COVERED — but it left the request unanswered with nothing said.
 *
 * SO BOTH CASES ARE DECIDED THE SAME WAY, AND THAT IS THE POINT. Whether the configured window
 * happens to overlap the feed's is an accident of when the run happens: the same
 * `2026-08-01 .. 2026-08-10` config overlaps in August and is disjoint in October. A rule that
 * treated the two differently would make the behaviour a function of the clock, which is the defect
 * in a different spelling. A window on a `RECENT` feed is a request the source cannot honour either
 * way, so it is refused — loudly, and decidably without `now`.
 *
 * WHY IT IS NOT NARROWING (the intersection): narrowing the scope to the overlap would promise
 * FILTERING, and this base filters nothing — every entry the feed carries is observed whatever its
 * date. Reporting a narrower window than the entries we actually stored is the kind of true-looking
 * claim this round is about. If per-config date filtering is wanted, it is a slot added
 * deliberately, with the filter in it.
 *
 * A `COMPLETE` feed keeps its configured window: it is paginated history, so a window is a
 * meaningful thing to have covered.
 *
 * CHECKED AT COLLECT TIME, AND THAT IS A CHOICE RATHER THAN THE ONLY OPTION (CR-M-3). The comment
 * here used to say this was "the one function that sees both" facts, which was false:
 * `defineRssProvider` has `spec.inventory` and `spec.configSchema` in hand, so the refusal could
 * live in `parseConfig` and fire when a source config is SAVED — earlier, and better, for the
 * provider path.
 *
 * It stays here because `collectFeedPages` is also called directly, so a `parseConfig` check would
 * not cover that path and the check would have to exist in BOTH places — two functions that must
 * agree about one rule, which is the defect SR-M-1 was in this same round. One owner, at the
 * latest point every caller passes through. The cost is honest and paid here: an impossible
 * window is refused on the first collection rather than at save time, where `assertInventory` —
 * which needs no config and so has no second path — is refused at module load.
 */
function assertConfigWindow(inventory: FeedInventory, config: SourceConfigFields): void {
  // `config.window` by truthiness, not `!== null && !== undefined`: the config schema defaults the
  // field to `null`, so the `undefined` half of that pair was a branch no input could enter — the
  // mutation gate reported it surviving, and it was right. A window is an object, so truthiness
  // says exactly "a window was asked for", with both of its own branches reachable.
  if (inventory.kind === 'RECENT' && config.window) {
    throw new Error(
      'a RECENT feed shows only its own window and cannot be asked for another: ' +
        'remove `window` from the source config, or declare the feed COMPLETE',
    )
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
    // `type`, `adapterVersion` and `meter` pass through; every other field is set below.
    ...spec,
    /**
     * A RECENT FEED HAS NO OVERLAP TO ASK FOR, SO ITS RESTART OVERLAP IS ZERO (CR-H-1).
     *
     * `widenScope` subtracts `overlapMs` from the window on a `RESTART_WITH_OVERLAP`, and for a
     * JSON API that is right: discovery starts over, and whatever moved across the old boundary
     * while the config changed can be asked for again by widening the request. A FEED CANNOT BE
     * ASKED. It shows the last `windowMs` and nothing else, so widening changes only the CLAIM:
     * measured, a 7-day feed restarting under a stale checkpoint reported covering 8 days —
     * `from` a day before the earliest posting the feed can carry — as `WINDOW`.
     *
     * THIS IS THE ONE COST OF SHARING THE LOOP, and it is paid HERE rather than inside
     * `collectPages`: a behaviour correct for one binding and wrong for another belongs to the
     * binding. `overlapMs` is already the loop's slot for "how much wider to ask", so the feed
     * base answers it — zero — through the seam that exists, and the loop stays free of a
     * `if (this is a feed)` branch it could not test from its own side.
     *
     * An adapter's own `overlapMs` is OVERRIDDEN rather than respected, because a feed adapter
     * setting one would be making the same false claim one layer up. For a `COMPLETE` feed —
     * paginated history, which can be asked for more — it passes through untouched.
     */
    // Spread rather than assigned, so a COMPLETE feed that set none keeps having none and gets
    // the loop's own default: under `exactOptionalPropertyTypes` an explicit `undefined` is not
    // the same as an absent field, and writing one here would be a third state to reason about.
    ...(spec.inventory.kind === 'RECENT' ? { overlapMs: 0 } : {}),
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
    // A RECENT feed's window is the feed's own, always — and a config that asked for a different
    // one never reaches here: `assertConfigWindow` refuses it (CR-M-2).
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

/**
 * `async`, SO THE TWO REFUSALS ABOVE REJECT INSTEAD OF THROWING SYNCHRONOUSLY (CR-M-3).
 *
 * The signature said `Promise<CollectionBatch>` while `assertInventory` and `assertConfigWindow`
 * threw before any promise existed, so the refusal arrived by a channel the declared type does not
 * have: a caller holding `collectFeedPages(...)` and expecting to `.catch()` it got an exception
 * instead, and the spec pinned exactly that with `expect(() => …).toThrow`. One `async` keyword
 * makes both refusals a rejection, which is the one shape every caller of this type already
 * handles — `collectReport` included, where it is the rejection the provider contract reports.
 */
export async function collectFeedPages<TConfig extends SourceConfigFields>(
  spec: RssSourceSpec<TConfig>,
  config: TConfig,
  ctx: CollectionContext,
  port: XmlPort = xmlPort,
): Promise<CollectionBatch> {
  assertInventory(spec.inventory)
  assertConfigWindow(spec.inventory, config)
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
