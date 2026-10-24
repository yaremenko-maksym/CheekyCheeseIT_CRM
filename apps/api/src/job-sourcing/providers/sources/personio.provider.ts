import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { type XmlDocument, type XmlElementNode } from '../../xml'
import { findChild, findChildren } from '../../xml/xml-tree'
import { baseSourceConfigSchema } from '../api-json.provider'
import {
  atsBoardFields,
  atsBoardGroupOf,
  constrainAtsBoardConfig,
  nonBlank,
  PERSONIO_KIND,
  presentStrings,
} from './ats-config'
import { defineXmlProvider, type XmlSourceSpec } from '../xml-source.provider'
import { boundedString, dateRaw, optionalString } from './as'

/**
 * Personio's XML job feed: `GET https://{company}.jobs.personio.de/xml?language={code}`
 * (https://developer.personio.de/docs/integration-of-open-positions). Measurements, captures,
 * robots and terms verdicts: `__fixtures__/personio/*.provenance.json` (2026-10-24). It is built on
 * the XML binding from Task 2.4 (`defineXmlProvider`): nothing here parses XML, decodes a charset or
 * touches a DOCTYPE. The port refuses a `<!DOCTYPE>` outright (so there is no entity expansion, no
 * external entity and no XXE to defend against in this file), enforces its byte / depth / element /
 * time bounds before parsing, and hands over a namespace-resolved tree; this file reads elements
 * out of that tree and nothing else.
 *
 * THE COMPANY IS PART OF THE HOST. `board` is one DNS label (`ats-config.ts`), the config is
 * `.strict()`, and the only other host choice is `tld`, a closed set (`de` | `com`).
 *
 * TWO HOSTS, ONE DATA SET. `.jobs.personio.de` and `.jobs.personio.com` returned byte-identical
 * documents (equal sha256) for both tenants tried, so `tld` selects an address and is NOT part of
 * the namespace: switching it does not re-identify a single vacancy, and a group that lists one
 * company twice, under either host, is refused as a duplicate board.
 *
 * LANGUAGE IS CONFIG, AND IT CHANGES THE TEXT, NOT THE IDENTITY. `language` is required (no
 * default: a default would be a silent choice of which text every vacancy carries) and is one of
 * the seven codes the documentation lists. Measured on Westwing: `language=de` and `language=en`
 * carry the SAME 61 positions with the SAME ids, but the German document has no job descriptions;
 * an unsupported code (`xx`) is not an error, it answers the German document. The namespace has no
 * language, so a source moved from `en` to `de` updates its vacancies instead of creating a second
 * set. The posting URL carries no language (the observation builder drops query parameters that do
 * not identify a posting), so the same vacancy has the same URL in every language.
 *
 * PER-TENANT ENABLEMENT. The feed exists only for a company that switched it on (Settings >
 * Recruiting > Career page), and from outside "switched off" and "no such company" are the same
 * HTTP 404 with an HTML page. Both are `BOARD_NOT_FOUND` for THAT board (`boardVerdictOf`), never a
 * source outage, and the verified `employer` evidence in the config is how a board entered the
 * manifest at all. Whether a disabled feed ever answers anything other than 404 was not observed.
 *
 * - NATIVE IDENTITY is `<position><id>` (a number, up to 18 digits: it goes into the posting URL's
 *   path, so nothing else is accepted).
 * - NO POSTING URL IS IN THE FEED. The posting page is built as
 *   `https://{company}.jobs.personio.{tld}/job/{id}` from the verified config and
 *   the position id: measured for Westwing (HTTP 200, canonical URL exactly that form). The pattern
 *   did NOT resolve for the `personio` company's own position (404), so it is a convention
 *   verified on one tenant, and the apply link is not offered.
 * - EMPLOYER: `<subcompany>` (the legal entity, on 61 of 61 positions), else the config's
 *   verified `employer`, else none (quarantined). Never derived from the company slug.
 * - LOCATION: `<office>` then each `<additionalOffices><office>`, de-duplicated, joined "; ".
 * - BODY: each `<jobDescription>` becomes its `<name>` as a heading followed by its CDATA `<value>`
 *   HTML. The heading is escaped text; the value is handed to the shared converter, which sanitises.
 * - `employmentType` is `<employmentType>` as sent (`permanent`, `intern`, ...), `seniorityHint`
 *   `<seniority>`, and the tags are the department, the recruiting category and the comma-separated
 *   `<keywords>`. `remote` is not set: the feed does not say.
 * - DATES: `<createdAt>` is the only date and is read as `PUBLISHED`, for want of another (the same
 *   decision as Ashby's `publishedAt`): it is the creation of the position, which can precede its
 *   publication.
 */

export const PERSONIO_ADAPTER_VERSION = 'personio-1'

export const PERSONIO_LANGUAGES = ['de', 'en', 'fr', 'es', 'nl', 'it', 'pt'] as const
export const PERSONIO_TLDS = ['de', 'com'] as const

