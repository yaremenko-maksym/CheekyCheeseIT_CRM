import { createHash } from 'node:crypto'
import type { JobMeterUnit, JobSourceType } from '@crm/shared'
import { z, type ZodType } from 'zod'
import { DEFAULT_MAX_BYTES, MAX_RESPONSE_BYTES_CEILING } from '../http/bounded-fetch'
import { SourcePayloadTooLargeError } from '../http/source-errors'
import { canonicalNativeId } from '../normalize/identity-key'
import {
  buildSourceObservation,
  type RawObservationFields,
  type SourceObservation,
} from '../normalize/observation'
import { type ApiJsonLimits, DEFAULT_API_JSON_LIMITS } from './api-json.limits'
import { parseBoundedJson } from './bounded-json'
import {
  assertValidatedConfig,
  buildCollectionBatch,
  buildInvalidSample,
  buildRequestReport,
  type CachedResponse,
  type CollectionBatch,
  type CollectionContext,
  type CollectionCounts,
  type CollectionErrorCode,
  type CollectionWindow,
  decideCheckpoint,
  type FetchRequest,
  type InvalidSample,
  markValidated,
  MAX_SAMPLES,
  type MeterReservation,
  PG_INT_MAX,
  type ReportingJobSourceProvider,
  type RequestReport,
  type ReservationResolution,
  type ResumePosition,
  cursorPositionSchema,
  type SourceConfigFields,
  type Validated,
  type SourceCoverageScope,
  type StopReason,
  type ValidatedCheckpoint,
} from './reporting-provider'

/**
 * The `ApiJsonProvider` base (Task 2.3): ONE bounded page loop that all of phase 3's JSON adapters
 * share, and an adapter spec that is DATA.
 *
 * "DESIGN IT TWICE" — the rejected alternative was the obvious one: an
 * `abstract class ApiJsonProvider` with a final `collectReport` calling abstract `buildRequest` /
 * `parseEnvelope` / `mapItem`. Same depth, and rejected for two reasons.
 *
 *  - The AC1 invariant would be OVERRIDABLE. A subclass can override `collectReport`, and the one
 *    thing that must not be per-adapter is exactly the thing inheritance leaves open. Here outcome
 *    and coverage are derived inside `collectPages` from facts the spec cannot reach, and a
 *    spec has no slot in which to claim either.
 *  - The loop could only be tested through a fake subclass — testing from behind the interface. As
 *    a function over ports it is tested through the same seam the adapters use.
 *
 * So: `collectPages` is the deep module, `PagedSourceSpec` is the seam, and the ~25 adapters are
 * adapters in the role sense — each occupies the slot (through the JSON, XML or feed binding),
 * none of them owns the lifecycle.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** `jobSourceIdentitySchema.namespace` in the phase-1 store. Its number, not ours. */
export const NAMESPACE_MAX_CHARS = 200

/**
 * Re-exported, not re-declared: the checkpoint schema in `reporting-provider.ts` bounds a stored
 * page by the same PostgreSQL `integer` ceiling, and two copies of a number that must agree are
 * one copy too many.
 */
export { PG_INT_MAX } from './reporting-provider'

/**
 * A request URL that was never built, because the adapter threw while building it. A valid URL (so
 * the report's structural redaction parses it) that is obviously not an endpoint.
 */
export const UNBUILT_REQUEST_URL = 'about:request-not-built'

/** How far back a restart-with-overlap widens a windowed scope (AC4). */
export const DEFAULT_OVERLAP_MS = 24 * 60 * 60 * 1000

/**
 * Every adapter's config extends this. The two bounds are taken from the phase-1 store rather than
 * chosen here: a namespace of 201 characters and a config version of 2^31 both parse happily as
 * "a string" and "a number" and are then refused by the column, at persist time, after the work.
 * `reporting-provider.store-conformance.spec.ts` asserts both sides of both.
 */
export const baseSourceConfigSchema = z.object({
  namespace: z.string().max(NAMESPACE_MAX_CHARS).default(''),
  configVersion: z.number().int().positive().max(PG_INT_MAX),
  /** Non-null makes this a SEARCH scope, which changes what coverage it may claim. */
  query: z.string().max(500).nullable().default(null),
  window: z.object({ from: z.coerce.date(), to: z.coerce.date() }).nullable().default(null),
})

// ---------------------------------------------------------------------------
// The spec — the seam
// ---------------------------------------------------------------------------

/**
 * Where the loop is, and what window it is covering. `page` is 1-based and about to be fetched.
 *
 * `window` is the field this type exists for. It WAS `{ page, cursor }`, and `widenScope`'s result
 * went into a local that reached `batch.scope.window` and never `spec.pageRequest` — so a restart
 * REPORTED a widened window and then asked the provider for the unwidened one. Measured: a
 * checkpoint under a stale config widened the reported window to `2026-09-30` while the request on
 * the wire still carried `from=2026-10-01` (SPEC-H-1). The three tests that covered the overlap
 * asserted `batch.scope.window`, which is the half that was already right, so all three passed.
 *
 * AN ADAPTER MUST BUILD ITS REQUEST FROM `at.window`, NEVER FROM `config.window`:
 * `config.window` is what was CONFIGURED, `at.window` is what this attempt is actually covering.
 */
export interface PageTarget {
  page: number
  cursor: string | null
  window: CollectionWindow | null
}

export interface PageRequest {
  request: FetchRequest
  /**
   * The URL to REPORT for this page, when `request.url` carries a credential (a key in the path).
   * Reports use it INSTEAD of `request.url`, unconditionally: redaction by registered value is
   * only as good as whoever registered, and a path segment has no structural form for the
   * redactor to find. Absent, `request.url` is reported (after the usual redaction).
   */
  reportUrl?: string
  /**
   * The cache SLOT for this page — a readable label, NOT the whole key. Omit to skip caching for
   * this page. The loop keys the entry on this slot plus a digest of the request itself (see
   * `responseCacheKey`), so a slot an adapter reuses across two different requests cannot make
   * one request's 304 replay the other's body.
   */
  cacheKey?: string
}

/** The two bounds the LOOP enforces, whatever the body format. Each binding resolves its own. */
export type PageLimits = Pick<ApiJsonLimits, 'maxPages' | 'maxItemsPerPage'>

/**
 * One body, turned into an envelope — or refused, with the code the refusal reports under.
 *
 * The code is the binding's to choose because only the binding knows the difference between "this
 * is not the format we asked for" (`PARSE_DRIFT`) and "this is the format, past a bound we set"
 * (`PAYLOAD_TOO_LARGE`), and the two are actioned differently.
 */
export type DecodedEnvelope<TEnvelope> =
  { ok: true; value: TEnvelope } | { ok: false; code: CollectionErrorCode; message: string }

/**
 * ONE adapter, as data — FORMAT-NEUTRAL. The loop's view of a source.
 *
 * WHY THIS EXISTS (Task 2.4): the RSS/Atom base and the Personio XML helper collect through THIS
 * loop rather than one of their own. Body format was the only thing about the loop that was JSON —
 * one call to `parseBoundedJson` and one envelope `safeParse` — and everything else (checkpoint
 * validation, reserve -> reconcile, the conditional cache, outcome and coverage derivation,
 * failure classification) is exactly what a second loop would have had to re-derive, with every
 * failure mode 2.3's review rounds closed open again. So the format became one slot,
 * `decodeEnvelope`, and the loop is shared. The JSON binding is `collectJsonPages`; the XML
 * bindings are `xml-source.provider.ts` and `rss.provider.ts`.
 *
 * The three override seams the plan asks for are function fields: FETCH is `pageRequest` (the
 * adapter says what to ask for; the loop, never the adapter, does the asking, so bounds and
 * metering cannot be skipped), MAP is `mapItem`, SCHEMA is `decodeEnvelope` + `itemSchema`.
 */
