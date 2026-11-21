import { z } from 'zod'
import { ALLOWLISTED_MAX_RESPONSE_BYTES_CEILING } from '../../http/bounded-fetch'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
} from '../api-json.provider'
import { boundedString, dateRaw, optionalString, optionalStringArray, urlString } from './as'

/**
 * Arbeitnow (`https://www.arbeitnow.com/api/job-board-api?page=n`), page-number pagination.
 *
 * PERMITTED (terms section 11) and runnable under a DECLARED PER-SOURCE BYTE CAP. The feed does
 * not fit the shared 2 MiB default: live page 1 measured 4 209 793 bytes DECODED initially and
 * 9 569 670 on 2026-11-19 (300 items each). The page size cannot be chosen (`per_page`, `limit`,
 * `page_size`, `size` and `perPage` were all tried and all returned the same ~1.83 MB gzip body)
 * (UNVERIFIABLE FROM THIS REPOSITORY: those five responses were not kept) and there is no field
 * selection, so every page is downloaded in full; the adapter keeps only the normalised fields
 * (`itemSchema`) and retains nothing else past the parse. The newest items sit on the big pages.
 *
 * Owner decision 2026-10-24: no block on response size (8 MiB cap); raised on 2026-11-19 to 10 MiB
 * after page 1 measured 9 569 670 bytes; raised on 2026-11-20 (owner decision in chat: "Limit 24 MiB
 * + alert") to `ARBEITNOW_MAX_BYTES` (24 MiB = 25 165 824 bytes, ALLOWLISTED_MAX_RESPONSE_BYTES_CEILING).
 * Headroom is substantial (~15.6 MB over the 9 569 670 bytes measured on 2026-11-19). Early warning at
 * >= 80% (20 132 660 bytes): every page at or past it is logged at the fetch (`logger.warn` in
 * `collectPages`, the exact per-page signal); and a run whose AVERAGE page (`bytes_read / request_count`)
 * is past it turns the health status DEGRADED / PAYLOAD_GROWTH, which alerts ADMINs (in-app + e-mail,
 * the SCHEMA_DRIFT channel). The average misses one large page among small ones (no per-page column
 * yet, backlog). ONE setting lifts BOTH refusals that applied:
 * `collectJsonPages` copies `limits.maxBytes` into the request (`FetchRequest.maxBytes`, honoured by the
 * transport in place of its 2 MiB default) AND into `parseBoundedJson` (the decoded-text bound).
 * The shared ceiling (`MAX_RESPONSE_BYTES_CEILING`, 10 MiB) is kept for non-allowlisted sources; Arbeitnow
 * is allow-listed for 24 MiB. A page past 24 MiB still fails as `PAYLOAD_TOO_LARGE`: the cap is a real bound.
 *
 * !! THE CAP IS A DECLARATION, NOT A GUARANTEE (see the Greenhouse adapter's note and the backlog
 * entry on declared byte caps reaching the transport): this file proves the request carries it.
 *
 * - IDENTITY is the `slug` (unique within every page measured, 300 of 300). The provider issues no
 *   numeric id.
 * - `created_at` is Unix SECONDS (1792799718 is 2026-10-23T23:55:18Z), mapped as PUBLISHED.
 * - `remote` is passed through as the provider sent it, `false` included. 4 of the 14 captured
 *   `remote: false` titles say "Remote" ("Security Engineer (Full Remote - Netherlands)"), so
 *   `false` is the provider's flag, not an inference, and it is never coerced to "unknown" or
 *   corrected from the title. An ABSENT flag is unknown (`null`), which is a different thing.
 * - DESCRIPTION is HTML, but a minority of postings arrive entity-escaped (`&lt;p&gt;`). Those
 *   are unescaped once so they are not shown as literal tags.
 * - COVERAGE is WINDOW, never FULL_INVENTORY. Completeness could not be verified: `links.last` is
 *   always null (no total), `meta.from` jumps (page 2 reports `from: 101`) so pages are not a
 *   stable partition of a feed that is re-ordered hourly, and pages 40 and 100 are empty while 20
 *   is not, so the real depth is unknown. A new posting shifts every later page.
 * - Terms: link back to Arbeitnow.com; the permission may be revoked at any time.
 */

export const ARBEITNOW_SOURCE_STATUS = {
  blocked: false,
  permission: 'PUBLIC_API_DOCUMENTED',
  // Stryker disable next-line StringLiteral: status description text only; manifest permission tests assert blocked and permission fields
  reason:
    'permitted by the documented API terms; pages are large (page 1 was 4209793 bytes decoded on 2026-10-24 and 9569670 on 2026-11-19) and are read under the declared per-source cap of 25165824 bytes (24 MiB, owner decision 2026-11-20) with an 80% early warning threshold',
} as const

