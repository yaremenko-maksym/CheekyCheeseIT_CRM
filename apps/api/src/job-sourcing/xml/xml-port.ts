/**
 * Seam 1 of the vacancy-sourcing XML stack — r5 Task 2.4a.
 *
 * `XmlPort` is **XML-generic on purpose**: besides ~25 RSS/Atom adapters it must also serve the
 * Personio helper, which is an XML-shaped API response and not a feed. A feed-only abstraction
 * would leave Personio no supported way in (Shape B, rejected in
 * `docs/architecture/2026-10-20-xml-parser-dependency-review.md`). Feed semantics — `<item>`,
 * `guid`, Atom link relations — belong to Seam 2 (`FeedPort`), which ships with the `RssProvider`
 * base once Task 2.3 lands `CollectionBatch`.
 *
 * WHAT THE PORT OWNS, AND WHY IT IS THE PORT AND NOT THE CALLERS
 * -------------------------------------------------------------
 * Byte bounds, encoding transcoding, the `<!DOCTYPE>` refusal, the hardened parser options and
 * namespace resolution. Delete this interface and none of that complexity disappears — it
 * resurfaces, duplicated, in `RssProvider` *and* in the Personio helper, and the parser's own node
 * type leaks into both. That is the deletion test, and it is why this seam earns its living.
 *
 * NO PARSER NAME APPEARS IN THIS FILE. The library is imported in exactly one place
 * (`parse-xml.adapter.ts`), which is the property that makes a swap cost one adapter instead of 25
 * call sites.
 */

/**
 * Why an observation returns a `reason` and not a parser message.
 *
 * Tests that assert a parser's error *text* do not survive replacing the parser; tests that assert
 * a `reason` do. The ADR is explicit about this ("only tests asserting behaviour … survive a swap
 * unchanged"), so the reason codes are the portable contract and the underlying message is carried
 * on `cause` for humans reading logs.
 */
export type XmlFailureReason =
  /** Body exceeded `maxBytes`. Checked on the BYTES, before any decoding. */
  | 'TOO_MANY_BYTES'
  /** The declared/sniffed encoding is not one `TextDecoder` supports. */
  | 'UNSUPPORTED_ENCODING'
  /** The bytes are not valid in the chosen encoding. `TextDecoder` is used with `fatal: true`. */
  | 'UNDECODABLE'
  /** A byte-order mark and the XML declaration name incompatible encoding families. */
  | 'ENCODING_CONFLICT'
  /** A `<!DOCTYPE` appeared. Checked on the DECODED STRING — a byte check misses UTF-16. */
  | 'DOCTYPE_FORBIDDEN'
  /** Element nesting deeper than `maxDepth`. Our bound, never the V8 stack's. */
  | 'TOO_DEEP'
  /** More elements than `maxElements`. The element count is the real bound on time AND memory. */
  | 'TOO_MANY_ELEMENTS'
  /** More elements than the wall-clock budget can afford at the measured parse throughput. */
  | 'TIME_BUDGET'
  /** Not well-formed XML — including an undefined entity and a truncated envelope. = drift. */
  | 'MALFORMED'
  /** A namespace prefix was used without being declared in scope. Namespace-ill-formed. */
  | 'UNDECLARED_PREFIX'
  /**
   * A name carries a colon where a QName may not — zero or two-and-more, or one at an end.
   *
   * Namespaces in XML 1.0 §7: "All element and attribute names contain either zero or one colon",
   * and §4 makes both halves `NCName`, which is "an XML Name minus the ':'". So `a:b:c`, `:x`,
   * `x:` and the bare declaration name `xmlns:` are all names the namespace layer cannot resolve.
   */
  | 'MALFORMED_QNAME'
  /**
   * A prefixed declaration had an empty value — `xmlns:p=""`.
   *
   * §5 NSC "No Prefix Undeclaring": "In a namespace declaration for a prefix … the attribute
   * value MUST NOT be empty." Undeclaring is a Namespaces **1.1** feature, and this port
   * implements 1.0. `xmlns=""` is the separate, legal case (§6.2 "MAY be empty") and stays.
   */
  | 'PREFIX_UNDECLARING'
  /**
   * A declaration touched one of the two reserved namespaces or reserved prefixes.
   *
   * §3 NSC "Reserved Prefixes and Namespace Names" — four distinct refusals: rebinding `xml` to
   * another URI, declaring `xmlns` at all, binding any other prefix to either reserved namespace
   * name, and making either of them the default namespace. Declaring `xmlns:xml` to its own
   * correct URI is explicitly permitted ("MAY, but need not, be declared") and is tolerated.
   */
  | 'RESERVED_NAMESPACE'
  /**
   * One element carried two attributes with the same expanded name.
   *
   * §6.3 NSC "Attributes Unique" — "equivalent to requiring that no element have two attributes
   * with the same expanded name". `a:x` and `b:x` with both prefixes bound to one URI are the
   * same attribute written twice, which the raw-name uniqueness XML itself enforces cannot see.
   */
  | 'DUPLICATE_ATTRIBUTE'
  /**
   * The pre-scan and the parser disagreed about depth or element count.
   *
   * This is an INTERNAL invariant failure, not a property of the input: the pre-scan exists to
   * bound work before the parser runs, so any divergence is a parser-differential bug in our
   * scanner. It is raised loudly rather than swallowed, because a pre-scan that silently
   * under-counts is a bound that is not a bound. `prescan.differential.spec.ts` asserts the two
   * agree across the whole corpus, so this reason should be unreachable in production.
   */
  | 'PRESCAN_DIFFERENTIAL'