export interface PagedSourceSpec<TConfig extends SourceConfigFields, TEnvelope, TItem> {
  readonly type: JobSourceType
  /** Bumped when the mapping changes. The loop stamps it on every observation and checkpoint, so
   * an adapter cannot disagree with itself about which version produced a row. */
  readonly adapterVersion: string
  /**
   * The body -> the page envelope. The envelope MUST treat the items as OPAQUE: the envelope is
   * the subrequest's contract and a failure here is drift that fails the subrequest, while a bad
   * ITEM must be isolated (AC3). An envelope check that validated items inline would turn one
   * malformed posting into a failed page — precisely the behaviour the AC forbids.
   *
   * Returns a refusal rather than throwing. It is called on a 200 body and on a body replayed from
   * the cache after a 304 alike, so a cached inventory is held to the same contract as a fresh one.
   */
  decodeEnvelope(bodyText: string): DecodedEnvelope<TEnvelope>
  readonly itemSchema: ZodType<TItem>
  pageRequest(config: TConfig, at: PageTarget): PageRequest
  extractItems(envelope: TEnvelope, config: TConfig): readonly unknown[]
  /**
   * The cursor for the NEXT page, or `null` when the provider's inventory is exhausted.
   *
   * WHATEVER YOU RETURN HERE IS UNTRUSTED INPUT, and it comes back to you as `at.cursor`. It is
   * the only value in the loop chosen entirely by the upstream provider: the loop bounds its
   * LENGTH (`MAX_CURSOR_CHARS`, parsed before it is stored) and nothing else, because nothing
   * else about it is knowable from here.
   *
   * SO AN ADAPTER MUST NOT USE A CURSOR AS THE REQUEST TARGET. A "next URL" style cursor fed
   * straight into `pageRequest`'s `request.url` hands the provider control of where we send the
   * next request, credentials and all — a redirect to an attacker-chosen host, with our headers.
   * Use the cursor as a PARAMETER of a URL the adapter builds (`?after=<cursor>`), or, if the
   * provider really only gives absolute next-links, parse it and check its origin against the one
   * the config configured before using it.
   */
  nextCursor(envelope: TEnvelope, at: PageTarget): string | null
  /**
   * Map one VALIDATED item to untrusted observation fields. May throw: the item is isolated with a
   * bounded sample and the batch goes on (AC3).
   *
   * `provider` and `adapterVersion` are deliberately NOT returnable — the loop supplies both from
   * the spec, so 25 adapters cannot each get them subtly wrong.
   */
  mapItem(item: TItem, config: TConfig): Omit<RawObservationFields, 'provider' | 'adapterVersion'>
  /**
   * The id the PROVIDER issued for this item, whatever the adapter chose to key identity on.
   *
   * It exists so the AC5 invariant is REACHABLE. `normalizeNativeId` in the identity seam is
   * NFC + trim, so two distinct ids fed into a NATIVE_ID key can never collide — the collapse that
   * actually happens is an adapter that keys on the canonical URL (URL_FALLBACK) while the
   * provider was issuing distinct ids all along, and `raw.nativeId` is `null` in exactly that
   * case. Without this field the check would be unreachable code: its passing would be
   * indistinguishable from its absence.
   *
   * IT IS REQUIRED, AND IT USED TO BE OPTIONAL WITH A DEFAULT OF `raw.nativeId`. That default was
   * silently empty in precisely the case the check exists for: an adapter keyed on the URL has
   * `raw.nativeId === null`, so the AC5 guard saw `null` for every item, compared nothing, and
   * reported success. Measured, two items with provider ids `1` and `2` sharing one canonical URL
   * produced `SUCCEEDED` with two observations collapsed onto one identity key — and the adapter
   * author got no signal, at compile time or at run time, that the check they most needed was
   * switched off (SPEC-M-1). All 25 of phase 3's adapters write this field, which is the cost of
   * the field being impossible to forget rather than merely documented.
   *
   * WHAT AN ADAPTER PROMISES by implementing this, and what the loop can catch if it breaks the
   * promise (SR-M-4). The promise: the value returned is the provider's own id for the item, and it
   * varies exactly when the provider's postings differ. The loop checks it ONLY when identity fell
   * back to the canonical URL (`identity.nativeId === null`), and compares this value across items
   * that landed on one identity key. So it catches an adapter whose URL is coarser than the
   * provider's ids. It does NOT catch the other direction: a `mapItem` that sets `raw.nativeId` to
   * an id coarser than what this method reports (a constant, a shared slug) makes identity key on
   * that id, `identity.nativeId` is non-null, the check is skipped, and two distinct postings
   * collapse onto one key stored as `SUCCEEDED`, silently. "The adapter said so" holds for the
   * adapter's choice of FIELD, not for the feed's VALUES in it; this method does not make `mapItem`'s
   * identity id honest. Latent today: the RSS binding reads `entry.guid` on both sides and its
   * `mapEntry` is `Omit<…, 'nativeId'>`, so it cannot diverge, and the JSON binding has no adapters
   * yet. An adapter author must keep `mapItem`'s native id and this return value the same field.
   *
   * There are exactly two honest implementations:
   *  - `(item) => item.id` (or wherever the provider's id lives), including for a URL-keyed
   *    adapter — ESPECIALLY for one, since that is the configuration AC5 guards;
   *  - `() => null`, for a provider that genuinely issues no per-posting id. This SWITCHES THE
   *    AC5 CHECK OFF for the source, so it is a claim about the provider, written down and
   *    reviewable — which is the whole difference from the omission it replaces.
   */
  nativeIdOf(item: TItem, config: TConfig): string | null
  /**
   * What this attempt covers. `now` is the attempt's clock, for a scope whose window is relative
   * to it — a feed that only ever shows the last N days covers `[now - N days, now]`, and saying
   * so is what keeps it from claiming FULL_INVENTORY (Task 2.4).
   */
  scopeOf(config: TConfig, now: Date): SourceCoverageScope
  /** Required here and resolved by each binding: a loop-level default would be one no binding used. */
  readonly limits: PageLimits
  /**
   * The response cap every request of this source declares to the transport (`FetchRequest.maxBytes`).
   * Absent, nothing is declared and the transport's 2 MiB default applies. A separate field from
   * `limits`, whose byte bound belongs to the decoding binding, not to the loop.
   */
  readonly requestMaxBytes?: number
  /**
   * What one page costs. Reserved BEFORE any I/O, per the store's reservation ordering.
   *
   * `amountPerRequest` is the WORST CASE. A source whose real cost differs from it (credits per
   * returned record) also supplies `incurredAmount`: given the body of a successful page, the cost
   * the provider actually charged, or `null` when it cannot tell. The loop settles with that amount
   * when it lies in `0..amountPerRequest` (a free request, 0, settles as 1: the store cannot record
   * a USED reservation with no cost); absent, `null`, non-integer or past the reservation, the
   * full reservation is charged: that cannot overspend the RESERVATION, but whether the reservation
   * covers what the provider really charged is the provider's billing, which this loop cannot
   * know (a real charge above the reservation would still be under-counted). A reported cost BELOW the
   * reservation frees the difference for re-reservation, which overspends if the reading is wrong:
   * supply this hook only for a billing basis that has been observed. It must not throw: a throw is
   * an adapter defect (`ADAPTER_INVARIANT`, which no retry acts on), with the response already
   * counted as having arrived (the reservation settles USED, whole).
   */
  readonly meter?: {
    unit: JobMeterUnit
    amountPerRequest: number
    incurredAmount?(bodyText: string): number | null
  }
  readonly overlapMs?: number
}

/** A JSON adapter: the format-neutral spec, with its body contract spelled as a Zod envelope. */
export interface ApiJsonSourceSpec<
  TConfig extends SourceConfigFields,
  TEnvelope,
  TItem,
> extends Omit<
  PagedSourceSpec<TConfig, TEnvelope, TItem>,
  'decodeEnvelope' | 'limits' | 'requestMaxBytes'
