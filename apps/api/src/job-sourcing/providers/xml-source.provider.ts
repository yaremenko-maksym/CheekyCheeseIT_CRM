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
 * The port's own bounds, and the loop bounds the JSON binding uses.
 *
 * THE CONSEQUENCE, STATED (SPEC-L-1): 10 pages / 500 items per page are the JSON binding's
 * numbers, NEVER MEASURED ON A REAL FEED. So a genuine feed carrying more than 500 entries in one
 * document FAILS with `PAYLOAD_TOO_LARGE` and collects nothing from that page — not truncated,
 * which would report a coverage we did not have, but not collected either. A board that publishes
 * 800 jobs in one RSS document is entirely plausible and would be dead on arrival until its
 * adapter raises `maxItemsPerPage` itself.
 *
 * RE-MEASURE AT THE FIRST AUTHENTIC CAPTURE. Authentic Djinni / WWR / EU Remote Jobs documents need
 * an outbound GET to a job board (owner authorisation, pending), so the honest number is not
 * knowable here; `apps/api/src/job-sourcing/providers/rss.provider.spec.ts` says the same about its
 * synthetic corpus. Until then an adapter whose feed is genuinely larger states its own ceiling.
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
const UTF8_ENCODER = new TextEncoder()

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

/**
 * The spellings of UTF-8 an XML declaration uses, where a U+FFFD can be the document's own
 * content. Compared CASE-FOLDED, so `UTF-8` — the canonical spelling, and the one the Personio
 * fixture uses — is one of these.
 *
 * NOT trimmed, deliberately. A `.trim()` was here and is gone: `encoding=" UTF-8 "` is not
 * well-formed, so the port refuses such a document before this function ever sees it (measured —
 * the test asserting it was accepted reported FAILED). The guard was unreachable, which the
 * mutation gate showed by leaving its mutant alive.
 *
 * `unicode-1-1-utf-8` was here and is deleted: it is an HTTP charset alias no XML declaration
 * writes, so nothing could observe its membership, and an unobservable member is better removed
 * than excused with a suppression.
 */
const UTF8_LABELS: ReadonlySet<string> = new Set(['utf-8', 'utf8'])

/** U+FFFD. Present in text only because a decode already failed, or because content holds it. */
const REPLACEMENT_CHARACTER = '�'

