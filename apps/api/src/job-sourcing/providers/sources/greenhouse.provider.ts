import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { type ApiJsonSourceSpec, defineApiJsonProvider } from '../api-json.provider'
import { atsBoardConfigSchema, GREENHOUSE_KIND, presentStrings } from './ats-config'
import { boundedString, dateRaw, optionalString, positiveSafeInt, urlString } from './as'

/**
 * Greenhouse Job Board API: `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`
 * (documented, unauthenticated: "Job Board data is publicly available";
 * https://docs.greenhouse.io/job-board.html). One board per config, one request per attempt.
 *
 * THE HOST IS THIS FILE'S. A config carries a board token and nothing that could name a host (see
 * `ats-config.ts`), so the only variable in the URL is a token that matched `[a-z0-9][a-z0-9_-]*`.
 *
 * LIST OR LIST+DETAIL: MEASURED (2026-10-24, three real boards, `content=true`), not assumed.
 *
 *   board        jobs   bytes      JSON nodes   parse     RSS delta
 *   airbnb        191   2.7 MB     -            -         -
 *   stripe        720   5.6 MB     69,266       41 ms     20 MB
 *   cloudflare    453   8.0 MB     28,539       51 ms     26 MB
 *
 * The same boards WITHOUT `content` are ~147 KB (airbnb), but they carry no description, so
 * list+detail would be 1 + N requests per board per cycle (N = 191..720) against a public API,
 * against ONE request here. One request it is, with the response cap raised from the 2 MiB default
 * to 10 MiB, the ceiling the plan sets for a per-source cap, because the measurement says the
 * default refuses every board measured. Cost of that: ~50 ms and <= 26 MB at the largest. A board
 * that outgrows 10 MiB fails as `PAYLOAD_TOO_LARGE` for THAT BOARD, loudly; list+detail is the
 * escape hatch for that day and is NOT built here.
 *
 * !! THE 10 MiB IS A DECLARATION, NOT A GUARANTEE. `FetchRequest.maxBytes` now exists and the
 * request carries this cap (a test pins it), and `http/bounded-fetch.ts` honours it in place of
 * its 2 MiB default. But a declared cap is only as good as the transport that enforces it and the
 * order in which the body is parsed relative to that cap; nothing in this file proves either, and
 * the transport is not wired to this adapter yet. See the entry in
 * `.claude/tasks/BACKLOG-followups.md` titled "An adapter's declared byte cap cannot reach the
 * transport, so a source whose pages exceed the transport's default is refused before its own cap
 * is consulted".
 *
 * - NAMESPACE `greenhouse:{token}`: a board is the scope, so the same job seen on two runs keeps
 *   one identity. `id` is the native id.
 * - IDENTITY-BEARING URL: `absolute_url` carries `gh_jid`, and on a company-hosted page
 *   (`https://stripe.com/jobs/search?gh_jid=...`) it is the ONLY thing in the URL that says which
 *   job it is. `identityParams: ['gh_jid']` keeps it through URL canonicalisation.
 * - DATES: `updated_at` is UPDATE evidence (`UPDATED`) and is never copied into `publishedAt`;
 *   `first_published` is the publication date. They differ for 712 of Stripe's 720 jobs.
 * - CONTENT is entity-escaped HTML ("automatically converted into corresponding HTML entities").
 *   It is decoded exactly ONCE (`decodeEscapedOnce`) into HTML and handed to the shared
 *   HTML->markdown converter, which owns sanitising. A body that was escaped twice by its author
 *   (a real Cloudflare job says `&amp;lt; 60% travel`) therefore ends as the text `&lt; 60%
 *   travel` inside the HTML, i.e. the visible words "< 60% travel", never as a stray `<`.
 * - EMPLOYER: the payload's own per-job `company_name` (undocumented in the list shape, present on
 *   1,364 of 1,364 jobs read), else the board config's verified `employer.name`, else none (the
 *   job is quarantined as `MISSING_COMPANY`). Never derived from the token.
 * - LOCATION is `location.name` as sent ("SF, NYC, Remote" style strings are kept whole); it says
 *   nothing about remote-ness, so `remote` is not set.
 */

export const GREENHOUSE_ADAPTER_VERSION = 'greenhouse-1'
const HOST = 'boards-api.greenhouse.io'

/**
 * The bounds this source runs under. `maxItemsPerPage` is the whole board (there is no pagination),
 * so it is sized from the measured maximum (720) with headroom; the byte cap binds first anyway.
 */
export const GREENHOUSE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxItemsPerPage: 2_000,
  maxPages: 1,
} as const

const configSchema = atsBoardConfigSchema(GREENHOUSE_KIND)
type Config = z.infer<typeof configSchema>

const named = z.object({ name: optionalString(200) })

const itemSchema = z.object({
  id: positiveSafeInt(),
  title: boundedString(ORIGINAL_LIMITS.title),
  absolute_url: urlString(),
  company_name: optionalString(ORIGINAL_LIMITS.companyName),
  location: named.nullish(),
  updated_at: dateRaw(),
  first_published: dateRaw(),
  content: optionalString(ORIGINAL_LIMITS.description),
  departments: z.array(named).max(50).nullish(),
})
type Item = z.infer<typeof itemSchema>

/** `jobs` stays OPAQUE so one bad job is isolated instead of failing the board. */
const envelopeSchema = z.object({ jobs: z.array(z.unknown()) })
type Envelope = z.infer<typeof envelopeSchema>

/**
 * Undo Greenhouse's own escaping, once. The five entities are the ones its escaper emits (measured:
 * `&lt; &gt; &quot; &#39; &amp;` are all there is across 3 boards). `&amp;` goes LAST: decoded
 * earlier, the `&lt;` that `&amp;lt;` becomes would be decoded again by the next step, which is
 * exactly the double decode this function exists to avoid.
 */
export function decodeEscapedOnce(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The payload's own employer name when it says one (a blank one says nothing), else the verified config's, else none. */
function employerOf(item: Item, config: Config): string | null {
  const fromPayload = item.company_name?.trim() ?? ''
  return fromPayload === '' ? (config.employer?.name ?? null) : fromPayload
}

export const greenhouseSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'GREENHOUSE_ATS',
  adapterVersion: GREENHOUSE_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  limits: GREENHOUSE_LIMITS,
  pageRequest: (config: Config) => ({
    request: {
      url: `https://${HOST}/v1/boards/${config.board}/jobs?content=true`,
      headers: { accept: 'application/json' },
    },
    cacheKey: 'board',
  }),
  extractItems: (envelope) => envelope.jobs,
  nextCursor: () => null,
  nativeIdOf: (item) => String(item.id),
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: String(item.id),
    url: item.absolute_url,
    identityParams: ['gh_jid'],
    title: item.title,
    companyName: employerOf(item, config),
    location: item.location?.name ?? null,
    description: item.content === null ? null : decodeEscapedOnce(item.content),
    tags: presentStrings(item.departments?.map((d) => d.name)),
    dates: [
      { raw: item.first_published, contract: 'ISO_ZONED', semantics: 'PUBLISHED' },
      { raw: item.updated_at, contract: 'ISO_ZONED', semantics: 'UPDATED' },
    ],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: null,
    configVersion: config.configVersion,
    window: null,
  }),
}

export const greenhouseProvider = defineApiJsonProvider(greenhouseSpec)