> {
  readonly configSchema: ZodType<TConfig>
  /**
   * The page envelope. MUST treat the item array as OPAQUE (`z.array(z.unknown())`), for the
   * reason given on `PagedSourceSpec.decodeEnvelope`.
   */
  readonly envelopeSchema: ZodType<TEnvelope>
  readonly limits?: Partial<ApiJsonLimits>
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Two items with DIFFERENT provider-issued ids that produced the SAME identity key. That is not a
 * data problem to quarantine and not a ratio to threshold — it means the adapter's identity
 * mapping is wrong, and every record it ever wrote under that key is suspect (AC5).
 *
 * Deliberately NOT a 50 %-duplicate heuristic: a provider legitimately returning the same posting
 * on two pages is normal, and a threshold would both miss a two-record collapse and fire on a
 * healthy overlap.
 */
export class AdapterIdentityCollisionError extends Error {
  constructor(
    readonly identityKey: string,
    readonly firstNativeId: string,
    readonly secondNativeId: string,
  ) {
    super(
      `adapter invariant: native ids ${firstNativeId} and ${secondNativeId} collapsed to one identity key`,
    )
    this.name = 'AdapterIdentityCollisionError'
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * One page's dispositions, before the attempt knows whether the page survived.
 *
 * `discarded` is deliberately ABSENT rather than present-and-zero: a page cannot discard itself,
 * only the attempt can discard a page, so the field has no meaning at this scale. A
 * `discarded: 0` that `observePage` never writes would be arithmetic no test could observe.
 */
type PageCounts = Omit<CollectionCounts, 'discarded'>

const emptyAttemptCounts = (): CollectionCounts => ({
  raw: 0,
  normalized: 0,
  invalid: 0,
  quarantined: 0,
  discarded: 0,
})

const emptyPageCounts = (): PageCounts => ({
  raw: 0,
  normalized: 0,
  invalid: 0,
  quarantined: 0,
})

/**
 * WHERE ONE PAGE'S DISPOSITIONS JOIN THE ATTEMPT'S, in two functions because there are two
 * answers and the difference is one line.
 *
 * `observePage` used to increment the attempt's counts in place, which meant the choice was made
 * before its outcome was known: items observed on a page that then failed stayed counted as
 * `normalized` while their observations were thrown away, so `counts.normalized` and
 * `observations.length` disagreed on exactly the pages that failed (CR-M-5 = SPEC-M-3). A page's
 * counts are PROVISIONAL until the page lands, and "lands" means its `savePage` resolved — not
 * merely that its items parsed.
 *
 * WHY TWO FUNCTIONS RATHER THAN ONE WITH A `'KEPT' | 'DISCARDED'` PARAMETER: the mutation gate
 * reported the parameter's two call sites as surviving mutants, and it was right. `'DISCARDED'`
 * mutated to `''` behaves identically, because the only value the function tested for was
 * `'KEPT'` — so the union had one observable member and one catch-all, which is a boolean wearing
 * a vocabulary. Suppressing that would have hidden a shape that invites a third member nothing
 * would branch on. Split, there is no argument to get wrong and both lines that differ are
 * reachable and asserted.
 */
function addReceived(total: CollectionCounts, page: PageCounts): void {
  // Unaffected by which of the two follows: we did receive these items, and the reason each was
  // refused does not change because the page later failed.
  total.raw += page.raw
  total.invalid += page.invalid
  total.quarantined += page.quarantined
}

/** The page landed. Its observations are in the batch, so they are what the batch `normalized`. */
function keepPageCounts(total: CollectionCounts, page: PageCounts): void {
  addReceived(total, page)
  total.normalized += page.normalized
}

/** The page did not land. Its observations were thrown away, so they are `discarded`. */
function discardPageCounts(total: CollectionCounts, page: PageCounts): void {
  addReceived(total, page)
  total.discarded += page.normalized
}

function widenScope(scope: SourceCoverageScope, overlapMs: number): SourceCoverageScope {
  if (scope.window === null) return scope
  return {
    ...scope,
    window: {
      from: new Date(scope.window.from.getTime() - overlapMs),
      to: scope.window.to,
    },
  }
}

type BuiltPageRequest = { ok: true; value: PageRequest } | { ok: false; message: string }

/**
 * What happens after a page has been observed — decided BEFORE the page is persisted, because the
 * decision includes whether the provider's next cursor is usable at all, and that must be known
 * before it is written to the database (SR-H-3).
 *
 * A union rather than three nullable locals. The nullable form is what produced two branches no
 * input could enter and three separate `at.page + 1` sites; here each arm carries exactly the
 * fields its own case needs, so the compiler supplies `request` and `cursor` on the arm that has
 * them and no caller has to re-check a condition already settled.
 */
type PageAdvance =
  /**
   * The trail continues, and the next request is already built and known good.
   *
   * `position` is the PARSED checkpoint position, not one assembled again later: the cursor was
   * validated against `resumePositionSchema` before the adapter was handed it, and carrying the
   * parsed value is what keeps the thing we store and the thing we checked from being two
   * different objects (SR-M-2).
   */
  | {
      kind: 'CONTINUE'
      cursor: string
      target: PageTarget
      request: PageRequest
      position: Extract<ResumePosition, { kind: 'CURSOR' }>
    }
  /** The provider returned a cursor the adapter cannot build a request from. */
  | { kind: 'UNUSABLE_CURSOR'; page: number; message: string }
  /** The provider's inventory ran out. */
  | { kind: 'EXHAUSTED' }

/** What a report says this page's URL was. */
function reportedUrl(page: PageRequest): string {
  return page.reportUrl ?? page.request.url
}

/**
 * Ask the adapter for a page request, and treat a throw as data.
 *
 * Called in TWO places, which is the point. Once for the page about to be fetched, and once for
 * the page a cursor would lead to — BEFORE that cursor is persisted. A cursor the adapter cannot
 * build a request from is unusable, and persisting it makes every later attempt reject before any
 * fetch, with nothing in the batch to say why.
 */
function buildPageRequest<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: PagedSourceSpec<TConfig, TEnvelope, TItem>,
  config: TConfig,
  at: PageTarget,
): BuiltPageRequest {
  try {
    return { ok: true, value: spec.pageRequest(config, at) }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'the page request could not be built',
    }
  }
}

/**
 * Decode a body through the adapter's slot, and treat a throw as data — the same guard
 * `buildPageRequest` gives `pageRequest`.
 *
 * `decodeEnvelope` is contracted to RETURN a refusal, and both shipped decoders are total, so this
 * is latent today. But it was the only adapter slot left unguarded, and a throw from it rejected
 * `collectPages` outright: no batch, and every page already persisted went unreported (CR-M-1). A
 * decoder that throws has broken its own contract, so it is `ADAPTER_INVARIANT` — the code for
 * "our adapter is wrong", not the provider's drift.
 */
function decodePage<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: PagedSourceSpec<TConfig, TEnvelope, TItem>,
  bodyText: string,
): DecodedEnvelope<TEnvelope> {
  try {
    return spec.decodeEnvelope(bodyText)
  } catch (error) {
    return {
      ok: false,
      code: 'ADAPTER_INVARIANT',
      message: `decodeEnvelope threw outside its contract: ${error instanceof Error ? error.message : 'a non-Error value'}`,
    }
  }
}

/**
 * The request headers that revalidate a cached response — one per validator the entry holds.
 *
 * A validator that is absent sends NO header rather than an empty one: `If-None-Match: ` with no
 * value is a malformed precondition. The loop writes an entry only when a validator arrived, but
 * the cache is a port and an entry with none can still come back from it; the caller treats an
 * empty result as "nothing cached", so such an entry never licenses a 304.
 */
function conditionalHeaders(cached: CachedResponse): Record<string, string> {
  const headers: Record<string, string> = {}
  if (isValidator(cached.etag)) headers['if-none-match'] = cached.etag
  if (isValidator(cached.lastModified)) headers['if-modified-since'] = cached.lastModified
  return headers
}

/**
 * A validator is a value that can be SENT. Absent and empty are the same answer: an empty
 * `Last-Modified` used to be stored and replayed as `if-modified-since: ""` — exactly the malformed
 * precondition the comment above promised never to send, because the check it relied on was
 * `!== undefined` and an empty header is defined (CR-M-3). Whitespace-only counts as empty for the
 * same reason. Used on BOTH sides — what is worth storing and what is sent — so the two cannot
 * disagree about what a validator is.
 */
function isValidator(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The key a page's response is cached under: the adapter's slot, and a digest of the REQUEST.
 *
 * WHY THE REQUEST AND NOT A LIST OF FIELDS (SR-H-1). The key used to be whatever the adapter named,
 * and the feed base named `[type, board, config version, page, cursor]` — five true fields, and
 * incomplete in exactly the dimension that mattered: two sources on one board under
 * `query=python` and `query=java` shared a key, a 304 on the second replayed the first's body, and
 * the batch reported SUCCEEDED with the wrong postings stored. Every enumeration of "what makes
 * two requests different" is one request parameter away from that defect, so the key is built from
 * what actually goes on the wire: method, URL (query and window live there), headers and body —
 * plus the spec's `type` and `adapterVersion`, so a redeployed mapping never revalidates a body
 * fetched for the old one. Two requests that differ in anything the provider can see cannot share
 * an entry.
 *
 * It is the request BEFORE the loop adds its own validators; those are what a cached entry
 * supplies, not what identifies it.
 *
 * A DIGEST, not the request verbatim: the request carries credentials (an `authorization` header,
 * an API key in the URL), and a cache key is stored. The slot stays readable in front of it so an
 * operator can still tell which page an entry belongs to.
 *
 * Two requests that are the same to the provider but spelled differently (header order, `GET` vs an
 * omitted method) get two entries. That costs a refetch, never a wrong body.
 *
 * THE WHOLE REQUEST OBJECT IS HASHED, NOT A LIST OF ITS FIELDS (CR-M-1 = SR-M-2). It used to be
 * `[type, adapterVersion, method, url, headers, body]` — an enumeration of the four fields
 * `FetchRequest` happens to have today, which is the very thing the paragraph above says is one
 * parameter away from SR-H-1. A fifth field (a per-source timeout, a redirect policy — anything the
 * provider can see) would have stayed out of the key with nothing failing.
 *
 * WHICH MECHANISM KEEPS IT CLOSED, and why it cannot silently pass: NEITHER a typecheck nor review
 * attentiveness, but CONSTRUCTION — a new field is part of `request`, so it enters the digest
 * whether or not anyone remembers it. There is no enumeration left to keep in sync, so there is no
 * exhaustiveness probe here either: under whole-object hashing such a probe would assert something
 * that cannot be false, which is the decoration this round is about. What a reader could still undo
 * is the whole-object hash itself, so THAT is what has a test —
 * `keys on a request field the digest never enumerated` sends a request carrying a field outside
 * `FetchRequest` and asserts the key changes; it fails the moment the body goes back to a field
 * list.
 *
 * WHAT THE DIGEST DOES NOT COVER, and the consequence (CR-M-4 = SR-M-5). It is `JSON.stringify`
 * of the request, so a future field that does not serialise faithfully is NOT a safe failure. A
 * KEY COLLISION means two different requests share one cache entry, and a 304 on that entry replays
 * the OTHER request's body — the SR-H-1 harm this digest exists to prevent, not a refetch. It is
 * reachable for any field that affects the response: a stream body or a redirect-policy object
 * renders identically for two different values, so two requests that should fetch different bodies
 * get one key. A BigInt or a cycle does not collide, it THROWS, so the failure for a non-plain field
 * is a throw or a wrong body, never a benign extra fetch. Nothing exercises this today: every
 * `FetchRequest` field is a plain string. The exposure is the next field someone adds, so a field
 * that is not plain JSON must be given an explicit, faithful serialisation here before it is added
 * to `FetchRequest`.
 */
function responseCacheKey(
  slot: string,
  spec: { readonly type: JobSourceType; readonly adapterVersion: string },
  request: FetchRequest,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([spec.type, spec.adapterVersion, request]))
    .digest('hex')
  return JSON.stringify([slot, digest])
}

