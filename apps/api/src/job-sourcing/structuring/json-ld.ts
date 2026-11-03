import { parseBoundedJson } from '../providers/bounded-json'
import { parseSourceDate, type ObservedDate } from '../normalize/date-policy'

/**
 * Pure extractor of schema.org `JobPosting` objects from a detail page's JSON-LD (Task 5.7a).
 *
 * Input is untrusted HTML. This module performs no I/O: it never executes script, never fetches
 * and never resolves `@context` (the context is not read at all). Every bound is a COUNTED failure
 * in the result, never a throw, and a failing script never affects its neighbours.
 *
 * HTML rule that shapes the scan: a literal `</script` inside a JSON string TERMINATES the element
 * (the HTML parser does not know about JSON strings). The truncated text is then malformed JSON and
 * is counted as such. The escaped forms (`<\/script>`, `<`) are plain JSON escapes, decoded by
 * `JSON.parse` AFTER the bounded pre-scan.
 */

export interface JsonLdLimits {
  /** UTF-8 bytes of the whole page. */
  maxHtmlBytes: number
  /** JSON-LD script elements examined; the rest of the page is not scanned. */
  maxScripts: number
  /** UTF-8 bytes of one script body. */
  maxScriptBytes: number
  /** Nesting depth of one script (see `JsonLimits`). */
  maxDepth: number
  /** Nodes of one script. */
  maxNodes: number
  /** Nodes walked over the whole page. */
  maxTotalNodes: number
  maxFieldChars: number
  maxDescriptionChars: number
}

export const DEFAULT_JSON_LD_LIMITS: JsonLdLimits = {
  maxHtmlBytes: 2 * 1024 * 1024,
  maxScripts: 20,
  maxScriptBytes: 512 * 1024,
  maxDepth: 32,
  maxNodes: 20_000,
  maxTotalNodes: 50_000,
  maxFieldChars: 1_000,
  maxDescriptionChars: 100_000,
}

export type JsonLdFailureCode =
  | 'HTML_TOO_LARGE'
  | 'TOO_MANY_SCRIPTS'
  | 'UNTERMINATED_SCRIPT'
  | 'UNTERMINATED_OPEN_TAG'
  | 'MALFORMED_JSON'
  | 'SCRIPT_TOO_LARGE'
  | 'TOO_DEEP'
  | 'TOO_MANY_NODES'
  | 'TOTAL_NODES_EXCEEDED'
  | 'FIELD_TOO_LONG'
  | 'FIELD_INVALID'

/** A field that WAS present in the source but could not be normalised; distinct from absent. */
export interface JsonLdFieldIssue {
  field: string
  code: 'FIELD_TOO_LONG' | 'FIELD_INVALID'
}

const RAW_FIELDS = [
  'identifier',
  'url',
  'title',
  'name',
  'hiringOrganization',
  'description',
  'jobLocationType',
  'jobLocation',
  'applicantLocationRequirements',
  'employmentType',
  'skills',
  'datePosted',
  'validThrough',
] as const

export interface JsonLdJobPosting {
  identifier: string | null
  url: string | null
  title: string | null
  /** Employer name: from a plain string or from `{ name }`. Null when the source withholds it. */
  hiringOrganization: string | null
  description: string | null
  jobLocationType: string | null
  /** `jobLocation.address` rendered as `locality, region, country` (present parts only). */
  jobLocations: string[]
  applicantLocationRequirements: string[]
  employmentType: string[]
  skills: string[]
  /** Raw value always kept on the `ObservedDate`; `value` only when it parsed. */
  datePosted: ObservedDate | null
  validThrough: ObservedDate | null
  /** `validThrough` parsed AND before `now`; null when there is no usable `validThrough`. */
  expired: boolean | null
  /** The source JSON value of every field read above, untouched (undefined when absent). */
  raw: Record<(typeof RAW_FIELDS)[number], unknown>
  /** Fields present in the source that normalised to nothing. Absent fields are not listed. */
  issues: JsonLdFieldIssue[]
}

export interface JsonLdResult {
  postings: JsonLdJobPosting[]
  failures: Partial<Record<JsonLdFailureCode, number>>
  scanned: { jsonLdScripts: number; parsedScripts: number; nodes: number }
  /** Identifiers that appear on more than one posting with DIFFERENT data. Never merged. */
  conflicts: string[]
}

export interface JsonLdOptions {
  now: Date
  limits?: Partial<JsonLdLimits>
}

const OPEN_SCRIPT = /<script(?=[\s/>])/gi
const CLOSE_SCRIPT = /<\/script(?=[\s/>])/gi
// One attribute of an open tag: name, then an optional double-quoted, single-quoted or bare value.
const ATTRIBUTE = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/y

/**
 * Reads an open tag quote-aware: a `>` inside a quoted value does not end it, and only real
 * attribute names are keys (the first occurrence of a name wins, as in HTML). `end` is the index of
 * the closing `>`, or -1 when the input ends inside the tag.
 * shortcut: an unterminated quote is read as a bare value up to the next `>`, upgrade if a
 * source is seen to rely on the browser's "swallow to EOF" behaviour.
 */
