/**
 * Prefix → URI resolution. The gap the ADR priced in, paid once instead of twenty-five times.
 *
 * `@rgrove/parse-xml` does not resolve namespaces: element names keep their literal prefix
 * (`content:encoded`) and `xmlns` declarations arrive as ordinary attributes. Neither candidate
 * parser does better — `fast-xml-parser`'s only namespace feature, `removeNSPrefix`, throws the
 * information away. So this is wrapper work by design, not a defect of the choice, and it belongs
 * HERE: resolving it inside the port means the ~25 RSS adapters and the Personio helper each get a
 * resolved tree, rather than 25 copies of a prefix-matching convention that quietly disagree about
 * what `content:` means in a feed that chose a different prefix for the same namespace.
 *
 * The Atom fixture is the case that shows why prefix matching is not enough: a feed is free to
 * write `<atom:entry xmlns:atom="http://www.w3.org/2005/Atom">` where another writes `<entry
 * xmlns="http://www.w3.org/2005/Atom">`. Those are the same element. Matching on the literal
 * prefix says they are not.
 *
 * WHY THIS LAYER REFUSES RATHER THAN TOLERATES — and why that is not the obvious choice
 * -------------------------------------------------------------------------------------
 * A feed reader is normally right to be lenient: a missing `<description>` or a stray `&` costs
 * one field, and refusing the whole document to punish it serves nobody. Every rule below is the
 * other kind of defect. They are errors of **identity**, not of content: a tolerated `a:b:c`
 * resolves into the default namespace, and an adapter matching on `(localName, namespaceUri)` —
 * which is exactly the contract `xml-tree.ts` offers it — then matches an element the document
 * never contained. The failure surfaces as a plausible-looking vacancy with a wrong field, in a
 * cron run nobody is watching, with nothing in the log.
 *
 * So the trade is not leniency against strictness; it is a refused feed (visible, one reason
 * code, retried next run) against a silently wrong one (invisible, permanent). The port already
 * made this call once for `UNDECLARED_PREFIX`; these are the same class, found later.
 *
 * The empirical check on "are we now refusing real feeds?" is that the DOU golden outcomes and
 * the whole fixture corpus are unchanged by any of it. Namespace-ill-formed shapes do not occur
 * in feeds that were ever read by anything; these documents are hostile or hand-broken.
 *
 * WHAT IS DELIBERATELY *NOT* REFUSED
 * ----------------------------------
 * §3's last clause reserves every prefix beginning with `x`, `m`, `l` in any case, and then says
 * processors "MUST NOT treat them as fatal errors". So the checks below special-case exactly the
 * two names `xml` and `xmlns`; a feed using `xmlfoo:` or `XML-x:` resolves normally. Nor does
 * this file validate `NCName` character by character: `@rgrove/parse-xml` has already enforced
 * the XML `Name` production on every name that reaches us, and `NCName` is defined as "an XML
 * Name minus the ':'" (§4), so checking where the colons are is exactly the remaining gap.
 */

import type { XmlAttribute } from './xml-port'
import { XmlPortError } from './xml-port'

/** Bound to the `xml` prefix for every document; never declared, never redefinable. */
export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
/** The namespace of the `xmlns` attributes themselves. */
export const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'

/** Namespaces of the feed vocabularies Seam 2 will consume. Here so adapters share one spelling. */
export const FEED_NAMESPACES = Object.freeze({
  atom: 'http://www.w3.org/2005/Atom',
  content: 'http://purl.org/rss/1.0/modules/content/',
  dublinCore: 'http://purl.org/dc/elements/1.1/',
  rss1: 'http://purl.org/rss/1.0/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
})

/** A qualified name split at its single colon. */
export interface SplitName {
  readonly prefix: string | null
  readonly localName: string
}

/**
 * Split `prefix:local`, refusing anything that is not a QName.
 *
 * A name with no colon has no prefix and resolves against the default namespace. A name whose
 * colon is leading or trailing, or which carries more than one, is **not a QName** (§7: "either
 * zero or one colon"; §4: both halves are `NCName`) and is refused with `MALFORMED_QNAME`.
 *
 * THIS FUNCTION USED TO TOLERATE THOSE NAMES, and the comment where this one now stands said the
 * document was "already namespace-ill-formed" — which was true, and was precisely the problem:
 * nothing downstream ever acted on it. `a:b:c` came back whole as a local name with no prefix, so
 * it resolved into the DEFAULT namespace and an adapter looking for `(c, …)` or `(b:c, …)` simply
 * did not find it, while one looking for `(a:b:c, default-ns)` found an element the document does
 * not contain. The honest reading of "ill-formed" is a refusal, and the old text argued for one
 * ("mangling the name would make the error harder to read") without there being an error at all.
 */