/**
 * The cost an adapter read off a successful response, or `undefined` for "charge the whole
 * reservation". Only an integer in `0..reserved` is believed: a cost past the reservation is
 * drift in the adapter's reading, and settling it at face value would either be refused by the
 * store (leaving the hold unresolved) or, worse, understate what the page was reserved at.
 * Falling back to the whole reservation cannot overspend the reservation; it does NOT make a
 * billing basis safe, in either direction. A reading inside `0..reserved` is always believed, so a
 * wrong-but-in-range reading is settled at face value and frees the difference.
 */
function readIncurred(
  read: (bodyText: string) => number | null,
  bodyText: string,
  reserved: number,
): number | undefined {
  const amount = read(bodyText)
  if (!isWholeNumber(amount)) return undefined
  if (amount < 0 || amount > reserved) return undefined
  // The store cannot record a USED reservation of zero (its `used_settled` CHECK), so a free
  // request is reported as the smallest cost it can hold.
  return Math.max(amount, 1)
}

/** `Number.isSafeInteger` as a type guard: false for null, undefined, NaN, fractions and huge values. */
function isWholeNumber(value: number | null): value is number {
  return Number.isSafeInteger(value)
}

/**
 * A source's declared response cap must be a whole number of bytes the transport will accept:
 * refused here, with nothing yet reserved or sent, rather than discovered as a failed fetch.
 */
export function assertByteCap(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES_CEILING) {
    throw new Error(`invalid maxBytes: ${maxBytes} (must be 1..${MAX_RESPONSE_BYTES_CEILING})`)
  }
}

/**
 * The request as the transport must see it. A cap equal to the transport's own default is NOT
 * attached: it would change nothing, and every current caller keeps the request it had.
 */
function withByteCap(request: FetchRequest, maxBytes: number): FetchRequest {
  return maxBytes === DEFAULT_MAX_BYTES ? request : { ...request, maxBytes }
}

/** A cost hook that threw: our adapter is wrong, not the network. */
class CostHookError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'the cost hook threw a non-Error value')
  }
}

function readCostOrFlag(
  read: ((bodyText: string) => number | undefined) | undefined,
  bodyText: string,
): number | undefined {
  try {
    return read?.(bodyText)
  } catch (error) {
    throw new CostHookError(error)
  }
}

/** A throw out of the fetch seam, as a page failure. */
function failureOfThrown(error: unknown, aborted: boolean): PageAttemptFailure {
  // A programming error in an adapter is `ADAPTER_INVARIANT`, which no retry policy acts on; it
  // must never wear the code of a network blink.
  if (error instanceof CostHookError) {
    return { code: 'ADAPTER_INVARIANT', message: error.message, status: null }
  }
  // The transport refused the body at its cap and kept none of it: say so, not "network".
  if (error instanceof SourcePayloadTooLargeError) {
    return { code: 'PAYLOAD_TOO_LARGE', message: error.message, status: null }
  }
  return {
    code: aborted ? 'CANCELLED' : 'TRANSIENT_NETWORK',
    message: error instanceof Error ? error.message : 'the request failed',
    status: null,
  }
}

/** HTTP status -> our typed code. Classified from the STATUS, never from the body text. */
function classifyStatus(status: number): CollectionErrorCode | null {
  if (status >= 200 && status < 300) return null
  if (status === 304) return null
  if (status === 401 || status === 403) return 'ACCESS_POLICY'
  if (status === 429) return 'RATE_LIMIT'
  // No separate 5xx branch: it returned exactly what the fall-through returns, so it was four
  // mutants no test could ever distinguish. A 5xx and a 4xx differ in RETRY policy, which is Task
  // 2.2's and reads the status from the report — not in how this seam classifies them.
  return 'UPSTREAM'
}

interface PageAttemptFailure {
  code: CollectionErrorCode
  message: string
  status: number | null
}

/**
 * Collect every page the bounds allow, and report what happened.
 *
 * The ORDER of the three things that happen per page is the contract, not an implementation
 * detail: reserve -> fetch -> validate -> observe -> PERSIST, and the loop does not advance until
 * the persist resolves (AC4). `api-json.provider.spec.ts` asserts the recorded call order rather
 * than each call's presence, because a loop that made both calls in the wrong order would satisfy
 * every per-call assertion.
 */
