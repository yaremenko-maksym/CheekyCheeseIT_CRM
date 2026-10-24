import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
} from '../api-json.provider'
import { decodeXmlEntities } from '../../rss'
import { boundedString, dateRaw, positiveSafeInt } from './as'

/**
 * Hacker News "Ask HN: Who is hiring?" through the HN Search API on Algolia, in two steps:
 *
 *   1. `search_by_date?tags=story,author_whoishiring` -> the newest "Who is hiring?" story;
 *   2. `items/{id}` -> that story with its whole comment tree.
 *
 * BLOCKED - NOT TO BE REGISTERED OR ENABLED (permission `UNCLEAR`; see `HN_SOURCE_STATUS`). The
 * Y Combinator terms say "you will not engage in or use any data mining, robots, scraping or
 * similar data gathering or extraction methods" in connection with "the Site"; the Algolia API is
 * a public, unauthenticated, documented endpoint. Whether it is "the Site" is an OWNER decision,
 * put to him and unanswered. The adapter and its authentic fixtures stay until it is made.
 *
 * - THE VACANCY is a TOP-LEVEL comment of the thread; nested replies are conversation and are
 *   never read (the item schema has no `children`). Identity is the comment id, with the link
 *   `https://news.ycombinator.com/item?id=<id>` and `identityParams: ['id']` so `?id=` is kept
 *   when the link is canonicalised (otherwise every comment would collapse onto one URL).
 * - THE THREAD is chosen by title (`Ask HN: Who is hiring?`), never by position: the same account
 *   posts "Who wants to be hired?" the same minute, and that thread holds candidates, not vacancies.
 *   "Current" means created within `maxThreadAgeDays` (default 45) of the run's clock. No such
 *   thread is a VALID EMPTY run, not a failure. A thread step that is not a "Who is hiring?" story
 *   is refused as drift (`PARSE_DRIFT`), so a selection bug cannot silently ingest candidates.
 * - NO "Company | Role" ASSUMPTION. A comment is free text; the headers seen include no pipe at all
 *   ("PrairieLearn (Remote US) - Full-Stack Software Engineer"), location first ("London, UK |
 *   TESSIAN | ..."), company first, and prose. So the TITLE is the first paragraph verbatim, the
 *   LOCATION is null, and nothing is split by guesswork.
 * - THE EMPLOYER IS NOT KNOWN. `companyName` is the posting account (`HN @name`), which is a true
 *   statement about who posted, never a guess about who is hiring, and every observation carries
 *   the tag `employer-unverified`.
 * - EXPLICIT TRIAGE, as tags, never as a drop or a split: `triage:multi-role` (the header names
 *   several roles), `triage:no-role-signal` (no hiring vocabulary in the header, e.g. the
 *   commentary comments that sit at the top level), `triage:long-header` (the first paragraph
 *   exceeded the title bound and was cut at it, said out loud). A multi-role comment is ONE
 *   observation to be triaged, not several guessed ones.
 * - REMOTE is read from the header only. An explicit negation ("Onsite Only", "no remote") is
 *   false; REMOTE without ONSITE is true; both, either alone without negation, or neither is
 *   unknown (null).
 * - DELETED comments arrive (if at all) with `text: null`; they are skipped before validation as
 *   tombstones, not counted as invalid. NOT VERIFIED against an authentic sample: none of the 1331
 *   top-level comments captured was deleted. An EDITED comment is the same id with different text:
 *   the identity is unchanged and the content hash differs. Algolia exposes no edit time.
 * - A thread can exceed the 2 MiB JSON cap: the largest captured (May 2019, 816 comments) was
 *   1 402 131 bytes. Past the cap the thread step fails as `PAYLOAD_TOO_LARGE`, never cut.
 * - Y Combinator's robots.txt sets `Crawl-delay: 30` for news.ycombinator.com; this adapter makes
 *   two requests per run to hn.algolia.com, which serves no robots.txt.
 */

export const HN_SOURCE_STATUS = {
  blocked: true,
  permission: 'UNCLEAR',
  reason:
    'Y Combinator terms forbid scraping "the Site" while the Algolia API is public and documented; owner decision required before registration',
} as const

export const HN_ADAPTER_VERSION = 'hn-hiring-1'
export const HN_NAMESPACE = 'hn-hiring'
export const HN_SCOPE_QUERY = 'who-is-hiring-latest-thread'
const SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date'
const ITEMS_URL = 'https://hn.algolia.com/api/v1/items'
const ITEM_LINK = 'https://news.ycombinator.com/item'
const SEARCH_HITS_PER_PAGE = 10
/** The search step plus the thread step. */
export const HN_PAGES_PER_RUN = 2
/** The largest thread captured held 816 top-level comments; this leaves room and still bounds a page. */
export const HN_MAX_COMMENTS = 1500
export const HN_MAX_THREAD_AGE_DAYS = 90
const DAY_MS = 86_400_000
const WHOISHIRING = 'whoishiring'
const HIRING_TITLE = /^Ask HN: Who is hiring\?/i
const CURSOR = /^story:(\d{1,15})$/

