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
  positiveSafeInt,
  urlString,
} from './as'

/**
 * Remotive (`https://remotive.com/api/remote-jobs?category=<slug>`), one request per category.
 *
 * - NAMESPACE is the constant `remotive`, not the category: a category is a filter, not a board,
 *   so one posting listed under two categories keeps ONE identity.
 * - GEOGRAPHY (`candidate_required_location`) is the observation's `location`; `remote` is set
 *   true separately because Remotive lists only remote jobs. The two are different facts.
 * - COVERAGE is WINDOW, never FULL_INVENTORY: the live `category=software-dev` response was
 *   observed to contain Marketing / Sales / Writing jobs, so the filter does not partition the
 *   inventory, and a clean run cannot claim it saw a category completely.
 * - DATES: `publication_date` carries no zone designator and the docs name none. The date policy
 *   reports MISSING_ZONE (raw kept, no instant) rather than guess one.
 * - Terms (provenance notes): link back and name Remotive as the source; jobs are delayed 24 h;
 *   a few requests a day suffice. A source URL is therefore kept as the posting URL and no
 *   separate application URL exists.
 */

export const REMOTIVE_ADAPTER_VERSION = 'remotive-1'
export const REMOTIVE_NAMESPACE = 'remotive'
const ENDPOINT = 'https://remotive.com/api/remote-jobs'
export const REMOTIVE_CATEGORY_MAX_CHARS = 50

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(REMOTIVE_NAMESPACE).default(REMOTIVE_NAMESPACE),
    category: z
      .string()
      .min(1)
      .max(REMOTIVE_CATEGORY_MAX_CHARS)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a lowercase slug'),
  })
  .strict()
  .refine((c) => c.query === null, {
    message: 'Remotive search is not used; the category is the scope',
  })
  .refine((c) => c.window === null, { message: 'Remotive has no date window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: positiveSafeInt(),
  url: urlString(),
  title: boundedString(ORIGINAL_LIMITS.title),
  company_name: boundedString(ORIGINAL_LIMITS.companyName),
  job_type: optionalString(100),
  candidate_required_location: optionalString(ORIGINAL_LIMITS.location),
  description: optionalString(ORIGINAL_LIMITS.description),
  tags: boundedStringArray(ORIGINAL_LIMITS.tags, ORIGINAL_LIMITS.tag)
    .nullish()
    .transform((v) => v ?? []),
  publication_date: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

/** `jobs` stays OPAQUE so one bad job is isolated instead of failing the page. */
const envelopeSchema = z.object({ jobs: z.array(z.unknown()) })
type Envelope = z.infer<typeof envelopeSchema>

export const remotiveSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'REMOTIVE_API',
  adapterVersion: REMOTIVE_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: (config) => {
    const url = new URL(ENDPOINT)
    url.searchParams.set('category', config.category)
    return {
      request: { url: url.href, headers: { accept: 'application/json' } },
      cacheKey: 'category',
    }
  },
  extractItems: (envelope) => envelope.jobs,
  nextCursor: () => null,
  nativeIdOf: (item) => String(item.id),
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: String(item.id),
    url: item.url,
    title: item.title,
    companyName: item.company_name,
    location: item.candidate_required_location,
    description: item.description,
    descriptionKind: 'html',
    remote: true,
    employmentType: item.job_type,
    tags: item.tags,
    dates:
      item.publication_date === null
        ? []
        : [{ raw: item.publication_date, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: `category:${config.category}`,
    configVersion: config.configVersion,
    window: null,
  }),
  limits: { maxPages: 1 },
}

export const remotiveProvider = defineApiJsonProvider(remotiveSpec)
