import { z } from 'zod'
import { DEFAULT_MAX_BYTES } from '../../http/bounded-fetch'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
} from '../api-json.provider'
import { boundedString, dateRaw, optionalString, optionalUrlString, urlString } from './as'
/**
 * JobTech (`https://jobsearch.api.jobtechdev.se/search`), the Swedish public employment service's
 * open job search. A DOCUMENTED PUBLIC API: keyless, and the documentation states that the ads are
 * licensed under CC0. robots.txt answers 404, so no path is disallowed. One plain GET a page with the
 * project's identifying User-Agent (set by the transport, never here); a 403, a 429 or a challenge
 * ends the run.
 *
 * MEASURED 2026-11-24 (`__fixtures__/jobtech/jobs-data-it.json`, provenance beside it):
 *  - An envelope `{ total: { value }, hits }`. Paging is by `offset` in steps of the page size; the
 *    next page is requested while `total.value` is above the offset reached, up to `maxPages`.
 *    The API caps `offset` at 2000 and `limit` at 100; the adapter asks for 50 and stops well short.
 *  - `occupation-field=apaJ_2ja_LuF` is the Data/IT field of the taxonomy. It is a server-side filter,
 *    and it is the SCOPE marker, so a clean run is a WINDOW over the newest ads in that field.
 *  - `publication_date` carries NO zone offset (`2026-11-24T18:20:01`). It is kept raw and the
 *    normalizer reports `MISSING_ZONE`, so no instant is invented for it.
 *  - The response has no remote field, so remoteness is unknown; no tags are read.
 *  - Structured contact fields are NOT read: `application_contacts` and the employer's e-mail and
 *    telephone fields are left out of the schema. The free-text description IS stored, and an ad may
 *    put contact details in it; no contact is extracted from the text.
 */
export const JOBTECH_SOURCE_STATUS = {
  blocked: false,
  permission: 'PUBLIC_API_DOCUMENTED',
  reason:
    'keyless public search API of Arbetsförmedlingen; ads licensed CC0 per the API documentation; robots.txt answers 404; Data/IT occupation field only',
} as const

export const JOBTECH_ADAPTER_VERSION = 'jobtech-1'
export const JOBTECH_ENDPOINT = 'https://jobsearch.api.jobtechdev.se/search'
/** One global feed: the namespace is a constant, because an empty one is refused by identity. */
export const JOBTECH_NAMESPACE = 'jobtech'
/** The taxonomy concept id of the Data/IT occupation field (the `/taxonomy` capture, 2026-11-24). */
export const JOBTECH_OCCUPATION_FIELD = 'apaJ_2ja_LuF'
/** The scope marker that makes a clean run WINDOW, not inventory. */
export const JOBTECH_SCOPE_QUERY = `occupation-field:${JOBTECH_OCCUPATION_FIELD}`
const PAGE_SIZE = 50
export const JOBTECH_MAX_PAGES_DEFAULT = 4
const JOBTECH_MAX_PAGES_CEILING = 20

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(JOBTECH_NAMESPACE).default(JOBTECH_NAMESPACE),
    maxPages: z
      .number()
      .int()
      .min(1)
      .max(JOBTECH_MAX_PAGES_CEILING)
      .default(JOBTECH_MAX_PAGES_DEFAULT),
  })
  .strict()
  .refine((c) => c.query === null, {
    message: 'JobTech has no search here; the occupation field is the scope',
  })
  .refine((c) => c.window === null, { message: 'JobTech has no date window here' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: boundedString(64).min(1),
  headline: boundedString(ORIGINAL_LIMITS.title),
  webpage_url: urlString(),
  description: z
    .object({ text: optionalString(ORIGINAL_LIMITS.description) })
    .nullish()
    .transform((v) => v?.text ?? null),
  employer: z
    .object({ name: optionalString(ORIGINAL_LIMITS.companyName) })
    .nullish()
    .transform((v) => v?.name ?? null),
  // The city when stated, else the municipality (which is what the API gives for some ads).
  workplace_address: z
    .object({ city: optionalString(200), municipality: optionalString(200) })
    .nullish()
    .transform((v) => v?.city ?? v?.municipality ?? null),
  application_details: z
    .object({ url: optionalUrlString() })
    .nullish()
    .transform((v) => v?.url ?? null),
  publication_date: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

/** `hits` stays OPAQUE so one bad ad is isolated instead of failing the page. */
const envelopeSchema = z.object({
  total: z.object({ value: z.number().int().min(0) }),
  hits: z.array(z.unknown()),
})
type Envelope = z.infer<typeof envelopeSchema>

export const jobTechSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'JOBTECH_API',
  adapterVersion: JOBTECH_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: (_config, at) => {
    const url = new URL(JOBTECH_ENDPOINT)
    url.searchParams.set('occupation-field', JOBTECH_OCCUPATION_FIELD)
    url.searchParams.set('sort', 'pubdate-desc')
    url.searchParams.set('limit', String(PAGE_SIZE))
    url.searchParams.set('offset', String((at.page - 1) * PAGE_SIZE))
    return { request: { url: url.href, headers: { accept: 'application/json' } } }
  },
  extractItems: (envelope) => envelope.hits,
  // `total` and the hits on the page are the only things read to decide on another page.
  nextCursor: (envelope, at) =>
    envelope.hits.length > 0 && envelope.total.value > at.page * PAGE_SIZE
      ? `page:${at.page + 1}`
      : null,
  nativeIdOf: (item) => item.id,
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: item.id,
    url: item.webpage_url,
    title: item.headline,
    companyName: item.employer,
    location: item.workplace_address,
    description: item.description,
    // The API carries no remote field, so remoteness is not guessed from the text.
    remote: null,
    tags: [],
    applicationUrl: item.application_details,
    dates: [{ raw: item.publication_date, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: JOBTECH_SCOPE_QUERY,
    configVersion: config.configVersion,
    window: null,
  }),
}

// Fifty ads a page is about 0.6 MB at the sizes measured; the transport cap is the default 2 MiB.
export const jobTechProvider = definePagedProvider(jobTechSpec, (config, ctx) =>
  collectJsonPages(
    {
      ...jobTechSpec,
      limits: {
        maxBytes: DEFAULT_MAX_BYTES,
        maxPages: config.maxPages,
        maxItemsPerPage: PAGE_SIZE,
      },
    },
    config,
    ctx,
  ),
)