/**
 * A BODY THE FETCH ALREADY DECODED WRONGLY, REFUSED AS DRIFT (SPEC-M-1 = SR-M-1).
 *
 * The comment above explains what the BOM prefix prevents — the declaration winning a second
 * decode — and names what it cannot do: a `windows-1251` body the fetch read as UTF-8 arrives
 * ALREADY full of U+FFFD, parses as well-formed XML, and used to be stored. Measured: a
 * windows-1251 feed collected as `SUCCEEDED` / `FULL_INVENTORY` with `????` titles — corrupted
 * content, silently, which is worse than a refusal because nothing downstream can tell.
 *
 * THE CONDITION IS "U+FFFD AND A DECLARATION THAT IS NOT UTF-8", not U+FFFD alone. A genuinely
 * UTF-8 document may carry the character as its own content (an employer pasted it into a title),
 * and refusing that would drop a healthy feed. A document that declares `windows-1251` and reaches
 * us holding replacement characters is a document whose bytes were read as something they are not.
 *
 * WHAT IT STILL MISSES, stated because a guard whose blind spots are unwritten is read as total:
 *
 *  - FALSE NEGATIVE — no declaration at all (XML's default is UTF-8, so a declaration-less
 *    `windows-1251` body is accepted), or a declaration that says `utf-8` while the bytes were
 *    something else. Both are a lying or absent declaration, and only bytes can settle them.
 *  - FALSE NEGATIVE — a single-byte encoding mis-decoded into VALID UTF-8 characters rather than
 *    U+FFFD. Mojibake with no replacement character in it is indistinguishable from content here.
 *  - FALSE POSITIVE — a document that declares a non-UTF-8 encoding, was decoded CORRECTLY from
 *    its `Content-Type` charset, and legitimately contains U+FFFD. Refused, though it is fine.
 *  - FALSE POSITIVE, AND THE U+FFFD HALF IS THIRD-PARTY CONTENT, WHICH MAKES IT A PER-ENTRY KILL
 *    SWITCH (SR-M-3). On a board whose feed declares `windows-1251` — ordinary among this phase's
 *    cp1251-era Ukrainian and Russian targets — ONE employer pasting ONE replacement character
 *    into ONE title refuses the WHOLE feed as `PARSE_DRIFT`, on every run, until that posting
 *    rolls off. A feed is one document, so one entry costs the entire source. The availability
 *    cost of this guard is therefore not "imperfect": it is reachable by anyone who can get text
 *    into the feed, and it is written down here because a guard whose availability cost is
 *    unstated gets read as free.
 *  - REFUSED ABSOLUTELY, NOT OCCASIONALLY: A FEED DECLARING `encoding="utf-16"` CAN NEVER COLLECT
 *    THROUGH THIS BINDING (SR-M-3). Not a nuance — a whole encoding class that does not work.
 *    `decodeXmlBody` below always prefixes a UTF-8 BOM, `decodeXml` resolves the BOM before the
 *    declaration, and its conflict check fires precisely across the UTF-16 boundary
 *    (`sniffedIsUtf16 !== declaredIsUtf16` in `xml/decode.ts`) — so the document raises
 *    `ENCODING_CONFLICT` -> `PARSE_DRIFT` whatever the fetch did with its bytes, and whether or not
 *    the body is in fact well-formed UTF-16. There is no input on which such a feed succeeds.
 *
 * All of these go away the same way: the fetch port carrying BYTES, so the port's own fatal decode
 * decides and no BOM has to be injected to get a decoded string parsed. That is TASK 2.2 — the
 * fetch helper owns content type and charset (plan §Task 2.2: "content type/charset") — NOT 2.5,
 * which has no bytes or charset item at all. The deferral used to point at 2.5, which is how a
 * requirement deferred to a task that does not own it disappears. The deferral is settled; what is
 * new above is only the statement of what is being deferred.
 */
function mojibakeDrift(bodyText: string, declaredEncoding: string | null): string | null {
  if (declaredEncoding === null) return null
  if (UTF8_LABELS.has(declaredEncoding.toLowerCase())) return null
  if (!bodyText.includes(REPLACEMENT_CHARACTER)) return null
  return (
    `the body declares ${JSON.stringify(declaredEncoding)} and arrived holding replacement ` +
    'characters, so its bytes were decoded as an encoding they are not'
  )
}

export function decodeXmlBody(
  bodyText: string,
  limits: XmlLimits,
  port: XmlPort,
): DecodedEnvelope<XmlDocument> {
  const body = UTF8_ENCODER.encode(bodyText)
  const bytes = new Uint8Array(UTF8_BOM.length + body.length)
  bytes.set(UTF8_BOM)
  bytes.set(body, UTF8_BOM.length)
  try {
    // The byte cap is the PROVIDER's body; the mark is ours, so it is not charged against it.
    const document = port.parseDocument(bytes, {
      ...limits,
      maxBytes: limits.maxBytes + UTF8_BOM.length,
    })
    const mojibake = mojibakeDrift(bodyText, document.declaredEncoding)
    if (mojibake !== null) return { ok: false, code: 'PARSE_DRIFT', message: mojibake }
    return { ok: true, value: document }
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
 * The headers an XML or feed adapter may send. AN ALLOWLIST, and that is the whole point.
 *
 * Each member is here because an adapter has a reason to set it: content negotiation (`accept`,
 * `accept-language`), a credentialed ATS (`authorization`), and the contact address our collector
 * identity promises (`from`). `user-agent` is deliberately ABSENT — the binding writes it itself.
 *
 * ADDING A MEMBER IS THE POINT OF FRICTION. An adapter that needs another header edits this set,
 * in review, with a reason — which is exactly what a denylist could not ask for.
 */
const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-language',
  'authorization',
  'from',
])