export async function collectPages<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: PagedSourceSpec<TConfig, TEnvelope, TItem>,
  config: TConfig,
  ctx: CollectionContext,
): Promise<CollectionBatch> {
  const limits = spec.limits
  const overlapMs = spec.overlapMs ?? DEFAULT_OVERLAP_MS
  // At config time, at the seam that consumes the field: before the checkpoint is read, a
  // reservation is taken or a request is built, whichever binding set it.
  const requestMaxBytes = spec.requestMaxBytes ?? DEFAULT_MAX_BYTES
  assertByteCap(requestMaxBytes)

  const stored = await ctx.checkpoints.load()
  const decision = decideCheckpoint(stored, {
    configVersion: config.configVersion,
    policyVersion: ctx.policyVersion,
    adapterVersion: spec.adapterVersion,
  })

  let scope = spec.scopeOf(config, ctx.now())
  let at: PageTarget = { page: 1, cursor: null, window: scope.window }
  let checkpoint: ValidatedCheckpoint | null = null
  const resumed = decision.kind === 'RESUME'

  if (decision.kind === 'RESTART_WITH_OVERLAP') {
    // The cursor belonged to a config / policy / adapter that no longer exists (or did not parse
    // at all), so discovery starts over — and over a WIDER window, because whatever moved across
    // the old boundary while the config changed would otherwise never be read again.
    scope = widenScope(scope, overlapMs)
    // The widened window goes into the TARGET too, so the adapter asks the provider for the window
    // we are claiming to have covered. Assigning it only to `scope` is SPEC-H-1.
    at = { page: 1, cursor: null, window: scope.window }
  } else if (decision.kind === 'RESUME') {
    // Only a `CURSOR` position reaches here: `decideCheckpoint` turns a `RESTART` into `FRESH`.
    const position = decision.from.position
    at = { page: position.page + 1, cursor: position.cursor, window: scope.window }
    checkpoint = decision.from
  }

  /**
   * THE PAGE BOUND IS PER ATTEMPT, measured from where this attempt started.
   *
   * It used to compare the ABSOLUTE page against `maxPages`, which this file's own doc calls "pages
   * per attempt". Measured: run 1 completed 10 pages and stored page 10; run 2 resumed at page 11,
   * found `11 > 10`, made ZERO fetches and reported SUCCEEDED — and would do so for every run
   * after it, forever. The source froze at page 10, page 1 was never read again, and the outcome
   * claimed success (SR-H-1). An attempt must always be able to make progress.
   */
  const startPage = at.page

  const observations: SourceObservation[] = []
  const requests: RequestReport[] = []
  const samples: InvalidSample[] = []
  const counts: CollectionCounts = emptyAttemptCounts()
  // Seeding the RESUMED cursor is what makes a provider handing it straight back a cycle, and a
  // test asserts exactly that. (The suppression that used to sit here claimed the `null` half was
  // unobservable; the mutant it hid is killed by that same test, so it is gone — CR-M-2.)
  // Keyed on the DECISION, not on `at.cursor !== null`. The latter reads the same but its mutants
  // are unobservable: on a fresh run `at.cursor` is null, and adding a null to the set changes
  // nothing, because `has()` is only ever asked about a cursor the provider returned. Keyed this
  // way both halves bite — `RESUME` narrows the position to a `CURSOR`, so the cursor is a string
  // the compiler can see, and skipping the seed makes the cycle test fail.
  const seenCursors = new Set<string>(
    // Stryker disable next-line ArrayDeclaration: seeding this set with any non-cursor string is unobservable, because membership is only ever tested against a cursor the provider actually returned, and those are non-empty strings that cannot equal a placeholder.
    decision.kind === 'RESUME' ? [decision.from.position.cursor] : [],
  )
  const nativeIdByIdentityKey = new Map<string, string>()

  let pagesCompleted = 0
  // NO INITIALIZER, deliberately: the compiler now proves every path out of the loop assigns it.
  // It used to read `= 'EXHAUSTED'` under a suppression whose stated reason was that an
  // unrecognised value would throw in `deriveOutcome` — but `'EXHAUSTED'` is RECOGNISED, and it is
  // the one value that carries SUCCEEDED, so a path that forgot to assign would have reported a
  // silent success. Removing the initializer still typechecks, which means the proof was available
  // all along (CR-M-1).
  let stop: StopReason

  const addSample = (page: number, reason: string, raw: unknown): void => {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: the OBSERVABLE cap is
    // `buildCollectionBatch`'s slice, asserted on both sides in reporting-provider.spec.ts. This
    // early return bounds MEMORY while a 10 000-item page is being refused; it cannot change the
    // reported samples, so there is nothing for a test to catch here.
    if (samples.length >= MAX_SAMPLES) return
    samples.push(buildInvalidSample(page, reason, raw, ctx.secrets))
  }

  while (true) {
    if (at.page - startPage >= limits.maxPages) {
      stop = 'PAGE_CAP'
      // A bound we chose is still a reason the inventory is short, and `PAGE_CAP` is in
      // `COLLECTION_ERROR_CODES` precisely so it can be reported. It used to stop silently, so an
      // operator reading the reports saw a clean run that had simply stopped early.
      requests.push(
        buildRequestReport(
          {
            attempt: 1,
            page: at.page,
            url: UNBUILT_REQUEST_URL,
            status: null,
            startedAt: ctx.now(),
            endedAt: ctx.now(),
            cost: null,
            error: {
              code: 'PAGE_CAP',
              message: `the attempt reached its ${limits.maxPages}-page bound`,
            },
          },
          ctx.secrets,
        ),
      )
      break
    }

    const startedAt = ctx.now()
    // IN a try: `spec.pageRequest` is adapter code and it throws. It used to sit outside every
    // catch, so a cursor the adapter could not parse escaped `collectJsonPages` as a raw
    // `TypeError` — measured: no `CollectionBatch` at all, no outcome, no error code, nothing, and
    // permanently, because the cursor was already persisted (SR-H-3).
    const built = buildPageRequest(spec, config, at)
    if (!built.ok) {
      stop = 'ERROR'
      requests.push(
        buildRequestReport(
          {
            attempt: 1,
            page: at.page,
            url: UNBUILT_REQUEST_URL,
            status: null,
            startedAt,
            endedAt: ctx.now(),
            cost: null,
            error: { code: 'PARSE_DRIFT', message: built.message },
          },
          ctx.secrets,
        ),
      )
      break
    }
    const pageRequest = built.value

    if (ctx.signal.aborted) {
      stop = 'CANCELLED'
      requests.push(
        buildRequestReport(
          {
            attempt: 1,
            page: at.page,
            url: reportedUrl(pageRequest),
            status: null,
            startedAt,
            endedAt: ctx.now(),
            cost: null,
            error: { code: 'CANCELLED', message: 'the run was cancelled before this page' },
          },
          ctx.secrets,
        ),
      )
      break
    }

    if (ctx.now().getTime() >= ctx.deadline.getTime()) {
      stop = 'ERROR'
      requests.push(
        buildRequestReport(
          {
            attempt: 1,
            page: at.page,
            url: reportedUrl(pageRequest),
            status: null,
            startedAt,
            endedAt: ctx.now(),
            cost: null,
            error: { code: 'DEADLINE', message: 'the attempt deadline passed before this page' },
          },
          ctx.secrets,
        ),
      )
      break
    }

    // RESERVED before any I/O. A refusal is a cost stop, not an error: nothing went wrong, we are
    // simply out of budget, and everything already persisted stands.
    let reservation: MeterReservation | null = null
    // How this source reads the cost off a response; set with the reservation, absent otherwise.
    let costReader: ((bodyText: string) => number | undefined) | undefined
    if (spec.meter !== undefined) {
      const { incurredAmount, amountPerRequest } = spec.meter
      if (incurredAmount !== undefined) {
        costReader = (body) => readIncurred(incurredAmount, body, amountPerRequest)
      }
      reservation = await ctx.meter.reserve(spec.meter.unit, spec.meter.amountPerRequest)
      if (reservation === null) {
        stop = 'COST_STOP'
        requests.push(
          buildRequestReport(
            {
              attempt: 1,
              page: at.page,
              url: reportedUrl(pageRequest),
              status: null,
              startedAt,
              endedAt: ctx.now(),
              cost: null,
              error: { code: 'COST_STOP', message: 'the meter refused a reservation' },
            },
            ctx.secrets,
          ),
        )
        break
      }
    }

    let cost = reservation === null ? null : { unit: reservation.unit, amount: reservation.amount }

    // The failure paths below deliberately do NOT assign this: `failure !== null` short-circuits
    // before anything parses the body, so no test can observe what it holds on those paths.
    // Stryker disable next-line StringLiteral: unobservable for the reason above.
    let bodyText = ''
    let status: number
    let failure: PageAttemptFailure | null = null
    // A `let` because a cached validator rewrites it, and it is read by the reports below — which
    // are outside the span, so it cannot live inside the try.
    let request: FetchRequest = withByteCap(pageRequest.request, requestMaxBytes)

    /**
     * THE WHOLE RESERVE -> RECONCILE SPAN IS ONE TRY, WITH `reconcile` IN A `finally`.
     *
     * The hole was not the fetch — that was already caught — but the CACHE READ beside it.
     * `ctx.cache.get` sat outside every catch and after the reservation, so a cache that threw
     * left the meter log at `['reserve']` and rejected `collectJsonPages` outright: a reservation
     * held with no resolution. That is money, not telemetry (SR-M-1).
     *
     * Patching that one call would leave the same hole open for the next `await` anyone adds
     * between the reserve and the reconcile. A reservation is a RESOURCE — acquired on one line,
     * released on every path out — and in JavaScript that is spelled `finally`.
     *
     * `resolution` says WHICH release, and it advances WITH the request rather than being decided
     * inside the catch, where the catch cannot tell how far we got:
     *
     *   RELEASED  — nothing has left the process yet, so nothing can have been billed
     *   UNCERTAIN — the request is in flight; a timeout may already have been billed, and
     *               claiming RELEASED would understate what we owe
     *   USED      — a response provably arrived, whatever its status
     *
     * All three are reachable and asserted, so the `finally` is not a guard without a failing test.
     */
    let resolution: ReservationResolution = 'RELEASED'
    // The cost the provider actually charged, read off a FRESH successful response only.
    let incurred: number | undefined
    // True from the moment `markSent` is called: with `resolution` still RELEASED, a throw can only
    // have come from `markSent` itself, so the request was NEVER sent.
    let markSentStarted = false
    const cacheKey =
      pageRequest.cacheKey === undefined
        ? undefined
        : responseCacheKey(pageRequest.cacheKey, spec, pageRequest.request)

    try {
      const stored = cacheKey === undefined ? null : await ctx.cache.get(cacheKey)
      // An entry is only USABLE when it holds a validator to send: a 304 is an answer to a
      // precondition, and without one there was no question for it to answer.
      const validators = stored === null ? {} : conditionalHeaders(stored)
      const cached = Object.keys(validators).length > 0 ? stored : null
      if (cached !== null) {
        request = {
          ...request,
          headers: { ...request.headers, ...validators },
        }
      }

      /**
       * SENT is recorded BEFORE the request leaves, and awaited: the store releases only cost it
       * can prove unsent, and "provably unsent" means this write COMMITTED first. It sits after
       * the cache read (which can still fail without anything having left) and before the
       * `UNCERTAIN` assignment, so a `markSent` that fails leaves `RELEASED` — the request is not
       * sent, and the reservation is freed rather than held.
       */
      if (reservation !== null) {
        markSentStarted = true
        await ctx.meter.markSent(reservation)
      }
      resolution = 'UNCERTAIN'
      const response = await ctx.fetchText(request)
      resolution = 'USED'
      status = response.status
      const statusCode = classifyStatus(status)
      if (statusCode !== null) {
        failure = { code: statusCode, message: `provider answered HTTP ${status}`, status }
      } else if (status === 304 && cached !== null) {
        // A valid 304 reuses the stored body rather than refetching it.
        bodyText = cached.bodyText
      } else if (status === 304) {
        failure = {
          code: 'PARSE_DRIFT',
          message: 'provider answered 304 for a request that carried no validator',
          status,
        }
      } else {
        bodyText = response.bodyText
        // LOAD-BEARING ORDER: `incurred` is set only here, in the final `else` of the status chain,
        // after the 304 branch. A 304 therefore settles the whole reservation. If this read moved
        // above the 304 branch, a 304 would be settled at the CACHED body's record count and no test
        // would fail (there is no metered-304 test; TheirStack is a POST source, so it is barely
        // reachable there).
        incurred = readCostOrFlag(costReader, bodyText)
        const lastModified = response.headers['last-modified']
        if ((isValidator(response.etag) || isValidator(lastModified)) && cacheKey !== undefined) {
          /**
           * THE CACHE'S TWO FAILURES ARE NOT THE SAME FAILURE, AND DIRECTION IS WHAT DECIDES.
           *
           * A READ fails before anything was sent: we have no page, so the attempt reports it and
           * stops with its completed pages intact (the branch above).
           *
           * A WRITE fails AFTER a 200 whose body is already in hand. The page is complete and
           * valid; the only thing lost is the validator that would have saved a refetch next
           * time. Letting it reach the span's catch is CR-M-4: measured, a `put` rejecting after
           * a good 200 dropped the page entirely and reported `TRANSIENT_NETWORK` — a cache
           * outage blamed on the provider's network, with the page gone.
           *
           * So the write degrades and the page stands. The reservation is still resolved by the
           * `finally`, which is why this does not reopen SR-M-1.
           */
          try {
            await ctx.cache.put(cacheKey, {
              etag: response.etag,
              lastModified,
              bodyText,
            })
          } catch {
            // Deliberately nothing: see above. There is no report slot for "the page is fine but
            // the cache is not", and inventing one would mean a request report describing a
            // subrequest that succeeded.
          }
        }
      }
    } catch (error) {
      status = 0
      failure =
        // `RELEASED` is still set only while nothing has left the process — which is precisely
        // the condition under which the throw CANNOT be the provider's. It is our own storage,
        // so it is `PERSISTENCE`, the code this module already reserves for our fault (AC3).
        resolution === 'RELEASED'
          ? {
              code: 'PERSISTENCE',
              message: markSentStarted
                ? `the request was not sent, its reservation could not be marked sent: ${error instanceof Error ? error.message : 'the meter failed'}`
                : `the response cache could not be read: ${error instanceof Error ? error.message : 'the cache failed'}`,
              status: null,
            }
          : failureOfThrown(error, ctx.signal.aborted)
    } finally {
      if (reservation !== null) {
        /**
         * THE RECONCILE ITSELF CAN THROW, and that was the last way out of this span that lost
         * the attempt. Not one of the round's findings — found while re-reading the `finally` the
         * findings produced — but the same defect exactly one line further on: the meter port
         * rejecting left `collectJsonPages` rejecting, so every page already persisted went
         * unreported, and the reservation was unresolved either way.
         *
         * There is nothing to do about the unresolved reservation from here: the one call that
         * could resolve it is the call that failed. What CAN be saved is the batch, so the
         * attempt ends reporting a `PERSISTENCE` failure (our storage, not the provider's) and
         * the pages already persisted stand. Reporting beats rejecting, because an operator
         * needs to know the meter is unresolved precisely when it is.
         *
         * A failure already set is NOT overwritten: it says why the page failed, which is more
         * informative than the bookkeeping that failed afterwards.
         */
        try {
          await ctx.meter.reconcile(reservation, resolution, incurred)
          cost = { unit: reservation.unit, amount: incurred ?? reservation.amount }
        } catch (error) {
          failure ??= {
            code: 'PERSISTENCE',
            message: `the reservation could not be reconciled: ${error instanceof Error ? error.message : 'the meter failed'}`,
            status: null,
          }
        }
        reservation = null
      }
    }

    if (failure === null) {
      const envelope = decodePage(spec, bodyText)
      if (!envelope.ok) {
        failure = { code: envelope.code, message: envelope.message, status }
      } else {
        const pageResult = await observePage(
          spec,
          config,
          ctx,
          envelope.value,
          at,
          nativeIdByIdentityKey,
          addSample,
          limits,
        )
        if (!pageResult.ok) {
          // The page's items were received and then thrown away with the page.
          discardPageCounts(counts, pageResult.counts)
          failure = { ...pageResult.failure, status }
        } else {
          /**
           * THE CURSOR IS VERIFIED BEFORE IT IS PERSISTED.
           *
           * `savePage` used to store whatever `nextCursor` returned, and the loop then handed it
           * to `spec.pageRequest` on the NEXT iteration. A cursor the adapter cannot build a
           * request from therefore became permanent poison: measured with an adapter doing
           * `new URL(cursor)`, every later run threw before any fetch and produced no batch at
           * all (SR-H-3). So the next page's request is built HERE, on this side of the persist,
           * and an unusable cursor is stored as a `RESTART` instead — observations land, the
           * attempt ends with the drift reported, and the next attempt starts over rather than
           * replaying a rejection.
           */
          /**
           * ONE value answering "what happens after this page", as a union rather than three
           * nullable locals. The nullable form forced two branches nothing could enter — a
           * `nextTarget ?? {…}` fallback and a `nextRequest === null ? … : …` ternary, both
           * unreachable because the guards above already settled them — and it spread
           * `at.page + 1` over three sites, which is the arithmetic an off-by-one in would
           * reproduce SR-H-1 (a resumed attempt reporting SUCCEEDED after zero fetches). Now it
           * appears once, and every arm below is reachable and asserted.
           */
          const nextPage = at.page + 1
          const advance: PageAdvance =
            pageResult.nextCursor === null
              ? { kind: 'EXHAUSTED' }
              : ((): PageAdvance => {
                  const cursor = pageResult.nextCursor
                  /**
                   * THE CURSOR IS PARSED BEFORE THE ADAPTER IS HANDED IT, against the very
                   * schema the checkpoint will have to satisfy on the way back in.
                   *
                   * A cursor is the ONE value in this loop chosen entirely by the provider, and
                   * it was stored unparsed: `ValidatedCheckpoint` was built as an object
                   * literal, whose name is a claim and whose construction checks nothing.
                   * Measured, a 1 MiB cursor was persisted verbatim (SR-M-2).
                   *
                   * Parsed FIRST, before `buildPageRequest`, for two reasons: handing a
                   * megabyte of provider-chosen text to 25 adapters' URL builders is work
                   * nobody asked for, and a cursor we cannot store is unusable whether or not
                   * an adapter can build a request from it.
                   *
                   * The whole position is parsed rather than the cursor's length compared to
                   * `MAX_CURSOR_CHARS` here: one guard, one bound, declared in one place. The
                   * `RESTART` position below is deliberately NOT parsed — its only field is a
                   * page the loop itself bounded, so the parse would be a branch no input can
                   * enter.
                   */
                  const stored = cursorPositionSchema.safeParse({
                    kind: 'CURSOR',
                    page: at.page,
                    cursor,
                  })
                  if (!stored.success) {
                    return {
                      kind: 'UNUSABLE_CURSOR',
                      page: nextPage,
                      // Stryker disable next-line OptionalChaining: a Zod result with
                      // `success: false` always carries an issue, as elsewhere in this file;
                      // the fallback's absence is what the test asserts.
                      message: `it cannot be stored (${stored.error.issues[0]?.message ?? 'refused'})`,
                    }
                  }
                  const position = stored.data
                  const target: PageTarget = { page: nextPage, cursor, window: at.window }
                  const probe = buildPageRequest(spec, config, target)
                  return probe.ok
                    ? { kind: 'CONTINUE', cursor, target, request: probe.value, position }
                    : { kind: 'UNUSABLE_CURSOR', page: nextPage, message: probe.message }
                })()

          const position: ResumePosition =
            // The PARSED position on the continuing arm — the one the schema accepted, rather
            // than a second literal built from the same parts and checked by nothing.
            advance.kind === 'CONTINUE' ? advance.position : { kind: 'RESTART', page: at.page }

          const next: ValidatedCheckpoint = {
            configVersion: config.configVersion,
            policyVersion: ctx.policyVersion,
            adapterVersion: spec.adapterVersion,
            position,
            completedAt: ctx.now(),
          }
          try {
            // Observations AND checkpoint, together, before the loop may continue.
            await ctx.checkpoints.savePage({
              observations: pageResult.observations,
              checkpoint: next,
            })
            observations.push(...pageResult.observations)
            // AFTER the persist resolved, which is the only moment at which "kept" is true. A
            // page whose `savePage` rejects is the SECOND instance of CR-M-5 — the reviewer
            // named the observe-failure path, and this one has the same shape — and it is why
            // the merge lives here rather than beside `observePage`.
            keepPageCounts(counts, pageResult.counts)
            checkpoint = next
            pagesCompleted += 1
          } catch (error) {
            // OUR failure, not the provider's: it is PERSISTENCE and it never touches
            // `counts.invalid` (AC3) — those items go to `discarded`, the bucket for "received,
            // observed, then lost with the page". The page is not counted as completed, so the
            // checkpoint still names the last page that really landed.
            discardPageCounts(counts, pageResult.counts)
            failure = {
              code: 'PERSISTENCE',
              message: error instanceof Error ? error.message : 'the page could not be persisted',
              status,
            }
          }

          // Inside the branch where `pageResult` is known to have succeeded: the cursor it
          // carries only exists on that branch, and reading it from outside was what forced a
          // redundant re-check of a condition no test could falsify.
          if (failure === null) {
            requests.push(
              buildRequestReport(
                {
                  attempt: 1,
                  page: at.page,
                  url: reportedUrl(pageRequest),
                  status,
                  startedAt,
                  endedAt: ctx.now(),
                  cost,
                  error: null,
                },
                ctx.secrets,
              ),
            )
            if (advance.kind === 'EXHAUSTED') {
              stop = 'EXHAUSTED'
              break
            }
            if (advance.kind === 'UNUSABLE_CURSOR') {
              // The page is persisted and its position is a `RESTART`, so nothing is poisoned.
              // The attempt ends reporting WHY, which is the part that used to be missing.
              stop = 'ERROR'
              requests.push(
                buildRequestReport(
                  {
                    attempt: 1,
                    page: advance.page,
                    url: UNBUILT_REQUEST_URL,
                    status: null,
                    startedAt: ctx.now(),
                    endedAt: ctx.now(),
                    cost: null,
                    error: {
                      code: 'PARSE_DRIFT',
                      message: `the provider's next cursor is unusable: ${advance.message}`,
                    },
                  },
                  ctx.secrets,
                ),
              )
              break
            }
            if (seenCursors.has(advance.cursor)) {
              stop = 'CURSOR_CYCLE'
              // `CURSOR_CYCLE` is in `COLLECTION_ERROR_CODES`, and the stop used to push no
              // report carrying it — so a cycle was indistinguishable from a clean finish in
              // everything except the coverage axis (SR-L-4).
              requests.push(
                buildRequestReport(
                  {
                    attempt: 1,
                    page: advance.target.page,
                    // The request the cycle WOULD have sent — available by TYPE on this arm,
                    // which is what removed a `nextRequest === null ? …` ternary whose null
                    // branch no input could reach.
                    url: reportedUrl(advance.request),
                    status: null,
                    startedAt: ctx.now(),
                    endedAt: ctx.now(),
                    cost: null,
                    error: {
                      code: 'CURSOR_CYCLE',
                      message: 'the provider handed back a cursor this attempt had already seen',
                    },
                  },
                  ctx.secrets,
                ),
              )
              break
            }
            seenCursors.add(advance.cursor)
            // The very target whose request was validated before the persist.
            at = advance.target
            continue
          }
        }
      }
    }

    // Any failure that reached here ends the attempt, having kept every page already persisted.
    requests.push(
      buildRequestReport(
        {
          attempt: 1,
          page: at.page,
          url: reportedUrl(pageRequest),
          status: failure.status,
          startedAt,
          endedAt: ctx.now(),
          cost,
          error: { code: failure.code, message: failure.message },
        },
        ctx.secrets,
      ),
    )
    stop = failure.code === 'CANCELLED' ? 'CANCELLED' : 'ERROR'
    break
  }

  return buildCollectionBatch({
    observations,
    facts: { stop, pagesCompleted, counts, scope, resumed },
    requests,
    checkpoint,
    invalidSamples: samples,
  })
}

