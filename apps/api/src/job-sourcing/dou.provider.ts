import { Injectable, Logger } from '@nestjs/common'
import type { JobSourceType } from '@crm/shared'
import { htmlToMarkdown } from './html-to-markdown'
import {
  type JobSourceProvider,
  type NormalizedPosting,
  canonicalizePostingUrl,
  computePostingFingerprint,
  normalizedCompany,
} from './job-source.provider'
import { type RawRssItem, parseRssItems } from './rss'

/**
 * DOU.ua RSS provider — the ONE source of slice 1.
 *
 * Measured facts this is built on (task §"Установленные факты", not re-verified
 * here): `https://jobs.dou.ua/vacancies/feeds/` returns 200 / `application/rss+xml`
 * with 25 entries and understands `?category=`. Djinni's RSS returns 1–2 entries
 * regardless of parameters and is therefore NOT a viable search source.
 *
 * SSRF: THE ENDPOINT IS A CONSTANT
 * --------------------------------
 * `FEED_BASE_URL` is hardcoded and the only thing a stored source config can
 * influence is `category`, which must be a member of `ALLOWED_CATEGORIES`. An
 * admin-writable URL (or a free-text query param) would turn this collector —
 * which runs unattended, inside our network — into an SSRF primitive pointed at
 * whatever an attacker with DB or admin access typed. It is cheaper to keep the
 * URL in code than to defend a URL field.
 */

const FEED_BASE_URL = 'https://jobs.dou.ua/vacancies/feeds/'

/** Request timeout — the collector must not hang on a stalled feed. */
const FETCH_TIMEOUT_MS = 15_000

/**
 * Categories DOU exposes that are plausibly relevant to our seniors. This is an
 * ALLOW-LIST, not a validation pattern: membership is the actual control, the
 * shape check is only a second line.
 */
export const ALLOWED_CATEGORIES = [
  'JavaScript',
  'Front End',
  'Fullstack',
  'Node.js',
  'React Native',
  'Java',
  'Python',
  'PHP',
  '.NET',
  'Golang',
  'Ruby',
  'Scala',
  'Kotlin',
  'Swift',
  'iOS',
  'Android',
  'Flutter',
  'C++',
  'Rust',
  'QA',
  'QA Automation',
  'DevOps',
  'SRE',
  'Data Science',
  'Data Engineer',
  'Machine Learning',
  'Project Manager',
  'Product Manager',
  'Business Analyst',
  'Design',
] as const

export type DouCategory = (typeof ALLOWED_CATEGORIES)[number]

export interface DouSourceConfig {
  category?: string
}

/**
 * Build the feed URL for a stored config. Throws on a category that is not
 * allow-listed — a bad config must fail LOUD at collection time, not silently
 * fall back to "everything" (which would look like the filter simply stopped
 * working).
 */
export function buildDouFeedUrl(config: Record<string, unknown>): string {
  const category = config['category']
  if (category === undefined || category === null || category === '') return FEED_BASE_URL
  if (typeof category !== 'string') {
    throw new Error('DOU source config: `category` must be a string')
  }
  if (!(ALLOWED_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`DOU source config: category "${category}" is not allow-listed`)
  }
  return `${FEED_BASE_URL}?category=${encodeURIComponent(category)}`
}

export interface ParsedDouTitle {
  title: string
  companyName: string
  location: string | null
}

/**
 * DOU packs three fields into `<title>`:
 *
 *   `Senior Software Test Automation Engineer (JS) в EPAM, Київ, Харків, віддалено`
 *   `Middle JavaScript Full Stack Developer (Node + React) в Wetelo, Inc., Луцьк, віддалено`
 *   `JS Fullstack Developer (Jun+) в Advanced Software Development (ASD Team), $1100–1300, віддалено`
 *
 * Rules, each of which exists because a real title breaks the naive version:
 *
 *  - Split on the LAST ` в `, not the first. A POSITION can contain the
 *    Ukrainian preposition (`Продажі в IT в EPAM, Київ`); the company + city
 *    tail essentially never does.
 *  - After the split, the company is the first comma-separated segment — UNLESS
 *    the next segment is a legal form (`Wetelo, Inc.`), which is re-attached.
 *    Without this, `Wetelo, Inc.` would be stored as `Wetelo` with `Inc.` shown
 *    as a location.
 *  - The remaining segments (cities, "віддалено", sometimes a salary range) are
 *    kept verbatim as `location` — the same single line DOU itself shows.
 */