export const HN_TAG_EMPLOYER_UNVERIFIED = 'employer-unverified'
export const HN_TAG_MULTI_ROLE = 'triage:multi-role'
export const HN_TAG_NO_ROLE_SIGNAL = 'triage:no-role-signal'
export const HN_TAG_LONG_HEADER = 'triage:long-header'

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(HN_NAMESPACE).default(HN_NAMESPACE),
    maxThreadAgeDays: z.number().int().min(1).max(HN_MAX_THREAD_AGE_DAYS).default(45),
  })
  .strict()
  .refine((c) => c.query === null, {
    message: 'Hacker News has no search; the thread is the scope',
  })
  .refine((c) => c.window === null, { message: 'Hacker News has no date window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: positiveSafeInt(),
  type: z.literal('comment'),
  author: boundedString(100).min(1),
  text: boundedString(ORIGINAL_LIMITS.description),
  created_at: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

const hitSchema = z.object({
  objectID: z.string().regex(/^\d{1,15}$/),
  author: z.string().max(100),
  title: z.string().max(300),
  created_at_i: z.number().int(),
})

/**
 * One envelope for both steps, told apart by shape (`hits` = search, `children` = thread). Both
 * item arrays stay OPAQUE so one bad hit or comment is isolated instead of failing the page.
 */
const envelopeSchema = z
  .object({
    hits: z.array(z.unknown()).optional(),
    id: z.number().int().optional(),
    title: z.string().max(300).nullish(),
    children: z.array(z.unknown()).optional(),
  })
  .refine((e) => e.children !== undefined || e.hits !== undefined, {
    message: 'neither a search result nor a thread',
  })
  .refine(
    // A missing or null title stringifies to 'undefined' / 'null', which the pattern never matches.
    (e) => e.children === undefined || HIRING_TITLE.test(`${e.title}`),
    { message: 'the thread is not a "Who is hiring?" story' },
  )
type Envelope = z.infer<typeof envelopeSchema>

/**
 * The comment's first line as plain text: HN separates paragraphs with `<p>`, and some posters put
 * the header on its own line with a bare newline before the prose ("PDT Partners | NYC, Hybrid\n
 * PDT was a pioneer ..."), so a newline ends the header too.
 */
export function headerOf(html: string): string {
  const first = html.replace(/(?:<p>|\r?\n)[\s\S]*/i, '')
  // `&nbsp;` is the one HTML entity HN emits that the shared XML decoder does not know.
  return decodeXmlEntities(first.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

const ROLE_NOUN =
  /\b(?:engineers?|developers?|designers?|managers?|analysts?|scientists?|architects?|leads?|specialists?|recruiters?|consultants?)\b/gi
const MULTI_ROLE_WORDS = /\b(?:multiple|several|various|roles|positions|openings)\b/i
const ROLE_SIGNAL =
  /\b(?:hiring|engineers?|developers?|designers?|remote|onsite|on-site|hybrid|full[- ]?time|part[- ]?time|contract|interns?|internships?|apply|join|careers?|jobs?)\b/i
const REMOTE_NEGATED =
  /\b(?:no|not|non)[- ]remote\b|\bremote[: ]+(?:no|not)\b|\bon-?site[ -]only\b|\bonly on-?site\b/i

export const isMultiRole = (header: string) =>
  MULTI_ROLE_WORDS.test(header) || [...header.matchAll(ROLE_NOUN)].length >= 2

export const hasRoleSignal = (header: string) => header.includes('|') || ROLE_SIGNAL.test(header)

/**
 * `false` only on an explicit negation, `true` on REMOTE with no ONSITE, `null` otherwise. The
 * posting rules of the thread ask for REMOTE / ONSITE tokens, but a header such as "ONSITE or
 * REMOTE (US)" offers both, and "Hybrid" is neither.
 */
export function remoteOf(header: string): boolean | null {
  if (REMOTE_NEGATED.test(header)) return false
  const remote = /\bremote\b/i.test(header)
  const onsite = /\bon-?site\b/i.test(header)
  return remote && !onsite ? true : null
}

/**
 * HN separates paragraphs with a bare `<p>` and never closes it, which the markdown converter reads
 * as no break at all ("...Engineer<p>Acme is..." became "...EngineerAcme is..."). Every segment is
 * wrapped in a closed `<p>`...`</p>` pair so the paragraphs stay paragraphs.
 */
export const paragraphs = (html: string): string =>
  html
    .split(/<p>/i)
    .map((segment) => `<p>${segment}</p>`)
    .join('')

function mapItem(item: Item, config: Config) {
  const full = headerOf(item.text)
  const codePoints = [...full]
  const longHeader = codePoints.length > ORIGINAL_LIMITS.title
  const header = longHeader ? codePoints.slice(0, ORIGINAL_LIMITS.title).join('') : full
  const tags = [
    HN_TAG_EMPLOYER_UNVERIFIED,
    ...(isMultiRole(full) ? [HN_TAG_MULTI_ROLE] : []),
    ...(hasRoleSignal(full) ? [] : [HN_TAG_NO_ROLE_SIGNAL]),
    ...(longHeader ? [HN_TAG_LONG_HEADER] : []),
  ]
  return {
    namespace: config.namespace,
    nativeId: String(item.id),
    url: `${ITEM_LINK}?id=${item.id}`,
    identityParams: ['id'],
    title: header,
    companyName: `HN @${item.author}`,
    description: paragraphs(item.text),
    descriptionKind: 'html' as const,
    remote: remoteOf(full),
    tags,
    dates: [
      { raw: item.created_at, contract: 'ISO_ZONED' as const, semantics: 'PUBLISHED' as const },
    ],
  }
}

/** A tombstone: the comment is present but its text is null (deleted). */
const isTombstone = (child: unknown): boolean =>
  (child as { text?: unknown } | null | undefined)?.text === null

/**
 * The newest "Who is hiring?" story among the hits that is not older than the configured age at
 * `now`, or null. Chosen by title and author, newest by `created_at_i`; a hit that does not parse
 * is skipped, not fatal.
 */
export function currentThreadId(
  hits: readonly unknown[],
  now: Date,
  maxAgeDays: number,
): string | null {
  const stories = hits.flatMap((hit) => {
    const parsed = hitSchema.safeParse(hit)
    return parsed.success &&
      parsed.data.author === WHOISHIRING &&
      HIRING_TITLE.test(parsed.data.title)
      ? [parsed.data]
      : []
  })
  const newest = stories.reduce<(typeof stories)[number] | null>(
    (best, s) => (best === null || s.created_at_i > best.created_at_i ? s : best),
    null,
  )
  if (newest === null) return null
  return now.getTime() - newest.created_at_i * 1000 <= maxAgeDays * DAY_MS ? newest.objectID : null
}

export function hnSpec(now: Date, ageDays: number): ApiJsonSourceSpec<Config, Envelope, Item> {
  return {
    type: 'HN_HIRING',
    adapterVersion: HN_ADAPTER_VERSION,
    configSchema,
    envelopeSchema,
    itemSchema,
    pageRequest: (_config, at) => {
      if (at.cursor === null) {
        const url = new URL(SEARCH_URL)
        url.searchParams.set('tags', 'story,author_whoishiring')
        url.searchParams.set('hitsPerPage', String(SEARCH_HITS_PER_PAGE))
        return {
          request: { url: url.href, headers: { accept: 'application/json' } },
          cacheKey: 'search',
        }
      }
      const id = CURSOR.exec(at.cursor)?.[1]
      if (id === undefined) throw new Error('the thread cursor is not a story id')
      return {
        request: { url: `${ITEMS_URL}/${id}`, headers: { accept: 'application/json' } },
        cacheKey: 'thread',
      }
    },
    extractItems: (envelope) => (envelope.children ?? []).filter((c) => !isTombstone(c)),
    // Only a search body has hits, so the thread step (children, no hits) has no successor.
    nextCursor: (envelope) => {
      // Stryker disable next-line ArrayDeclaration: an absent hits array and an array holding one unparseable hit both select no thread, so the two are indistinguishable
      const id = currentThreadId(envelope.hits ?? [], now, ageDays)
      return id === null ? null : `story:${id}`
    },
    nativeIdOf: (item) => String(item.id),
    mapItem,
    scopeOf: (config) => ({
      namespace: config.namespace,
      query: HN_SCOPE_QUERY,
      configVersion: config.configVersion,
      window: null,
    }),
  }
}

export const hnHiringProvider = definePagedProvider(
  { type: 'HN_HIRING', configSchema },
  (config, ctx) =>
    collectJsonPages(
      {
        ...hnSpec(ctx.now(), config.maxThreadAgeDays),
        limits: { maxPages: HN_PAGES_PER_RUN, maxItemsPerPage: HN_MAX_COMMENTS },
      },
      config,
      ctx,
    ),
)