function readOpenTag(
  html: string,
  from: number,
): { end: number; attrs: Map<string, string | undefined> } {
  const attrs = new Map<string, string | undefined>()
  let i = from
  // Stryker disable next-line EqualityOperator: at i === html.length neither branch can act (no '>', the sticky attribute match fails at end of input), so `<=` only adds one empty iteration.
  while (i < html.length) {
    if (html[i] === '>') return { end: i, attrs }
    ATTRIBUTE.lastIndex = i
    const m = ATTRIBUTE.exec(html)
    if (!m) {
      i += 1
      continue
    }
    const [, name, dq, sq, bare] = m
    const key = String(name).toLowerCase()
    if (!attrs.has(key)) attrs.set(key, dq ?? sq ?? bare)
    i = ATTRIBUTE.lastIndex
  }
  return { end: -1, attrs }
}

const BOUND_FAILURE = {
  NOT_JSON: 'MALFORMED_JSON',
  TOO_MANY_BYTES: 'SCRIPT_TOO_LARGE',
  TOO_DEEP: 'TOO_DEEP',
  TOO_MANY_NODES: 'TOO_MANY_NODES',
} as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v]
}

function isJobPosting(node: Record<string, unknown>): boolean {
  // `@type` may be a string, an array, or a full IRI ending in the type name.
  return asList(node['@type']).some(
    (t) => typeof t === 'string' && t.slice(t.lastIndexOf('/') + 1) === 'JobPosting',
  )
}

export function extractJobPostings(html: string, opts: JsonLdOptions): JsonLdResult {
  const limits = { ...DEFAULT_JSON_LD_LIMITS, ...opts.limits }
  const failures: JsonLdResult['failures'] = {}
  const postings: JsonLdJobPosting[] = []
  const scanned = { jsonLdScripts: 0, parsedScripts: 0, nodes: 0 }
  const fail = (code: JsonLdFailureCode): void => {
    failures[code] = (failures[code] ?? 0) + 1
  }
  const finish = (): JsonLdResult => ({
    postings,
    failures,
    scanned,
    conflicts: findConflicts(postings),
  })

  if (Buffer.byteLength(html) > limits.maxHtmlBytes) {
    fail('HTML_TOO_LARGE')
    return finish()
  }

  let nodeBudgetSpent = false
  const walk = (node: unknown): void => {
    if (nodeBudgetSpent) return
    scanned.nodes += 1
    if (scanned.nodes > limits.maxTotalNodes) {
      nodeBudgetSpent = true
      fail('TOTAL_NODES_EXCEEDED')
      return
    }
    if (!isRecord(node)) return
    // `isRecord` admits arrays: `Object.values` walks their elements and `@type` is absent.
    if (isJobPosting(node)) postings.push(toPosting(node, limits, opts.now, fail))
    else Object.values(node).forEach(walk)
  }

  let pos = 0
  for (;;) {
    OPEN_SCRIPT.lastIndex = pos
    const open = OPEN_SCRIPT.exec(html)
    if (!open) break
    const tag = readOpenTag(html, open.index + open[0].length)
    const tagEnd = tag.end
    const isLd = tag.attrs.get('type')?.trim().toLowerCase() === 'application/ld+json'
    if (tagEnd === -1) {
      if (isLd) fail('UNTERMINATED_OPEN_TAG')
      break
    }
    CLOSE_SCRIPT.lastIndex = tagEnd
    const close = CLOSE_SCRIPT.exec(html)
    if (!close) {
      if (isLd) fail('UNTERMINATED_SCRIPT')
      break
    }
    pos = close.index
    if (!isLd) continue

    if (scanned.jsonLdScripts >= limits.maxScripts) {
      fail('TOO_MANY_SCRIPTS')
      break
    }
    scanned.jsonLdScripts += 1

    const parsed = parseBoundedJson(html.slice(tagEnd + 1, close.index), {
      maxBytes: limits.maxScriptBytes,
      maxDepth: limits.maxDepth,
      maxNodes: limits.maxNodes,
    })
    if (!parsed.ok) {
      fail(BOUND_FAILURE[parsed.reason])
      continue
    }
    scanned.parsedScripts += 1
    walk(parsed.value)
  }
  return finish()
}