/**
 * Headers the binding owns: our user agent, always, and nothing an adapter was not allowed to send.
 *
 * The bounded fetch sets the honest user agent only as a DEFAULT — a caller's `user-agent` header
 * overrides it — so a feed adapter that copied a browser string would impersonate a browser on the
 * wire. Feeds are where that temptation lives (boards that serve HTML to unknown agents), so the
 * binding takes the decision away from the adapter.
 *
 * IT USED TO BE A DENYLIST, dropping `sec-ch-ua*` / `sec-fetch-*` and keeping everything else
 * (SR-M-2 = CR-M-4). What that kept: `referer` and `origin` (a browser's provenance claim),
 * `cookie` (a session we have no business sending to a job board), `x-forwarded-for` (a claim
 * about a client that does not exist) and `x-device-user-agent` (the browser string the UA
 * replacement was for, under a second name). A denylist is a list of the impersonations someone
 * thought of; the next header a board sniffs is one nobody enumerated. Inverted, an adapter can
 * only send what was argued for.
 *
 * THE ROOT FIX IS NOT HERE, AND IT IS NOT OURS. `boundedFetchText` still lets a caller's
 * `user-agent` override its default, because DOU relies on exactly that (`dou.provider.ts` passes
 * its own copy of the string). The honest shape is the fetch taking the user agent as an EXPLICIT
 * option with DOU opting in — TASK 2.5, where the fetch is wired to the collector — and both
 * review axes agree. It is latent until then: no production fetch and no JSON adapter exists yet,
 * and every XML/feed request goes through this function. So this binding closes its own surface
 * and does not reach into `bounded-fetch` or DOU, whose golden fixtures gate any change to them
 * (constraint C-20).
 *
 * The JSON binding does NOT call this, and that is unchanged by this round: it has no adapters at
 * all yet, and giving JSON APIs a feed's header policy would be a guess about 25 unwritten
 * adapters rather than a decision. The same Task 2.5 wiring is where it gets one.
 */
export function honestRequest(request: FetchRequest): FetchRequest {
  const headers: Record<string, string> = {}
  // TWO SPELLINGS OF ONE HEADER: THE LAST ONE WINS, DELIBERATELY (LOW, round 2).
  //
  // `{ Accept: 'a', accept: 'b' }` folds to one slot, and the loop above takes them in insertion
  // order, so `b` is sent. That was true before and is now a decision rather than a side effect.
  //
  // WHY LAST AND NOT A REFUSAL: HTTP has no notion of a header's letter case, so the two keys were
  // never two headers — they are one header an adapter wrote twice, which is an adapter bug with
  // no safe reading. Refusing the request would turn a cosmetic adapter mistake into a dead
  // source, and refusing is also what this binding does NOT do with headers anywhere else: an
  // unknown header is dropped, not fatal. Concatenating them (the comma-joined form HTTP allows
  // for list headers) would invent a value neither spelling asked for, and would be wrong outright
  // for a non-list header like `authorization`.
  //
  // Last-wins is also the only choice an adapter can PREDICT: it matches `Object.assign` and the
  // object spread this file is full of, and the `Headers` of every fetch implementation. The
  // alternative that reads more cautious — first-wins — would silently prefer whichever key the
  // adapter happened to type first, which is not a property an author controls.
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const key = name.toLowerCase()
    if (!ALLOWED_REQUEST_HEADERS.has(key)) continue
    headers[key] = value
  }
  // Written AFTER the copy, so it replaces an adapter's `user-agent` in any letter case: the keys
  // were lowercased above, so there is exactly one slot for it. `user-agent` is not in the
  // allowlist, so the copy cannot have left one behind.
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
