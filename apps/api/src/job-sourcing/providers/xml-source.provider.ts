import type { ZodType } from 'zod'
import { DEFAULT_USER_AGENT } from '../http/bounded-fetch'
import {
  DEFAULT_XML_LIMITS,
  type XmlDocument,
  type XmlFailureReason,
  type XmlLimits,
  type XmlPort,
  xmlPort,
  XmlPortError,
} from '../xml'
import {
  collectPages,
  type DecodedEnvelope,
  definePagedProvider,
  type PageLimits,
  type PageRequest,
  type PagedSourceSpec,
} from './api-json.provider'
import type {
  CollectionBatch,
  CollectionContext,
  CollectionErrorCode,
  FetchRequest,
  ReportingJobSourceProvider,
  SourceConfigFields,
  Validated,
} from './reporting-provider'

/**
 * The XML binding of the shared page loop (Task 2.4) — the "XML helper" the plan gives Personio,
 * and the layer the RSS/Atom base (`rss.provider.ts`) is built on.
 *
 * It binds `PagedSourceSpec.decodeEnvelope` to Seam 1 (`XmlPort`), so an XML-shaped API response
 * collects with the same checkpointing, metering, conditional cache and derived outcome as a JSON
 * one, and an adapter sees a namespace-resolved `XmlDocument` instead of a parser's tree. It knows
 * nothing about feeds: that is Seam 2, one layer up, and keeping it out of here is what gives
 * Personio a supported way in (Shape C in `docs/architecture/2026-10-20-xml-parser-dependency-review.md`).
 */

/** The port's five XML bounds plus the loop's two. */
export interface XmlSourceLimits extends XmlLimits, PageLimits {}

/**
 * The port's own bounds, and the loop bounds the JSON binding uses. 500 items per page is the JSON
 * binding's number rather than a feed measurement: an adapter whose feed is genuinely larger states
 * its own ceiling, and one that is not is told by a `PAYLOAD_TOO_LARGE` rather than truncated.
 */
export const DEFAULT_XML_SOURCE_LIMITS: XmlSourceLimits = Object.freeze({
  ...DEFAULT_XML_LIMITS,
  maxPages: 10,
  maxItemsPerPage: 500,
})

/** An XML adapter: the format-neutral spec whose envelope is the parsed document itself. */
export interface XmlSourceSpec<TConfig extends SourceConfigFields, TItem> extends Omit<
  PagedSourceSpec<TConfig, XmlDocument, TItem>,
  'decodeEnvelope' | 'limits'
> {
  readonly configSchema: ZodType<TConfig>
  readonly limits?: Partial<XmlSourceLimits>
}

/**
 * THE BODY ARRIVES AS TEXT, AND IS HANDED TO THE PORT AS THAT TEXT.
 *
 * The fetch seam (`CollectionContext.fetchText`) has already decoded the bytes, but `XmlPort` takes
 * bytes and honours the document's own encoding declaration. Re-encoding the text as bare UTF-8
 * would let a `encoding="windows-1251"` declaration win, and the port would decode UTF-8 bytes as
 * windows-1251 — mojibake with no error anywhere. A UTF-8 byte-order mark outranks the declaration
 * in the port's encoding resolution, so prefixing one makes the decode an identity on the text we
 * were given.
 *
 * What this cannot do is recover a feed the FETCH decoded wrongly: a windows-1251 body already
 * read as UTF-8 arrives with replacement characters. Byte-faithful decoding needs the fetch port
 * to carry bytes, which is the binding of `fetchText` (Task 2.5), not this file.
 */
const UTF8_BOM = Uint8Array.of(0xef, 0xbb, 0xbf)

/** Bounds a provider overran: the format is right, the size is past what we set. */
const BOUND_REASONS: ReadonlySet<XmlFailureReason> = new Set<XmlFailureReason>([
  'TOO_MANY_BYTES',
  'TOO_DEEP',
  'TOO_MANY_ELEMENTS',
  'TIME_BUDGET',
])