export function splitQName(qualifiedName: string): SplitName {
  const colon = qualifiedName.indexOf(':')
  if (colon === -1) return { prefix: null, localName: qualifiedName }
  if (colon === 0 || colon === qualifiedName.length - 1) {
    throw new XmlPortError(
      'MALFORMED_QNAME',
      `name ${JSON.stringify(qualifiedName)} has a leading or trailing colon, so it is not a QName`,
    )
  }
  const prefix = qualifiedName.slice(0, colon)
  const localName = qualifiedName.slice(colon + 1)
  if (localName.includes(':')) {
    throw new XmlPortError(
      'MALFORMED_QNAME',
      `name ${JSON.stringify(qualifiedName)} has more than one colon, so it is not a QName`,
    )
  }
  return { prefix, localName }
}

/**
 * A prefix → URI map with **no prototype**, which is load-bearing rather than fastidious.
 *
 * A prefix is attacker-chosen text used as an object key, and a plain `{}` answers for keys no
 * document declared. Three measured consequences of the `{}` this replaced, all from one feed:
 *
 *   `<constructor:a/>`  →  `namespaceUri` was `function Object()`, and the field's declared type
 *                          is `string | null`. The type lied, and ~25 adapters inherit the lie.
 *   `<toString:a/>`     →  same, with a value that is not even JSON-serialisable.
 *   `xmlns:__proto__`   →  the assignment set the map's PROTOTYPE instead of a key, so a legal
 *                          declaration vanished silently and `__proto__:a` then resolved to
 *                          `Object.prototype`, an object where a URI belongs.
 *
 * Neither pollution nor execution was reachable through it — the values only ever leave as tree
 * fields — so this was type integrity and a bypass of `UNDECLARED_PREFIX`, not a breach. The
 * bypass is the part that mattered: the bound said "a prefix must be declared" and `constructor`
 * was declared by JavaScript.
 *
 * `lookup` additionally goes through `Object.hasOwn` rather than trusting the prototype to be
 * absent, because `child()` is public and takes a caller's object. Null prototype makes the
 * inherited keys absent; `hasOwn` makes the absence not depend on that.
 */