export function parseDouTitle(rawTitle: string): ParsedDouTitle {
  const title = rawTitle.trim()
  const separator = ' в '
  const splitAt = title.lastIndexOf(separator)
  if (splitAt === -1) {
    return { title, companyName: '', location: null }
  }

  const position = title.slice(0, splitAt).trim()
  const tail = title.slice(splitAt + separator.length).trim()
  const segments = tail
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (segments.length === 0) return { title: position, companyName: '', location: null }

  let companyName = segments[0] ?? ''
  let consumed = 1
  const LEGAL_TAILS = /^(inc|llc|ltd|limited|corp|co|gmbh|s\.?a\.?|b\.?v\.?|plc|llp|lp)\.?$/i
  const next = segments[1]
  if (next !== undefined && LEGAL_TAILS.test(next)) {
    companyName = `${companyName}, ${next}`
    consumed = 2
  }

  const location = segments.slice(consumed).join(', ')
  return {
    title: position.length > 0 ? position : title,
    companyName,
    location: location.length > 0 ? location : null,
  }
}

/**
 * `https://jobs.dou.ua/companies/epam-systems/vacancies/356562/` → `epam systems`.
 * Fallback company name for a title that does not follow the ` в ` grammar.
 * Good enough for FILTERING too: `normalizeCompanyName` collapses
 * `epam systems` and `EPAM` onto a match (token-window rule).
 */
export function companyFromDouUrl(url: string): string {
  const match = /\/companies\/([^/]+)\//.exec(url)
  if (!match?.[1]) return ''
  return match[1].replace(/[-_]+/g, ' ').trim()
}

function parsePubDate(raw: string): Date | null {
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

@Injectable()
export class DouRssProvider implements JobSourceProvider {
  readonly type: JobSourceType = 'DOU_RSS'
  private readonly logger = new Logger(DouRssProvider.name)

  async collect(config: Record<string, unknown> = {}): Promise<NormalizedPosting[]> {
    const url = buildDouFeedUrl(config)
    const xml = await this.fetchFeed(url)
    return this.normalize(parseRssItems(xml))
  }

  /** Isolated for tests (which stub it rather than hitting the network). */
  protected async fetchFeed(url: string): Promise<string> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // Identify ourselves honestly — this is an official feed, read politely.
        'user-agent': 'CheekyCheeseIT-CRM/1.0 (job sourcing; +https://cheekycheese.tech)',
        accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
      },
    })
    if (!response.ok) {
      throw new Error(`DOU feed responded ${response.status} ${response.statusText}`)
    }
    return await response.text()
  }

  /**
   * RSS items → postings. An entry we cannot make sense of (no https link, no
   * title) is SKIPPED with a warning, never allowed to abort the batch: one
   * malformed row in a third-party feed must not cost us the other 24.
   */
  normalize(items: RawRssItem[]): NormalizedPosting[] {
    const postings: NormalizedPosting[] = []

    for (const item of items) {
      // `<link>` first (stable path + utm query), `<guid>` as a fallback.
      const canonicalUrl = canonicalizePostingUrl(item.link) ?? canonicalizePostingUrl(item.guid)
      if (!canonicalUrl) {
        this.logger.warn(`Skipping DOU entry with unusable link: ${item.link || item.guid || '—'}`)
        continue
      }

      const parsed = parseDouTitle(item.title)
      const title = parsed.title.trim()
      if (title.length === 0) {
        this.logger.warn(`Skipping DOU entry without a title: ${canonicalUrl}`)
        continue
      }

      const companyName = parsed.companyName || companyFromDouUrl(canonicalUrl)
      if (companyName.length === 0) {
        // Without a company we cannot honour the "never your own client" rule,
        // so the posting is dropped rather than shown unfiltered.
        this.logger.warn(`Skipping DOU entry without a company: ${canonicalUrl}`)
        continue
      }

      postings.push({
        sourceType: this.type,
        externalId: canonicalUrl,
        url: canonicalUrl,
        title: title.slice(0, 500),
        companyName: companyName.slice(0, 255),
        companyNameNormalized: normalizedCompany(companyName).slice(0, 255),
        location: parsed.location ? parsed.location.slice(0, 500) : null,
        descriptionMd: htmlToMarkdown(item.description),
        publishedAt: parsePubDate(item.pubDate),
        fingerprint: computePostingFingerprint(this.type, canonicalUrl),
      })
    }

    return postings
  }
}