function classify(reason: XmlFailureReason): CollectionErrorCode {
  if (BOUND_REASONS.has(reason)) return 'PAYLOAD_TOO_LARGE'
  // The port's own internal invariant (`xml-port.ts`): a divergence between our pre-scan and the
  // parser is a bug in OUR scanner, and reporting it as the provider's drift would send whoever
  // reads the report to the wrong place.
  if (reason === 'PRESCAN_DIFFERENTIAL') return 'ADAPTER_INVARIANT'
  // Everything else — undecodable, malformed, a DOCTYPE, namespace-ill-formed — is a body that is
  // not the XML we can read, which is drift.
  return 'PARSE_DRIFT'
}

export function decodeXmlBody(
  bodyText: string,
  limits: XmlLimits,
  port: XmlPort,
): DecodedEnvelope<XmlDocument> {
  const body = new TextEncoder().encode(bodyText)
  const bytes = new Uint8Array(UTF8_BOM.length + body.length)
  bytes.set(UTF8_BOM)
  bytes.set(body, UTF8_BOM.length)
  try {
    // The byte cap is the PROVIDER's body; the mark is ours, so it is not charged against it.
    return {
      ok: true,
      value: port.parseDocument(bytes, { ...limits, maxBytes: limits.maxBytes + UTF8_BOM.length }),
    }
  } catch (error) {
    if (error instanceof XmlPortError) {
      return {
        ok: false,
        code: classify(error.reason),
        message: `${error.reason}: ${error.message}`,
      }
    }
    // The port promises `XmlPortError` and nothing else. Anything else is the port's defect, and
    // returning it as data keeps the attempt reporting rather than rejecting.
    return {
      ok: false,
      code: 'ADAPTER_INVARIANT',
      message: `the XML port threw outside its contract: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Headers the binding owns: our user agent, always, and no browser client hints, ever.
 *
 * The bounded fetch sets the honest user agent only as a DEFAULT — a caller's `user-agent` header
 * overrides it — so a feed adapter that copied a browser string would impersonate a browser on the
 * wire. Feeds are where that temptation lives (boards that serve HTML to unknown agents), so the
 * binding takes the decision away from the adapter: the user agent is replaced, and `sec-ch-ua*` /
 * `sec-fetch-*`, which only a browser sends, are dropped. Every other adapter header is kept.
 */
export function honestRequest(request: FetchRequest): FetchRequest {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const key = name.toLowerCase()
    if (key === 'user-agent' || key.startsWith('sec-ch-ua') || key.startsWith('sec-fetch-')) {
      continue
    }
    headers[key] = value
  }
  headers['user-agent'] = DEFAULT_USER_AGENT
  return { ...request, headers }
}

export const resolveXmlSourceLimits = (limits?: Partial<XmlSourceLimits>): XmlSourceLimits => ({
  ...DEFAULT_XML_SOURCE_LIMITS,
  ...limits,
})

/**
 * The XML binding as a `PagedSourceSpec`. Exported for `rss.provider.ts`, which composes Seam 2 on
 * top of the same decode, so the two XML bindings cannot disagree about bounds, encoding or the
 * user agent.
 */
export function xmlPagedSpec<TConfig extends SourceConfigFields, TItem>(
  spec: XmlSourceSpec<TConfig, TItem>,
  port: XmlPort,
): PagedSourceSpec<TConfig, XmlDocument, TItem> {
  const limits = resolveXmlSourceLimits(spec.limits)
  return {
    ...spec,
    limits,
    decodeEnvelope: (bodyText) => decodeXmlBody(bodyText, limits, port),
    pageRequest: (config, at): PageRequest => {
      const built = spec.pageRequest(config, at)
      return { ...built, request: honestRequest(built.request) }
    },
  }
}

export function collectXmlPages<TConfig extends SourceConfigFields, TItem>(
  spec: XmlSourceSpec<TConfig, TItem>,
  config: TConfig,
  ctx: CollectionContext,
  port: XmlPort = xmlPort,
): Promise<CollectionBatch> {
  return collectPages(xmlPagedSpec(spec, port), config, ctx)
}

export function defineXmlProvider<TConfig extends SourceConfigFields, TItem>(
  spec: XmlSourceSpec<TConfig, TItem>,
  port: XmlPort = xmlPort,
): ReportingJobSourceProvider<Validated<TConfig>> {
  return definePagedProvider(spec, (config, ctx) => collectXmlPages(spec, config, ctx, port))
}
