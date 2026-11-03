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
  | 'MALFORMED_JSON'
  | 'SCRIPT_TOO_LARGE'
  | 'TOO_DEEP'
  | 'TOO_MANY_NODES'
  | 'TOTAL_NODES_EXCEEDED'
  | 'FIELD_TOO_LONG'

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
const LD_JSON_TYPE =
  /(?<![\w-])type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json(?![^\s/>]))/i

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
    const tagEnd = html.indexOf('>', open.index)
    if (tagEnd === -1) break
    const isLd = LD_JSON_TYPE.test(html.slice(open.index, tagEnd))
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
  const clip = (v: unknown, cap: number = limits.maxFieldChars): string | null => {
    if (typeof v !== 'string') return null
    const s = v.trim()
    if (s.length === 0) return null
    if (s.length > cap) {
      fail('FIELD_TOO_LONG')
      return null
    }
    return s
  }
  const nameOf = (v: unknown): string | null => clip(isRecord(v) ? v.name : v)
  const strings = (v: unknown, one: (x: unknown) => string | null = clip): string[] =>
    asList(v).flatMap((x) => one(x) ?? [])
  const date = (v: unknown, semantics: 'PUBLISHED' | 'EXPIRY'): ObservedDate | null =>
    parseSourceDate(
      { raw: typeof v === 'string' ? v : null, contract: 'ISO_ZONED', semantics },
      now,
    )

  const idRaw = isRecord(node.identifier) ? node.identifier.value : node.identifier
  const validThrough = date(node.validThrough, 'EXPIRY')
  const address = (place: unknown): string | null => {
    const a = isRecord(place) ? place.address : null
    if (typeof a === 'string') return clip(a)
    if (!isRecord(a)) return null
    const parts = [clip(a.addressLocality), clip(a.addressRegion), nameOf(a.addressCountry)]
    return parts.flatMap((p) => p ?? []).join(', ') || null
  }

  return {
    identifier: clip(typeof idRaw === 'number' ? String(idRaw) : idRaw),
    url: clip(node.url),
    title: clip(node.title ?? node.name),
    hiringOrganization: nameOf(node.hiringOrganization),
    description: clip(node.description, limits.maxDescriptionChars),
    jobLocationType: clip(node.jobLocationType),
    jobLocations: strings(node.jobLocation, address),
    applicantLocationRequirements: strings(node.applicantLocationRequirements, nameOf),
    employmentType: strings(node.employmentType),
    skills: strings(node.skills),
    datePosted: date(node.datePosted, 'PUBLISHED'),
    validThrough,
    expired: validThrough?.status === 'OK' ? validThrough.value.getTime() < now.getTime() : null,
  }
}

function findConflicts(postings: JsonLdJobPosting[]): string[] {
  const seen = new Map<string, Set<string>>()
  for (const p of postings) {
    if (p.identifier === null) continue
    const variants = seen.get(p.identifier) ?? new Set<string>()
    variants.add(JSON.stringify(p))
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
  const matches = postings.filter(
    (p) => (!identifier || p.identifier === identifier) && (!url || p.url === url),
  )
  const [first] = matches
  if (!first) return { kind: 'none' }
  if (matches.length > 1) return { kind: 'ambiguous', count: matches.length }
  return { kind: 'match', posting: first }
}
