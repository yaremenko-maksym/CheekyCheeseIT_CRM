import type { FetchedText } from '../providers/reporting-provider'
import { checkStoredLink } from '../normalize/url-policy'
import {
  isPathAllowed,
  MAX_ROBOTS_BYTES,
  parseRobots,
  resolveRobots,
  type ResolvedRobots,
  type SignalValue,
} from './robots-parser'

/**
 * Egress gate for detail fetches: may we request this URL, according to its origin's robots.txt?
 *
 * Fail closed. The only ways to `ALLOWED` are a readable robots.txt that permits the path, or a
 * definite "there is no robots.txt" (404 / 410). Every other outcome is a refusal, and none of them
 * is cached, so a recovered site is asked again on the next check.
 *
 * `fetchRobots` is injected and receives the validated ORIGIN (`https://host`); it is expected to
 * request `<origin>/robots.txt` through the egress client. This file imports no transport.
 */

/** The longest Crawl-delay we honour: one day. Anything longer (or not finite) pauses the origin. */
export const MAX_CRAWL_DELAY_SECONDS = 86_400

const isHonourableDelay = (seconds: number) =>
  Number.isFinite(seconds) && seconds <= MAX_CRAWL_DELAY_SECONDS

/** RFC 9309 2.3.1.4: a cached copy is used for at most 24 hours. */
export const ROBOTS_CACHE_MS = 24 * 60 * 60 * 1000

export type RobotsVerdict = 'ALLOWED' | 'DENIED' | 'UNREACHABLE_DENIED' | 'PAUSED'

export interface RobotsCheck {
  verdict: RobotsVerdict
  /** Why it is not `ALLOWED`; `null` when it is. Stable codes, safe to log. */
  reason: string | null
  crawlDelaySeconds: number | null
  aiInput: SignalValue
}

export interface RobotsPolicyDeps {
  fetchRobots: (originUrl: string) => Promise<FetchedText>
  /** Our product token, matched case-insensitively against `User-agent` lines. */
  productToken: string
}

interface CacheEntry {
  fetchedAtMs: number
  resolved: ResolvedRobots
}

const refusal = (verdict: RobotsVerdict, reason: string): RobotsCheck => ({
  verdict,
  reason,
  crawlDelaySeconds: null,
  aiInput: 'unspecified',
})

type Loaded = { ok: true; resolved: ResolvedRobots } | { ok: false; check: RobotsCheck }

export class RobotsPolicy {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: RobotsPolicyDeps) {}

  /**
   * `link` may be relative only when `opts.baseOrigin` is given; it is then resolved against that
   * origin (itself validated) and must stay on it. The verdict is computed per call, per path.
   */
  async check(link: string, opts: { baseOrigin?: string } = {}): Promise<RobotsCheck> {
    let target = link
    let baseOrigin: string | null = null
    if (opts.baseOrigin !== undefined) {
      const base = checkStoredLink(opts.baseOrigin)
      if (!base.ok) return refusal('DENIED', base.reason)
      baseOrigin = base.url.origin
      try {
        target = new URL(link, base.url).href
      } catch {
        // `target` stays the raw text, which checkStoredLink below refuses as UNPARSEABLE too.
      }
    }

    const checked = checkStoredLink(target)
    if (!checked.ok) return refusal('DENIED', checked.reason)
    const { url } = checked
    if (baseOrigin !== null && url.origin !== baseOrigin) return refusal('DENIED', 'CROSS_ORIGIN')

    const loaded = await this.load(url.origin)
    if (!loaded.ok) return loaded.check
    const { resolved } = loaded
    const delay = resolved.crawlDelaySeconds
    // A delay no scheduler can honour (a 310-digit value parses to Infinity, and past 2^31-1 ms
    // setTimeout fires at once) pauses the origin instead of being exposed to the caller.
    if (delay !== null && !isHonourableDelay(delay)) {
      return refusal('PAUSED', 'CRAWL_DELAY_TOO_LONG')
    }
    const allowed = isPathAllowed(resolved, url.pathname + url.search)
    return {
      verdict: allowed ? 'ALLOWED' : 'DENIED',
      reason: allowed ? null : 'DISALLOWED_BY_ROBOTS',
      crawlDelaySeconds: resolved.crawlDelaySeconds,
      aiInput: resolved.signals.aiInput,
    }
  }

  private async load(origin: string): Promise<Loaded> {
    const cached = this.cache.get(origin)
    if (cached !== undefined && Date.now() - cached.fetchedAtMs < ROBOTS_CACHE_MS) {
      return { ok: true, resolved: cached.resolved }
    }
    // A stale copy is never served: it is replaced on success and dropped on any failure.
    this.cache.delete(origin)

    let response: FetchedText
    try {
      response = await this.deps.fetchRobots(origin)
    } catch {
      return { ok: false, check: refusal('UNREACHABLE_DENIED', 'NETWORK_ERROR') }
    }

    const { status } = response
    // 404 / 410: no robots.txt, everything allowed (RFC 9309 2.3.1.3). Its body is not read.
    const missing = status === 404 || status === 410
    if (!missing) {
      if (status === 401 || status === 403 || status === 429) {
        return { ok: false, check: refusal('PAUSED', `HTTP_${status}`) }
      }
      if (status < 200 || status > 299) {
        return { ok: false, check: refusal('UNREACHABLE_DENIED', `HTTP_${status}`) }
      }
    }
    const body = missing ? '' : response.bodyText
    // Deliberate: RFC 9309 lets a crawler parse the first 500 KiB of a larger file, but a file this
    // size is not a normal robots.txt, and the rules past the cut may be the ones that forbid us.
    // Fail closed (stricter than the RFC) rather than act on a prefix. parseRobots still truncates.
    if (Buffer.byteLength(body) > MAX_ROBOTS_BYTES) {
      return { ok: false, check: refusal('UNREACHABLE_DENIED', 'OVERSIZE') }
    }

    const parsed = parseRobots(body)
    if (parsed.meaningfulLines > 0 && parsed.recognisedLines === 0) {
      return { ok: false, check: refusal('UNREACHABLE_DENIED', 'UNPARSEABLE_BODY') }
    }
    return this.remember(origin, resolveRobots(parsed, this.deps.productToken))
  }

  private remember(origin: string, resolved: ResolvedRobots): Loaded {
    this.cache.set(origin, { fetchedAtMs: Date.now(), resolved })
    return { ok: true, resolved }
  }
}