/**
 * The JSON binding of the loop: the body is bounded JSON, and the envelope is a Zod schema.
 *
 * Its signature and behaviour are what Task 2.3 shipped; only the body step moved behind
 * `decodeEnvelope`, so every assertion in `api-json.provider.spec.ts` still runs against it.
 */
/**
 * The headers a JSON adapter may send, as an ALLOWLIST (inverted from a denylist for the reason the
 * feed binding's `honestRequest` gives: a denylist is the impersonations someone thought of). It is
 * what the five quota adapters were MEASURED to send (a search of every `headers` they build): the
 * content-negotiation pair, `content-type` for the two POST bodies, and the credential headers of
 * the header-keyed schemes (`authorization`, RapidAPI's pair). A member nobody sends is not here:
 * `from` is by specification an e-mail address, the channel a User-Agent disclosure once went out
 * through, so it is added by the first adapter that needs it, with that argument. NOT here, and so
 * dropped: `user-agent` (the transport owns our outbound identity and sets the honest one by
 * default), `cookie`, `referer`, `origin`, `x-forwarded-for`. The loop's own conditional headers
 * are added AFTER this filter, so they are unaffected.
 */
export const ALLOWED_JSON_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'x-rapidapi-key',
  'x-rapidapi-host',
])

function withAllowedHeaders(page: PageRequest): PageRequest {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(page.request.headers ?? {})) {
    const key = name.toLowerCase()
    if (ALLOWED_JSON_REQUEST_HEADERS.has(key)) headers[key] = value
  }
  const { headers: _dropped, ...rest } = page.request
  return {
    ...page,
    request: Object.keys(headers).length === 0 ? rest : { ...rest, headers },
  }
}

