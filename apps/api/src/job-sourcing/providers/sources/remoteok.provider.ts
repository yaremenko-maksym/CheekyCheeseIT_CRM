import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  defineApiJsonProvider,
} from '../api-json.provider'
import {
  boundedString,
  boundedStringArray,
  dateRaw,
  optionalString,
  optionalUrlString,
  urlString,
} from './as'

/**
 * RemoteOK (`https://remoteok.com/api`), one request, no pagination.
 *
 * The response is a bare JSON ARRAY whose first element is a legal / metadata object (the API
 * terms: link back to the Remote OK URL with follow, mention Remote OK as the source). It is
 * recognised by SHAPE - an object with a string `legal` and no `id` - and not by index, because
 * nothing documents that it stays first. The attribution obligation is a display-time duty and
 * lives in the fixture's provenance notes; an observation has no slot for it.
 *
 * COVERAGE: the API serves only the latest ~100 jobs and documents no window, so a clean run must
 * not claim FULL_INVENTORY. `scopeOf` therefore reports a non-null `query` marker, which is the
 * loop's mechanism for "a slice, not the inventory" (`deriveCoverage` -> WINDOW).
 */

export const REMOTEOK_ADAPTER_VERSION = 'remoteok-1'
export const REMOTEOK_ENDPOINT = 'https://remoteok.com/api'
/** The scope marker that makes a clean run WINDOW rather than FULL_INVENTORY. */
export const REMOTEOK_SCOPE_QUERY = 'latest-feed'
/** Observed 100 elements; a page past 250 is the provider ignoring the shape we know. */
const MAX_ITEMS = 250

/** One global board: the namespace is a constant, because an empty one is refused by identity. */
export const REMOTEOK_NAMESPACE = 'remoteok'

const configSchema = baseSourceConfigSchema
  .extend({ namespace: z.literal(REMOTEOK_NAMESPACE).default(REMOTEOK_NAMESPACE) })
  .strict()
  .refine((c) => c.query === null, { message: 'RemoteOK has no search parameter' })
  .refine((c) => c.window === null, { message: 'RemoteOK has no date window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: boundedString(100).min(1),
  url: urlString(),
  apply_url: optionalUrlString(),
  position: boundedString(ORIGINAL_LIMITS.title),
  company: boundedString(ORIGINAL_LIMITS.companyName),
  location: optionalString(ORIGINAL_LIMITS.location),
  description: optionalString(ORIGINAL_LIMITS.description),
  tags: boundedStringArray(ORIGINAL_LIMITS.tags, ORIGINAL_LIMITS.tag)
    .nullish()
    .transform((v) => v ?? []),
  date: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

const envelopeSchema = z.array(z.unknown())
type Envelope = z.infer<typeof envelopeSchema>

/** The legal / metadata object: has a string `legal`, and no `id` (a job always has one). */
export function isRemoteokLegalNotice(element: unknown): boolean {
  if (typeof element !== 'object' || element === null || Array.isArray(element)) return false
  const record = element as Record<string, unknown>
  return typeof record['legal'] === 'string' && !('id' in record)
}

export const remoteokSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'REMOTEOK_API',
  adapterVersion: REMOTEOK_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: () => ({
    request: { url: REMOTEOK_ENDPOINT, headers: { accept: 'application/json' } },
    cacheKey: 'feed',
  }),
  extractItems: (envelope) => envelope.filter((element) => !isRemoteokLegalNotice(element)),
  nextCursor: () => null,
  nativeIdOf: (item) => item.id,
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: item.id,
    url: item.url,
    title: item.position,
    companyName: item.company,
    location: item.location,
    description: item.description,
    descriptionKind: 'html',
    // A remote-only board: every posting is remote by the site's definition.
    remote: true,
    tags: item.tags,
    applicationUrl: item.apply_url,
    dates:
      item.date === null ? [] : [{ raw: item.date, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: REMOTEOK_SCOPE_QUERY,
    configVersion: config.configVersion,
    window: null,
  }),
  limits: { maxPages: 1, maxItemsPerPage: MAX_ITEMS },
}

export const remoteokProvider = defineApiJsonProvider(remoteokSpec)