/**
 * 24 MiB, using ALLOWLISTED_MAX_RESPONSE_BYTES_CEILING: owner decision 2026-11-20 ("Limit 24 MiB + alert").
 * Page 1 grew past the earlier 8 MiB cap (9 569 670 bytes decoded on 2026-11-19, 300 items, one plain GET;
 * UNVERIFIABLE FROM THIS REPOSITORY: that body was not kept), which failed every run with PAYLOAD_TOO_LARGE.
 * Raising to the 10 MiB shared ceiling left only 916 090 bytes (~8.7%) headroom. Under the 24 MiB cap,
 * headroom is ~15.6 MB, and an early warning at >= 80% (20 132 660 bytes) signals before the cap fails.
 * A page past 24 MiB fails as PAYLOAD_TOO_LARGE, the declared bound.
 */
export const ARBEITNOW_MAX_BYTES = ALLOWLISTED_MAX_RESPONSE_BYTES_CEILING

export const ARBEITNOW_ADAPTER_VERSION = 'arbeitnow-1'
export const ARBEITNOW_NAMESPACE = 'arbeitnow'
export const ARBEITNOW_SCOPE_QUERY = 'job-board-feed'
const ENDPOINT = 'https://www.arbeitnow.com/api/job-board-api'
/** Longest page observed (pages 1 and 2 held 300 jobs). More is drift, not something to cut. */
export const ARBEITNOW_MAX_PAGE_ITEMS = 300
export const ARBEITNOW_MAX_PAGES_CEILING = 10

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(ARBEITNOW_NAMESPACE).default(ARBEITNOW_NAMESPACE),
    maxPages: z.number().int().min(1).max(ARBEITNOW_MAX_PAGES_CEILING).default(5),
  })
  .strict()
  .refine((c) => c.query === null, { message: 'Arbeitnow has no search; the feed is the scope' })
  .refine((c) => c.window === null, { message: 'Arbeitnow has no date window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  slug: boundedString(500).min(1),
  url: urlString(),
  title: boundedString(ORIGINAL_LIMITS.title),
  company_name: boundedString(ORIGINAL_LIMITS.companyName),
  description: optionalString(ORIGINAL_LIMITS.description),
  remote: z
    .boolean()
    .nullish()
    .transform((v) => v ?? null),
  location: optionalString(ORIGINAL_LIMITS.location),
  tags: optionalStringArray(ORIGINAL_LIMITS.tags, ORIGINAL_LIMITS.tag),
  job_types: optionalStringArray(ORIGINAL_LIMITS.tags, ORIGINAL_LIMITS.tag),
  created_at: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

/** `data` stays OPAQUE so one bad job is isolated instead of failing the page. */
const envelopeSchema = z.object({
  data: z.array(z.unknown()),
  links: z.object({ next: z.string().nullish() }).optional(),
})
type Envelope = z.infer<typeof envelopeSchema>

/**
 * A description that BEGINS with an escaped tag is entity-escaped markup and is unescaped ONCE;
 * one that begins with anything else is left alone.
 *
 * Measured on the capture: the first job's body is `&lt;p&gt;...` followed by a REAL
 * `<p>Find <a href=...>Jobs in Germany</a> on Arbeitnow</a>` footer (the link back its terms ask
 * for), and its non-breaking spaces are double-escaped (`&amp;nbsp;`), so `&amp;` is undone too.
 * The other captured descriptions begin with a real tag (`<h2>`, `<p>`).
 */
function unescapeMarkup(description: string | null): string | null {
  if (description === null || !description.startsWith('&lt;')) return description
  return description.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

function mapItem(item: Item, config: Config) {
  return {
    namespace: config.namespace,
    nativeId: item.slug,
    url: item.url,
    title: item.title,
    companyName: item.company_name,
    location: item.location,
    description: unescapeMarkup(item.description),
    descriptionKind: 'html' as const,
    remote: item.remote,
    // The provider's contract/seniority words are localized free text, not an employment-type enum.
    tags: [...new Set([...item.tags, ...item.job_types])],
    dates: [
      { raw: item.created_at, contract: 'UNIX_SECONDS' as const, semantics: 'PUBLISHED' as const },
    ],
  }
}

export const arbeitnowSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'ARBEITNOW_API',
  adapterVersion: ARBEITNOW_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: (_config, at) => {
    const url = new URL(ENDPOINT)
    url.searchParams.set('page', String(at.page))
    return { request: { url: url.href, headers: { accept: 'application/json' } } }
  },
  extractItems: (envelope) => envelope.data,
  // The next-link is never followed as a URL; its presence is the only thing read from it.
  nextCursor: (envelope, at) => {
    const next = envelope.links?.next
    return next && envelope.data.length > 0 ? `page:${at.page + 1}` : null
  },
  nativeIdOf: (item) => item.slug,
  mapItem,
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: ARBEITNOW_SCOPE_QUERY,
    configVersion: config.configVersion,
    window: null,
  }),
}

export const arbeitnowProvider = definePagedProvider(arbeitnowSpec, (config, ctx) =>
  collectJsonPages(
    {
      ...arbeitnowSpec,
      limits: {
        maxBytes: ARBEITNOW_MAX_BYTES,
        maxPages: config.maxPages,
        maxItemsPerPage: ARBEITNOW_MAX_PAGE_ITEMS,
      },
    },
    config,
    ctx,
  ),
)