export async function collectJsonPages<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: ApiJsonSourceSpec<TConfig, TEnvelope, TItem>,
  config: TConfig,
  ctx: CollectionContext,
): Promise<CollectionBatch> {
  const limits: ApiJsonLimits = { ...DEFAULT_API_JSON_LIMITS, ...spec.limits }
  return collectPages(
    {
      ...spec,
      pageRequest: (c, at) => withAllowedHeaders(spec.pageRequest(c, at)),
      limits,
      requestMaxBytes: limits.maxBytes,
      decodeEnvelope: (bodyText) => decodeJsonEnvelope(bodyText, spec.envelopeSchema, limits),
    },
    config,
    ctx,
  )
}

function decodeJsonEnvelope<TEnvelope>(
  bodyText: string,
  envelopeSchema: ZodType<TEnvelope>,
  limits: ApiJsonLimits,
): DecodedEnvelope<TEnvelope> {
  const parsed = parseBoundedJson(bodyText, limits)
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.reason === 'NOT_JSON' ? 'PARSE_DRIFT' : 'PAYLOAD_TOO_LARGE',
      message: `${parsed.reason}: ${parsed.detail}`,
    }
  }
  const envelope = envelopeSchema.safeParse(parsed.value)
  if (!envelope.success) {
    return {
      ok: false,
      code: 'PARSE_DRIFT',
      // Stryker disable next-line OptionalChaining: a Zod result with `success: false` always
      // carries at least one issue, so `issues[0]` is never undefined and the optional chain
      // cannot be made to fire. The FALLBACK is asserted to be unused (the test requires the
      // schema's own words), which is the half that can be observed.
      message: `envelope: ${envelope.error.issues[0]?.message ?? 'did not match'}`,
    }
  }
  return { ok: true, value: envelope.data }
}

/**
 * A discriminated union rather than one record with a nullable `failure`. With the flat shape, the
 * failure returns had to carry `observations: []` and `nextCursor: null` — fields the caller never
 * reads on that branch, so no test could tell what they held. A shape that cannot express the
 * contradiction needs no defending.
 */
type PageResult =
  | {
      ok: true
      observations: SourceObservation[]
      nextCursor: string | null
      counts: PageCounts
    }
  // `counts` is on BOTH arms because the caller reads it on both: a failed page's items were
  // still received, and the attempt still has to account for them. That is the opposite of the
  // `observations: []` / `nextCursor: null` padding this union replaced, which no caller read.
  | { ok: false; failure: { code: CollectionErrorCode; message: string }; counts: PageCounts }