function emptyBindings(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

/**
 * An immutable scope chain. Each element pushes a child scope carrying its own declarations, so
 * leaving the element restores the parent's bindings for free — no pop, no mutation, no chance of
 * a sibling inheriting a cousin's prefix.
 */
export class NamespaceScope {
  private constructor(
    private readonly bindings: Readonly<Record<string, string>>,
    private readonly parent: NamespaceScope | null,
  ) {}

  static root(): NamespaceScope {
    return new NamespaceScope(emptyBindings(), null)
  }

  /** `declarations` maps prefix → URI, with `''` for the default namespace. */
  child(declarations: Readonly<Record<string, string>>): NamespaceScope {
    if (Object.keys(declarations).length === 0) return this
    return new NamespaceScope(declarations, this)
  }

  /**
   * URI bound to `prefix`, or `null` for "bound to no namespace".
   *
   * `null` is returned for two different-looking cases that are the same thing: an undeclared
   * default namespace, and a default namespace undeclared again by `xmlns=""`. Both mean the
   * element is in no namespace. A prefix that was never declared returns `undefined`, which is
   * namespace-ill-formed and must NOT be conflated with "no namespace" — see `UNDECLARED_PREFIX`.
   *
   * Walks the chain by recursion, which is safe HERE for a reason worth stating rather than
   * assuming: `child()` returns `this` when an element declares nothing, so the chain holds one
   * link per DECLARING ancestor, not one per element. Its length is bounded by `MAX_XML_DEPTH`
   * (100) in the worst case a document can construct, and by one or two in any real feed.
   */
  lookup(prefix: string): string | null | undefined {
    if (prefix === 'xml') return XML_NAMESPACE
    if (prefix === 'xmlns') return XMLNS_NAMESPACE

    // Gated on `Object.hasOwn`, not on `bindings[prefix] !== undefined`: the latter answered for
    // every inherited member of `Object.prototype` — see `emptyBindings` above. Written as a
    // ternary rather than an `if` + cast so that `noUncheckedIndexedAccess` stays satisfied
    // without asserting anything, which is the same trade `endOfStartTag` makes in `prescan.ts`.
    const bound = Object.hasOwn(this.bindings, prefix) ? this.bindings[prefix] : undefined
    // `xmlns=""` undeclares the default namespace: declared, and bound to nothing. A PREFIXED
    // declaration can no longer be empty (`PREFIX_UNDECLARING` refuses it), so this branch is now
    // reached only by `xmlns=""`, where `prefix` is `''`.
    if (bound !== undefined) return bound === '' ? null : bound
    if (this.parent !== null) return this.parent.lookup(prefix)
    return prefix === '' ? null : undefined
  }
}

/** Declarations found on one element, and the attributes that are not declarations. */
export interface PartitionedAttributes {
  /** prefix → URI, `''` keyed for `xmlns="…"`. */
  readonly declarations: Record<string, string>
  /** `[qualifiedName, value]` for every attribute that is not an `xmlns` declaration. */
  readonly rest: readonly (readonly [string, string])[]
}

/**
 * Split an element's raw attributes into namespace declarations and content.
 *
 * `xmlns` declarations are kept OUT of the neutral tree's `attributes`, because they are not data:
 * an adapter iterating `<item>`'s attributes should not have to know to skip them, and an adapter
 * that forgets will emit a namespace URI as if it were a vacancy field. They remain reachable on
 * `namespaceDeclarations` for anything that genuinely needs to see them.
 */
export function partitionAttributes(
  attributes: Readonly<Record<string, string>>,
): PartitionedAttributes {
  const declarations = emptyBindings()
  const rest: (readonly [string, string])[] = []
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'xmlns') {
      declarations[''] = checkDefaultDeclaration(value)
    } else if (name.startsWith('xmlns:')) {
      const prefix = name.slice('xmlns:'.length)
      declarations[checkPrefixDeclaration(prefix, value, name)] = value
    } else {
      rest.push([name, value])
    }
  }
  return { declarations, rest }
}

/**
 * The reserved namespace a URI is, if it is one. Both are refused as a declaration TARGET for any
 * prefix other than the one they belong to, per §3: "Other prefixes MUST NOT be bound to this
 * namespace name, and it MUST NOT be declared as the default namespace."
 */
function reservedNamespaceName(uri: string): 'xml' | 'xmlns' | null {
  if (uri === XML_NAMESPACE) return 'xml'
  if (uri === XMLNS_NAMESPACE) return 'xmlns'
  return null
}

/** `xmlns="…"`. Empty is legal here and only here (§6.2); the reserved URIs are not. */
function checkDefaultDeclaration(value: string): string {
  const reserved = reservedNamespaceName(value)
  if (reserved !== null) {
    throw new XmlPortError(
      'RESERVED_NAMESPACE',
      `xmlns="${value}" makes the reserved ${reserved} namespace the default, which §3 forbids`,
    )
  }
  return value
}

/**
 * `xmlns:<prefix>="<value>"`. Returns the prefix so the caller cannot use it unchecked.
 *
 * Four refusals and one deliberate tolerance, each traced to its constraint:
 *
 *   `xmlns:`             MALFORMED_QNAME     the prefix is empty, and `Prefix ::= NCName` (§4).
 *                                            This is the one that previously acted as a DEFAULT
 *                                            declaration: `'xmlns:'.slice(6)` is `''`, and `''`
 *                                            is the key `xmlns=` writes.
 *   `xmlns:a:b`          MALFORMED_QNAME     an `NCName` is "an XML Name minus the ':'" (§4).
 *   `xmlns:p=""`         PREFIX_UNDECLARING  §5 NSC: the value "MUST NOT be empty".
 *   `xmlns:xmlns=…`      RESERVED_NAMESPACE  §3: the `xmlns` prefix "MUST NOT be declared."
 *   `xmlns:xml="other"`  RESERVED_NAMESPACE  §3: "MUST NOT be bound to any other namespace name."
 *   `xmlns:q="<xml ns>"` RESERVED_NAMESPACE  §3: "Other prefixes MUST NOT be bound to this
 *                                            namespace name."
 *   `xmlns:xml="<xml ns>"`  TOLERATED        §3: "MAY, but need not, be declared." A feed that
 *                                            spells out the binding it already has is correct,
 *                                            and refusing it would be stricter than the spec.
 */
