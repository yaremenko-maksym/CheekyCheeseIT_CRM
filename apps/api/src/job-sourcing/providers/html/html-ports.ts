import type { RobotsPolicy } from '../../structuring/robots-policy'

/**
 * The ports the `HtmlProvider` base (r5 Task 5.5) is assembled from. Interfaces plus in-memory
 * implementations only: the DB-backed enrichment state and the per-source strategies are later
 * tasks (5.6), and nothing here performs I/O.
 */

/** The robots seam is `RobotsPolicy.check` (5.3a), nothing more: a fake implements one method. */
export type RobotsPort = Pick<RobotsPolicy, 'check'>

// ---------------------------------------------------------------------------
// Host gap
// ---------------------------------------------------------------------------

/** The politeness floor between two requests to one origin, whatever robots.txt says. */
export const MIN_HOST_GAP_MS = 3_000

/** The gap one origin is owed: the 3 s floor, or a larger Crawl-delay (seconds) when one is set. */
export function hostGapMs(crawlDelaySeconds: number | null): number {
  return Math.max(MIN_HOST_GAP_MS, (crawlDelaySeconds ?? 0) * 1_000)
}

export interface HostGatePort {
  /**
   * Resolves when a request to `origin` may leave: at least `minGapMs` after the previous one was
   * let go (start-to-start). Rejects with the signal's reason when `signal` aborts during the wait,
   * so a cancelled run never sits out a long Crawl-delay.
   */
  acquire(origin: string, minGapMs: number, signal?: AbortSignal): Promise<void>
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    // The listener goes when the wait ends: one run signal outlives many waits.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort)
  })

/**
 * One process's view of the gap. The slot is RESERVED before the wait, so two concurrent callers
 * for one origin are spaced by the gap rather than both released after the first wait.
 */
export class InMemoryHostGate implements HostGatePort {
  private readonly nextFreeAt = new Map<string, number>()

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {}

  async acquire(origin: string, minGapMs: number, signal?: AbortSignal): Promise<void> {
    const now = this.clock()
    const at = Math.max(now, this.nextFreeAt.get(origin) ?? now)
    this.nextFreeAt.set(origin, at + minGapMs)
    if (at > now) await this.sleep(at - now, signal)
  }
}

// ---------------------------------------------------------------------------
// Enrichment state
// ---------------------------------------------------------------------------

/** What the base remembers about one item's detail enrichment between attempts. */
export interface EnrichmentRecord {
  readonly attempts: number
  readonly lastAttemptAt: Date
  readonly succeededAt: Date | null
  /** A stable code (`HTTP_404`, `PARSE_DRIFT`, ...), never page text. `null` after a success. */
  readonly error: string | null
  readonly nextDueAt: Date
  /** sha256 of the last detail body read, for unchanged-content reuse. */
  readonly contentHash: string | null
  /** The strong `ETag` of that body, when the host sent one. */
  readonly validator: string | null
  /** The detail URL the hash and validator belong to; a different URL is a different resource. */
  readonly url: string
  /** A record written under another parser or policy version is not reused. */
  readonly parserVersion: string
  readonly policyVersion: number
  /**
   * True while the model stage still owes this item a pass (it was not reached: budget, outage,
   * a throw). Such an item is reparsed and offered to the model again even when unchanged.
   */
  readonly modelPending: boolean
}

export interface EnrichmentStatePort {
  get(key: string): Promise<EnrichmentRecord | null>
  put(key: string, record: EnrichmentRecord): Promise<void>
}

export class InMemoryEnrichmentState implements EnrichmentStatePort {
  readonly records = new Map<string, EnrichmentRecord>()

  async get(key: string): Promise<EnrichmentRecord | null> {
    return this.records.get(key) ?? null
  }

  async put(key: string, record: EnrichmentRecord): Promise<void> {
    this.records.set(key, record)
  }
}

// ---------------------------------------------------------------------------
// Per-source parsing
// ---------------------------------------------------------------------------

/** One listing page, as a source strategy reads it. Items are untrusted: the base validates them. */
export interface HtmlListingPage {
  readonly items: readonly unknown[]
  /** Untrusted: an adapter uses it as a PARAMETER of a URL it builds, never as the URL. */
  readonly nextCursor: string | null
}

/** The fields a detail page can fill deterministically. Absent = not recoverable from the page. */
export interface HtmlDetailFields {
  title?: string
  companyName?: string
  location?: string
  description?: string
  employmentType?: string
  remote?: boolean
}

/**
 * The per-source parse, pure over already-fetched text: it never fetches, and it never sees a URL
 * it could follow. `parseListing` returns `null` for a body that is not the listing it expects.
 */
export interface HtmlDiscoveryStrategy {
  parseListing(html: string): HtmlListingPage | null
  parseDetail(html: string): HtmlDetailFields
}
