import { DEFAULT_USER_AGENT } from '../../http/bounded-fetch'

/**
 * The robots.txt rules both crawling shapes share: the listing-and-detail collector and the
 * sitemap-and-JSON-LD runner (task sources-16, H-1). Moved here from `listing-detail.collector.ts`
 * so the sitemap runner can use them without an import cycle.
 */

/** Our robots product token: the product of the transport's own User-Agent. */
export const ROBOTS_PRODUCT_TOKEN = DEFAULT_USER_AGENT.split('/')[0]!

/** RFC 9309 section 2.5: a crawler may stop parsing robots.txt after 500 KiB. */
export const ROBOTS_MAX_BYTES = 500 * 1024

/** Two detail pages in a row answering a redirect end the run as a block (SR2-L-2, PR #1445). */
export const MAX_REDIRECTED_DETAILS = 2

/** A line robots.txt is made of (RFC 9309 records, plus the common extensions). */
const ROBOTS_DIRECTIVE = /^[ \t]*(?:user-agent|disallow|allow|sitemap|crawl-delay)[ \t]*:/im

/**
 * A 200 robots body that is not a robots file (SR-L-1, FL2-L-1): a web page, or a non-empty body
 * with no directive line at all (a JSON or plain-text block message). Read as no rules, it would
 * allow all. An empty body stays allow-all (the standard).
 */
export function isNotRobotsFile(bodyText: string, contentType: string | undefined): boolean {
  // The production context passes no headers (`headers: {}`), so an absent type is not judged.
  if (contentType !== undefined && !/^text\/plain\b/i.test(contentType.trim())) return true
  const body = bodyText.trim()
  return body.startsWith('<') || (body !== '' && !ROBOTS_DIRECTIVE.test(body))
}

/**
 * Whether the robots.txt body declares at least one `Sitemap:` line whose URL matches any of `urls`.
 * Used when a sitemap is served from a CDN (`site.sitemapRequestUrl`) to verify the authority site
 * still points to it (task sources-16, F2).
 */
export function hasDeclaredSitemap(bodyText: string, urls: readonly string[]): boolean {
  const target = new Set(urls)
  for (const rawLine of bodyText.split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf('#')
    const line = hash === -1 ? rawLine : rawLine.slice(0, hash)
    const colon = line.indexOf(':')
    if (colon === -1) continue
    if (line.slice(0, colon).trim().toLowerCase() === 'sitemap') {
      if (target.has(line.slice(colon + 1).trim())) return true
    }
  }
  return false
}