function checkPrefixDeclaration(prefix: string, value: string, name: string): string {
  if (prefix === '') {
    throw new XmlPortError(
      'MALFORMED_QNAME',
      `attribute ${JSON.stringify(name)} declares an empty prefix; Prefix ::= NCName is not empty`,
    )
  }
  if (prefix.includes(':')) {
    throw new XmlPortError(
      'MALFORMED_QNAME',
      `declaration ${JSON.stringify(name)} has a colon in its prefix, which an NCName may not`,
    )
  }
  if (value === '') {
    throw new XmlPortError(
      'PREFIX_UNDECLARING',
      `xmlns:${prefix}="" undeclares a prefix, which Namespaces in XML 1.0 §5 forbids (1.1 only)`,
    )
  }
  if (prefix === 'xmlns') {
    throw new XmlPortError(
      'RESERVED_NAMESPACE',
      'the xmlns prefix must not be declared (§3), whatever it is declared to',
    )
  }
  const reserved = reservedNamespaceName(value)
  // The single legal declaration of a reserved namespace: `xml` to its own URI.
  if (reserved === 'xml' && prefix === 'xml') return prefix
  if (reserved !== null) {
    throw new XmlPortError(
      'RESERVED_NAMESPACE',
      `prefix ${JSON.stringify(prefix)} may not be bound to the reserved ${reserved} namespace`,
    )
  }
  if (prefix === 'xml') {
    throw new XmlPortError(
      'RESERVED_NAMESPACE',
      `the xml prefix may not be rebound to ${JSON.stringify(value)} (§3)`,
    )
  }
  return prefix
}

/**
 * Resolve one element's non-declaration attributes, and enforce §6.3 NSC "Attributes Unique".
 *
 * WHY THIS LIVES HERE AND NOT IN THE ADAPTER, where it used to. Everything in this function is a
 * rule of Namespaces in XML, not a property of `@rgrove/parse-xml`. Left in the adapter it was
 * work a replacement adapter would have to reproduce from the spec — which is the opposite of
 * what a one-adapter seam is for. See the seam note in `parse-xml.adapter.ts`.
 */
export function resolveAttributes(
  rest: readonly (readonly [string, string])[],
  scope: NamespaceScope,
  ownerName: string,
): XmlAttribute[] {
  const resolved = rest.map(([qualifiedName, value]): XmlAttribute => {
    const { prefix, localName } = splitQName(qualifiedName)
    if (prefix === null) {
      // An unprefixed attribute is in NO namespace — it does NOT take the default namespace.
      // Getting this wrong would make `isPermaLink` on `<guid>` land in the Atom namespace on any
      // feed that declared one as its default.
      return { localName, prefix: null, namespaceUri: null, value, qualifiedName }
    }
    const namespaceUri = scope.lookup(prefix)
    if (namespaceUri === undefined) {
      throw new XmlPortError(
        'UNDECLARED_PREFIX',
        `attribute ${qualifiedName} on <${ownerName}> uses prefix ${JSON.stringify(prefix)}, which is not declared in scope`,
      )
    }
    return { localName, prefix, namespaceUri, value, qualifiedName }
  })

  // Keyed on the EXPANDED name. XML itself already rejects two attributes with the same literal
  // name (WFC: Unique Att Spec), which is why this check has to exist separately: `a:x` and `b:x`
  // with both prefixes bound to one URI are literally distinct and expand to one attribute.
  // A `Map` rather than an object for the same reason `emptyBindings` exists — `localName` and the
  // URI are both document text.
  //
  // `JSON.stringify` of the PAIR, not a template with a separator and a `??` for the null
  // namespace: a coalesce there would be an unobservable mutant. No two attributes in NO namespace
  // can collide (XML's own WFC rejects a repeated literal name), so nothing can tell `null` from
  // `''` apart in the key, and `??` → `&&` would survive. Stringifying the tuple removes the
  // operator instead of suppressing the mutant, as this branch has done throughout.
  const seen = new Map<string, string>()
  for (const attribute of resolved) {
    const expanded = JSON.stringify([attribute.namespaceUri, attribute.localName])
    const first = seen.get(expanded)
    if (first !== undefined) {
      throw new XmlPortError(
        'DUPLICATE_ATTRIBUTE',
        `<${ownerName}> has ${first} and ${attribute.qualifiedName}, two attributes with the same expanded name`,
      )
    }
    seen.set(expanded, attribute.qualifiedName)
  }
  return resolved
}
