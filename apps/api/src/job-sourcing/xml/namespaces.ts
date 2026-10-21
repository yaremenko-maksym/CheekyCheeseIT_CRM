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
 */

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
 * Split `prefix:local`.
 *
 * A name with no colon has no prefix. A name whose colon is leading or trailing, or which has more
 * than one, is not a legal QName — it is returned WHOLE as the local name with no prefix, so the
 * caller resolves it against the default namespace rather than inventing a prefix from a fragment.
 * Such a document is already namespace-ill-formed; mangling the name would make the resulting
 * error harder to read, not the document more acceptable.
 */
export function splitQName(qualifiedName: string): SplitName {
  const colon = qualifiedName.indexOf(':')
  if (colon <= 0 || colon === qualifiedName.length - 1) {
    return { prefix: null, localName: qualifiedName }
  }
  const prefix = qualifiedName.slice(0, colon)
  const localName = qualifiedName.slice(colon + 1)
  if (localName.includes(':')) return { prefix: null, localName: qualifiedName }
  return { prefix, localName }
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
    return new NamespaceScope({}, null)
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

    const bound = this.bindings[prefix]
    // `xmlns=""` undeclares the default namespace: declared, and bound to nothing.
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
  const declarations: Record<string, string> = {}
  const rest: (readonly [string, string])[] = []
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'xmlns') {
      declarations[''] = value
    } else if (name.startsWith('xmlns:')) {
      declarations[name.slice('xmlns:'.length)] = value
    } else {
      rest.push([name, value])
    }
  }
  return { declarations, rest }
}