function toPosting(
  node: Record<string, unknown>,
  limits: JsonLdLimits,
  now: Date,
  fail: (code: JsonLdFailureCode) => void,
): JsonLdJobPosting {
  const issues: JsonLdFieldIssue[] = []
  const note = (field: string, code: JsonLdFieldIssue['code']): void => {
    issues.push({ field, code })
    fail(code)
  }
  const clip = (field: string, v: unknown, cap: number = limits.maxFieldChars): string | null => {
    if (typeof v !== 'string') return null
    const s = v.trim()
    if (s.length === 0) return null
    if (s.length > cap) {
      note(field, 'FIELD_TOO_LONG')
      return null
    }
    return s
  }
  const nameOf = (field: string, v: unknown): string | null => clip(field, isRecord(v) ? v.name : v)
  // A present, non-blank source value that normalised to nothing, without `normalise` having
  // already raised an issue of its own, is an invalid value, not an absent one.
  const checked = <T>(field: string, raw: unknown, normalise: () => T | null): T | null => {
    const before = issues.length
    const value = normalise()
    const present = raw !== undefined && raw !== null && !(typeof raw === 'string' && !raw.trim())
    if (value === null && present && issues.length === before) note(field, 'FIELD_INVALID')
    return value
  }
  const strings = (field: string, v: unknown, one: (x: unknown) => string | null): string[] =>
    asList(v).flatMap((x) => checked(field, x, () => one(x)) ?? [])
  const date = (
    field: string,
    v: unknown,
    semantics: 'PUBLISHED' | 'EXPIRY',
  ): ObservedDate | null =>
    checked(field, v, () =>
      parseSourceDate(
        { raw: typeof v === 'string' ? v : null, contract: 'ISO_ZONED', semantics },
        now,
      ),
    )

  const idRaw = isRecord(node.identifier) ? node.identifier.value : node.identifier
  const validThrough = date('validThrough', node.validThrough, 'EXPIRY')
  const address = (place: unknown): string | null => {
    const a = isRecord(place) ? place.address : null
    if (typeof a === 'string') return clip('jobLocation.address', a)
    if (!isRecord(a)) return null
    const part = (sub: string, raw: unknown, read: (f: string) => string | null) =>
      checked(`jobLocation.${sub}`, raw, () => read(`jobLocation.${sub}`))
    const parts = [
      part('addressLocality', a.addressLocality, (f) => clip(f, a.addressLocality)),
      part('addressRegion', a.addressRegion, (f) => clip(f, a.addressRegion)),
      part('addressCountry', a.addressCountry, (f) => nameOf(f, a.addressCountry)),
    ]
    return parts.flatMap((p) => p ?? []).join(', ') || null
  }
  const titleRaw = node.title ?? node.name

  return {
    identifier: checked('identifier', idRaw, () =>
      clip('identifier', typeof idRaw === 'number' ? String(idRaw) : idRaw),
    ),
    url: checked('url', node.url, () => clip('url', node.url)),
    title: checked('title', titleRaw, () => clip('title', titleRaw)),
    hiringOrganization: checked('hiringOrganization', node.hiringOrganization, () =>
      nameOf('hiringOrganization', node.hiringOrganization),
    ),
    description: checked('description', node.description, () =>
      clip('description', node.description, limits.maxDescriptionChars),
    ),
    jobLocationType: checked('jobLocationType', node.jobLocationType, () =>
      clip('jobLocationType', node.jobLocationType),
    ),
    jobLocations: strings('jobLocation', node.jobLocation, address),
    applicantLocationRequirements: strings(
      'applicantLocationRequirements',
      node.applicantLocationRequirements,
      (x) => nameOf('applicantLocationRequirements', x),
    ),
    employmentType: strings('employmentType', node.employmentType, (x) =>
      clip('employmentType', x),
    ),
    skills: strings('skills', node.skills, (x) => clip('skills', x)),
    datePosted: date('datePosted', node.datePosted, 'PUBLISHED'),
    validThrough,
    expired: validThrough?.status === 'OK' ? validThrough.value.getTime() < now.getTime() : null,
    raw: Object.fromEntries(RAW_FIELDS.map((f) => [f, node[f]])) as JsonLdJobPosting['raw'],
    issues,
  }
}

/** Two postings are "the same" iff this key is equal; shared by conflict detection and selection. */
const sameness = (p: JsonLdJobPosting): string => JSON.stringify(p)

function findConflicts(postings: JsonLdJobPosting[]): string[] {
  const seen = new Map<string, Set<string>>()
  for (const p of postings) {
    if (p.identifier === null) continue
    const variants = seen.get(p.identifier) ?? new Set<string>()
    variants.add(sameness(p))
    seen.set(p.identifier, variants)
  }
  return [...seen].filter(([, variants]) => variants.size > 1).map(([id]) => id)
}

export type IdentityQuery = { identifier?: string; url?: string }

export type IdentitySelection =
  | { kind: 'match'; posting: JsonLdJobPosting }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }

/**
 * A posting is selected only when EVERY supplied criterion equals the posting's value exactly.
 * No criterion, or no match, is `none` — there is no "first posting" fallback. Several matches
 * (a stale-conflict page) are `ambiguous`, never resolved by position.
 */
export function selectByIdentity(
  postings: JsonLdJobPosting[],
  query: IdentityQuery,
): IdentitySelection {
  const { identifier, url } = query
  if (!identifier && !url) return { kind: 'none' }
  // Byte-identical duplicates are one posting (no conflict); only DIFFERENT matches are ambiguous.
  const distinct = new Map<string, JsonLdJobPosting>()
  for (const p of postings) {
    if ((!identifier || p.identifier === identifier) && (!url || p.url === url)) {
      distinct.set(sameness(p), p)
    }
  }
  const matches = [...distinct.values()]
  const [first] = matches
  if (!first) return { kind: 'none' }
  if (matches.length > 1) return { kind: 'ambiguous', count: matches.length }
  return { kind: 'match', posting: first }
}