/** Every refusal and every parse failure of the port arrives as this, carrying a portable reason. */
export class XmlPortError extends Error {
  readonly reason: XmlFailureReason

  constructor(reason: XmlFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'XmlPortError'
    this.reason = reason
  }
}

/**
 * The five bounds, all enforced BEFORE the parser sees the bytes.
 *
 * Values and the measurements behind them live in `xml-limits.ts`; this is only their shape.
 */
export interface XmlLimits {
  /** Cap on the raw body, in bytes. Checked pre-decode: decoding is itself work. */
  readonly maxBytes: number
  /** Cap on element nesting depth, root element = 1. */
  readonly maxDepth: number
  /** Cap on the total element count. Bounds memory as well as time. */
  readonly maxElements: number
  /**
   * Wall-clock budget for the parse, in ms.
   *
   * Enforced by CONVERSION, not by a timer: a deadline checked around a synchronous call bounds
   * nothing, because it is evaluated once the parse has already returned. The element count is
   * what parse time tracks (measured), so the budget is spent as an element ceiling in the
   * pre-scan — see `elementCeiling` in `xml-limits.ts`.
   */
  readonly maxWallClockMs: number
}

/** A resolved XML name. `namespaceUri` is `null` for a name in no namespace. */
export interface XmlName {
  readonly localName: string
  readonly prefix: string | null
  readonly namespaceUri: string | null
}

export interface XmlAttribute extends XmlName {
  readonly value: string
  /** The name exactly as written in the document, prefix included. */
  readonly qualifiedName: string
}

export interface XmlElementNode extends XmlName {
  readonly kind: 'element'
  /** The name exactly as written in the document, prefix included (e.g. `content:encoded`). */
  readonly qualifiedName: string
  /** Attributes, EXCLUDING `xmlns` / `xmlns:*` declarations — those are not content. */
  readonly attributes: readonly XmlAttribute[]
  /** Prefix → URI declared ON THIS ELEMENT. `''` is the key for the default namespace. */
  readonly namespaceDeclarations: Readonly<Record<string, string>>
  readonly children: readonly XmlNodeUnion[]
  /**
   * Concatenated DIRECT text children, CDATA already unwrapped and entities already decoded.
   *
   * Direct-only, deliberately: `collectText` gives the descendant-inclusive reading, and a feed
   * mapper that wants `<title>` wants the former. Conflating them is how `<item>`'s text ends up
   * containing every child's text.
   */
  readonly text: string
}

export interface XmlTextNode {
  readonly kind: 'text'
  readonly value: string
}

export type XmlNodeUnion = XmlElementNode | XmlTextNode

export interface XmlDocument {
  readonly root: XmlElementNode
  /** `encoding` from the XML declaration, verbatim and un-normalised, or `null` if absent. */
  readonly declaredEncoding: string | null
  /** The encoding actually used to decode the bytes (a `TextDecoder` label). */
  readonly effectiveEncoding: string
  /** Element nesting depth of the parsed tree, root = 1. */
  readonly depth: number
  /** Total element count of the parsed tree. */
  readonly elementCount: number
}

/**
 * Seam 1. The only thing ~25 adapters and the Personio helper are allowed to know about XML.
 *
 * Takes BYTES, not a string: every candidate parser accepts a JS string, which means byte→string
 * decoding — and the mojibake every parser produced on a `windows-1251` feed — happens before the
 * parser is reached. Handing the port a string would put that defect permanently outside the seam.
 */
export interface XmlPort {
  /** Parses, or throws `XmlPortError`. Never returns a partially-parsed document. */
  parseDocument(bytes: Uint8Array, limits?: XmlLimits): XmlDocument
}