/**
 * Validate and observe one page's items.
 *
 * It RETURNS this page's counts rather than adding them to the attempt's, which is the whole of
 * the CR-M-5 fix: whether a page's observations count as kept depends on what happens AFTER this
 * function returns (the page still has to persist), so this function is not the one that can
 * decide. It mutates only the cross-page identity map, which is genuinely attempt-scoped.
 */
async function observePage<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: PagedSourceSpec<TConfig, TEnvelope, TItem>,
  config: TConfig,
  ctx: CollectionContext,
  envelope: TEnvelope,
  at: PageTarget,
  nativeIdByIdentityKey: Map<string, string>,
  addSample: (page: number, reason: string, raw: unknown) => void,
  limits: PageLimits,
): Promise<PageResult> {
  const counts: PageCounts = emptyPageCounts()
  let items: readonly unknown[]
  try {
    items = spec.extractItems(envelope, config)
  } catch (error) {
    return {
      ok: false,
      counts,
      failure: {
        code: 'PARSE_DRIFT',
        message: error instanceof Error ? error.message : 'the items could not be extracted',
      },
    }
  }

  if (items.length > limits.maxItemsPerPage) {
    // The provider ignored the page size we asked for. Treating it as drift rather than silently
    // truncating keeps us from reporting a coverage we did not have.
    return {
      ok: false,
      counts,
      failure: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `page carried ${items.length} items, over the ${limits.maxItemsPerPage} cap`,
      },
    }
  }

  const observations: SourceObservation[] = []

  for (const item of items) {
    counts.raw += 1

    const validated = spec.itemSchema.safeParse(item)
    if (!validated.success) {
      counts.invalid += 1
      // Stryker disable next-line OptionalChaining: as above — a failed Zod result always has an
      // issue, so the optional chain is unreachable; the fallback's absence IS asserted.
      addSample(at.page, `ITEM_SCHEMA: ${validated.error.issues[0]?.message ?? 'invalid'}`, item)
      continue
    }

    let raw: RawObservationFields
    try {
      raw = {
        ...spec.mapItem(validated.data, config),
        provider: spec.type,
        adapterVersion: spec.adapterVersion,
      }
    } catch (error) {
      // An extractor exception is ONE bad item, not a bad page.
      counts.invalid += 1
      addSample(
        at.page,
        `MAPPER_THREW: ${error instanceof Error ? error.message : 'mapItem threw'}`,
        item,
      )
      continue
    }

    const result = buildSourceObservation(raw, { now: ctx.now() })
    if (!result.ok) {
      counts.quarantined += 1
      addSample(at.page, `QUARANTINED: ${result.reason}`, item)
      continue
    }

    const { identityKey, nativeId: keyedOn } = result.observation.identity
    // No `?? raw.nativeId` fallback: the spec field is required, so there is nothing to fall back
    // from, and the fallback was the defect (SPEC-M-1). An adapter that returns `null` here has
    // said so deliberately. Asked for EVERY item, before the gate below, because "report the
    // provider's id for this item" is the spec's contract and must not become conditional on how
    // identity happened to resolve (`is asked for every item, with the validated item and the
    // config` is the test that pins it).
    const issued = spec.nativeIdOf(validated.data, config)

    // WHETHER IDENTITY USED A NATIVE ID IS IDENTITY'S OWN ANSWER, NOT A SECOND NORMALISER'S
    // (SR-M-1). `identity.nativeId` is `null` exactly when identity fell back to the URL.
    //
    // The gate used to be `canonicalNativeId(issued) !== null`, which asked "is there a usable id"
    // with a function that answers it DIFFERENTLY from the one identity asks: identity's
    // `normalizeNativeId` is `canonicalNativeId` PLUS three refusals (empty, over
    // `MAX_NATIVE_ID_CHARS`, any C0/DEL character). Measured, the two disagreed on four inputs —
    // `"ab\tcd"`, `"ef\u0001gh"`, `"x".repeat(300)`, `"   "` — where the loop believed in an id
    // identity had declined, and only the length condition was reasoned about or covered. Two
    // functions that must agree is the defect; reading the one that decided is the fix, and a
    // FIFTH refusal added to the identity seam now moves those ids to the right branch by itself.
    if (keyedOn === null) {
      // IDENTITY COULD NOT TELL THESE POSTINGS APART, so the adapter's own id is the only evidence
      // left that they ARE different postings — which is the whole of what AC5 detects. Spelled
      // through `canonicalNativeId` so two spellings of one id are not read as a collapse (SR-M-3),
      // and an id that canonicalises to empty is NO id: an absent id cannot disagree with anything.
      //
      // DELIBERATELY NOT `identity.nativeId` ON BOTH SIDES, which is what the review prescribed.
      // Measured: `identityKey` CONTAINS `nativeId` on the NATIVE_ID branch, so equal keys imply
      // equal ids there and the comparison can never fire; on this branch both sides are `null`.
      // The guard becomes unreachable in every configuration — applied literally, both AC5
      // collapse-refusal tests flipped FAILED -> SUCCEEDED and every mutant of it would survive.
      const canonical = issued === null ? '' : canonicalNativeId(issued)
      // The suppression that used to sit here claimed this guard was unobservable. It is not, and
      // the difference is a false ADAPTER_INVARIANT: with the guard removed, an item whose provider
      // id is unknown records `''` against its identity key, and the NEXT item on that same key —
      // with a good id — compares `'' !== 'that id'` and is reported as a collapse. A success
      // becomes FAILED. `records a null native id without inventing a collision` kills it (CR-M-2).
      if (canonical !== '') {
        const seen = nativeIdByIdentityKey.get(identityKey)
        if (seen !== undefined && seen !== canonical) {
          // The offending item was already counted in `raw`, so it needs a disposition or the
          // balance invariant refuses the whole batch — and an adapter invariant failure would then
          // surface as an unhandled throw instead of the FAILED batch the ACs ask for. It is
          // `invalid`: we could not observe it as a distinct record.
          counts.invalid += 1
          return {
            ok: false,
            counts,
            failure: {
              code: 'ADAPTER_INVARIANT',
              message: new AdapterIdentityCollisionError(identityKey, seen, canonical).message,
            },
          }
        }
        nativeIdByIdentityKey.set(identityKey, canonical)
      }
    }

    // No de-duplication here on purpose. The store HAS a `duplicates` disposition and the
    // collector owns it; a provider that silently dropped a repeat would make its own `raw` count
    // unaccountable and hide a real re-listing from the collector.
    counts.normalized += 1
    observations.push(result.observation)
  }

  let nextCursor: string | null
  try {
    nextCursor = spec.nextCursor(envelope, at)
  } catch (error) {
    return {
      ok: false,
      counts,
      failure: {
        code: 'PARSE_DRIFT',
        message: error instanceof Error ? error.message : 'the next cursor could not be read',
      },
    }
  }

  return { ok: true, observations, nextCursor, counts }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * Turn a spec into a `ReportingJobSourceProvider`.
 *
 * This wrapper would fail the deletion test as a pass-through — except for what it makes
 * IMPOSSIBLE: there is no slot in which an adapter supplies `collectReport`, so the bounded loop,
 * the reserve-before-I/O ordering and the derived outcome cannot be replaced by one of 25 adapter
 * authors. That is behaviour, not indirection.
 */
export function defineApiJsonProvider<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: ApiJsonSourceSpec<TConfig, TEnvelope, TItem>,
): ReportingJobSourceProvider<Validated<TConfig>> {
  return definePagedProvider(spec, (config, ctx) => collectJsonPages(spec, config, ctx))
}

/**
 * The provider shell every binding of the loop shares: `parseConfig` validates and brands, and
 * `collectReport` refuses a config `parseConfig` never saw before handing it to `collect`.
 *
 * Shared rather than written once per binding (JSON, XML, feed) because the refusal is the part
 * that must not drift between them: a binding that forgot `assertValidatedConfig` would accept a
 * hand-built config the schema never checked, and nothing about the other two would show it.
 */
export function definePagedProvider<TConfig extends SourceConfigFields>(
  spec: { readonly type: JobSourceType; readonly configSchema: ZodType<TConfig> },
  collect: (config: TConfig, ctx: CollectionContext) => Promise<CollectionBatch>,
): ReportingJobSourceProvider<Validated<TConfig>> {
  return {
    type: spec.type,
    parseConfig(raw: unknown) {
      return markValidated(spec.configSchema.parse(raw))
    },
    async collectReport(config, ctx) {
      // A config that `parseConfig` never saw has not been validated, whatever its shape.
      assertValidatedConfig(config)
      return collect(config, ctx)
    },
  }
}