const personioExtraFields = {
  language: z.enum(PERSONIO_LANGUAGES),
  tld: z.enum(PERSONIO_TLDS).default('de'),
}

const configSchema = constrainAtsBoardConfig(
  PERSONIO_KIND,
  baseSourceConfigSchema
    .extend({ ...atsBoardFields(PERSONIO_KIND), ...personioExtraFields })
    .strict(),
)
type Config = z.infer<typeof configSchema>

/** One company as a manifest group lists it. */
export const personioBoardEntrySchema = z
  .object({ ...atsBoardFields(PERSONIO_KIND), ...personioExtraFields })
  .strict()
export const personioBoardGroupSchema = atsBoardGroupOf(PERSONIO_KIND, personioBoardEntrySchema)

const POSITION_ID = /^\d{1,18}$/

const itemSchema = z.object({
  id: z.string().regex(POSITION_ID),
  name: boundedString(ORIGINAL_LIMITS.title).min(1),
  subcompany: optionalString(ORIGINAL_LIMITS.companyName),
  office: optionalString(ORIGINAL_LIMITS.location),
  additionalOffices: z.array(z.string().max(ORIGINAL_LIMITS.location)).max(100),
  department: optionalString(200),
  recruitingCategory: optionalString(200),
  employmentType: optionalString(100),
  seniority: optionalString(100),
  keywords: optionalString(2_000),
  descriptions: z
    .array(
      z.object({ name: optionalString(500), value: optionalString(ORIGINAL_LIMITS.description) }),
    )
    .max(100),
  createdAt: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

const textOf = (parent: XmlElementNode, name: string): string | undefined =>
  findChild(parent, name)?.text.trim()

/** The root element must be the feed's own; anything else is not this feed (drift). */
function positionsOf(document: XmlDocument): readonly XmlElementNode[] {
  if (document.root.localName !== 'workzag-jobs') {
    throw new Error(`the feed's root element is <${document.root.localName}>, not <workzag-jobs>`)
  }
  return findChildren(document.root, 'position')
}

/** A position as a plain record. Total: a missing element is `undefined`, judged by `itemSchema`. */
function recordOf(position: XmlElementNode): Record<string, unknown> {
  const offices = findChild(position, 'additionalOffices')
  const descriptions = findChild(position, 'jobDescriptions')
  return {
    id: textOf(position, 'id'),
    name: textOf(position, 'name'),
    subcompany: textOf(position, 'subcompany'),
    office: textOf(position, 'office'),
    additionalOffices:
      offices === undefined ? [] : findChildren(offices, 'office').map((o) => o.text.trim()),
    department: textOf(position, 'department'),
    recruitingCategory: textOf(position, 'recruitingCategory'),
    employmentType: textOf(position, 'employmentType'),
    seniority: textOf(position, 'seniority'),
    keywords: textOf(position, 'keywords'),
    descriptions:
      descriptions === undefined
        ? []
        : findChildren(descriptions, 'jobDescription').map((d) => ({
            name: textOf(d, 'name'),
            value: findChild(d, 'value')?.text,
          })),
    createdAt: textOf(position, 'createdAt'),
  }
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function bodyHtml(item: Item): string {
  return item.descriptions
    .map((d) => `${d.name === null ? '' : `<h3>${escapeHtml(d.name)}</h3>`}${d.value ?? ''}`)
    .join('')
}

function locationOf(item: Item): string | null {
  const places = [
    ...new Set(presentStrings([nonBlank(item.office), ...item.additionalOffices.map(nonBlank)])),
  ]
  return places.length === 0 ? null : places.join('; ')
}

export const personioSpec: XmlSourceSpec<Config, Item> = {
  type: 'PERSONIO_ATS',
  adapterVersion: PERSONIO_ADAPTER_VERSION,
  configSchema,
  itemSchema,
  pageRequest: (config) => ({
    request: {
      url: `https://${config.board}.jobs.personio.${config.tld}/xml?language=${config.language}`,
      headers: { accept: 'application/xml' },
    },
    cacheKey: 'xml',
  }),
  extractItems: (document) => positionsOf(document).map(recordOf),
  nextCursor: () => null,
  nativeIdOf: (item) => item.id,
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: item.id,
    url: `https://${config.board}.jobs.personio.${config.tld}/job/${item.id}`,
    title: item.name,
    companyName: nonBlank(item.subcompany) ?? config.employer?.name ?? null,
    location: locationOf(item),
    description: bodyHtml(item),
    employmentType: nonBlank(item.employmentType),
    seniorityHint: nonBlank(item.seniority),
    tags: [
      ...new Set(
        presentStrings([
          nonBlank(item.department),
          nonBlank(item.recruitingCategory),
          ...(item.keywords ?? '').split(',').map(nonBlank),
        ]),
      ),
    ],
    dates: [{ raw: item.createdAt, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: null,
    configVersion: config.configVersion,
    window: null,
  }),
}

export const personioProvider = defineXmlProvider(personioSpec)
