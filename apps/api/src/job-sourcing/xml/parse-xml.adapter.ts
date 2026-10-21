/**
 * The ONLY file in the repository that imports an XML parser.
 *
 * That is the property the seam exists to provide, and it is the one worth checking mechanically:
 * `parse-xml.adapter.spec.ts` asserts no other file under `apps/api/src` imports
 * `@rgrove/parse-xml`. If a second import appears, the "swap costs one adapter, not 25 call sites"
 * claim stops being true, and it stops being true quietly.
 *
 * Package: `@rgrove/parse-xml@5.0.0` (ISC), adopted on measurement in
 * `docs/architecture/2026-10-20-xml-parser-dependency-review.md`. Two facts carry that decision:
 * the internal subset is never parsed (so no entity is ever DECLARED, and there is nothing to
 * expand), and `dist/` references no `fs`/`http`/`https`/`net`/`dns`/`tls`/`child_process` (so no
 * configuration can make it read a file or open a socket). Neither is an option one can flip.
 *
 * WHAT THIS ADAPTER STILL HAS TO CLOSE
 * ------------------------------------
 * The weaker claim "no option touches entities" is FALSE, and was falsified during review. Two of
 * the eight options bear on entity handling, and both are pinned below:
 *
 *   `ignoreUndefinedEntities`  must stay `false`  — a DRIFT gate. Measured with `true`: a feed
 *                                                   carrying `&x;` parses "successfully" and
 *                                                   yields the literal `&x;`. That is a malformed
 *                                                   feed accepted as content — the plan's
 *                                                   "malformed feed = drift" requirement inverted.
 *   `resolveUndefinedEntity`   must NEVER be supplied — a SECURITY gate. It is the only route by
 *                                                   which entity substitution can enter at all,
 *                                                   and a resolver that read files would be
 *                                                   caller-authored XXE. Its appearance in a diff
 *                                                   is a review BLOCK.
 *
 * Both are pinned by assertions on the options object actually handed to `parseXml`, not by this
 * comment and not by a local variable — see R-1 and `parse-xml.adapter.options.spec.ts`. The ADR's
 * own earlier attempt pinned a local variable instead, which left a resolver injected at the call
 * site invisible.
 */

import {
  parseXml,
  XmlDeclaration as LibDeclaration,
  XmlElement as LibElement,
  XmlNode as LibNode,
  XmlText as LibText,
} from '@rgrove/parse-xml'
import {
  NamespaceScope,
  partitionAttributes,
  resolveAttributes,
  splitQName,
  XMLNS_NAMESPACE,
} from './namespaces'
import type { XmlAttribute, XmlElementNode, XmlNodeUnion, XmlTextNode } from './xml-port'
import { XmlPortError } from './xml-port'

/**
 * The hardened option set, frozen.
 *
 * Frozen because this object is handed to the library on every parse: a module-level object that
 * anything could mutate once would turn a pinned option into a runtime-mutable one, and the
 * call-site assertion would still pass on the first call.
 *
 * Every option the library offers is listed EXPLICITLY, including the ones set to their defaults.
 * An absent option and an option set to its default behave identically today and diverge the day
 * the library changes a default — and a changed default is precisely the drift this file is for.
 * `resolveUndefinedEntity` is the single deliberate omission.
 */
export const HARDENED_PARSE_OPTIONS = Object.freeze({
  /** DRIFT GATE — see the file header. */
  ignoreUndefinedEntities: false,
  /** CDATA arrives as ordinary text; markup inside it stays inert. */
  preserveCdata: false,
  preserveComments: false,
  /** Do not even retain the DTD node. The port refuses `<!DOCTYPE` before this anyway. */
  preserveDocumentType: false,
  /** Needed: the declared encoding is reconciled against the one we decoded with. */
  preserveXmlDeclaration: true,
  /** Attribute order stays document order, so a mapper can prefer the first of a repeated name. */
  sortAttributes: false,
  includeOffsets: false,
})

/** The exact key set of `HARDENED_PARSE_OPTIONS`, for the call-site assertion to compare against. */
export const HARDENED_OPTION_KEYS: readonly string[] = Object.freeze(
  Object.keys(HARDENED_PARSE_OPTIONS).sort(),
)

/** Result of parsing a STRING. Bounds and decoding happen before this; see `bounded-xml-port.ts`. */
export interface AdapterDocument {
  readonly root: XmlElementNode
  readonly declaredEncoding: string | null
}

/**
 * Map one library element to a neutral element, iteratively.
 *
 * Iteratively because a recursive map spends a stack frame per nesting level, and the stack cliff
 * is the thing `MAX_XML_DEPTH` exists not to inherit — a parser that returns a tree we then
 * overflow walking would have moved the cliff rather than removed it. The two-phase walk builds
 * children before their parent so every node can be constructed `readonly` in one shot.
 */
function toNeutralTree(libRoot: LibElement): XmlElementNode {
  interface Frame {
    element: LibElement
    scope: NamespaceScope
    declarations: Record<string, string>
    attributes: XmlAttribute[]
    name: { prefix: string | null; localName: string; namespaceUri: string | null }
    children: XmlNodeUnion[]
    /** Library children still to visit, in reverse order. */
    pending: LibNode[]
  }

  const open = (element: LibElement, parentScope: NamespaceScope): Frame => {
    const { declarations, rest } = partitionAttributes(element.attributes)
    const scope = parentScope.child(declarations)
    const { prefix, localName } = splitQName(element.name)
    const namespaceUri = scope.lookup(prefix ?? '')
    if (namespaceUri === undefined) {
      throw new XmlPortError(
        'UNDECLARED_PREFIX',
        `element <${element.name}> uses prefix ${JSON.stringify(prefix)}, which is not declared in scope`,
      )
    }
    // §3: "Element names MUST NOT have the prefix xmlns." The only prefix that can resolve to this
    // URI is `xmlns` itself — `checkPrefixDeclaration` refuses binding any other prefix to it —
    // so this one test covers the constraint. The reason code was `UNDECLARED_PREFIX`, which was
    // the wrong word for it: the prefix IS declared, by the spec, and that is the problem.
    if (namespaceUri === XMLNS_NAMESPACE) {
      throw new XmlPortError(
        'RESERVED_NAMESPACE',
        `element <${element.name}> may not use the xmlns prefix (§3)`,
      )
    }
    return {
      element,
      scope,
      declarations,
      attributes: resolveAttributes(rest, scope, element.name),
      name: { prefix, localName, namespaceUri },
      children: [],
      pending: [...element.children].reverse(),
    }
  }

  const close = (frame: Frame): XmlElementNode => ({
    kind: 'element',
    localName: frame.name.localName,
    prefix: frame.name.prefix,
    namespaceUri: frame.name.namespaceUri,
    qualifiedName: frame.element.name,
    attributes: frame.attributes,
    namespaceDeclarations: frame.declarations,
    children: frame.children,
    text: frame.children.reduce(
      (acc, child) => (child.kind === 'text' ? acc + child.value : acc),
      '',
    ),
  })

  const stack: Frame[] = [open(libRoot, NamespaceScope.root())]

  for (;;) {
    const frame = stack[stack.length - 1] as Frame
    const next = frame.pending.pop()

    if (next === undefined) {
      const finished = close(frame)
      stack.pop()
      if (stack.length === 0) return finished
      ;(stack[stack.length - 1] as Frame).children.push(finished)
      continue
    }

    if (next instanceof LibElement) {
      stack.push(open(next, frame.scope))
      continue
    }

    // `instanceof LibText` rather than a `.text` duck-check, and NOT a cast: `XmlCdata extends
    // XmlText`, so this one test covers text and any CDATA that reached us, while a processing
    // instruction — which also carries a string but is not content — is excluded by its type
    // rather than by a name comparison that a library rename would break silently.
    // Comments and the doctype never arrive at all (`preserveComments` / `preserveDocumentType`).
    if (next instanceof LibText) {
      const node: XmlTextNode = { kind: 'text', value: next.text }
      frame.children.push(node)
    }
  }
}

/**
 * Parse a STRING with the hardened options and return a neutral tree.
 *
 * Deliberately separate from the bounds and the `<!DOCTYPE` refusal, so the parser layer can be
 * exercised with those gates BYPASSED. R-1 requires exactly that: the ADR's XXE assertion was
 * masked by its own `<!DOCTYPE` pre-reject, which fires before the parser runs — so an *expanding*
 * parser behind that gate would have passed the assertion written to detect one. A capability test
 * has to reach the parser.
 */
export function parseXmlString(text: string): AdapterDocument {
  let libDocument
  try {
    libDocument = parseXml(text, HARDENED_PARSE_OPTIONS)
  } catch (cause) {
    // Mapped to one reason on purpose. The parser's own message is informative but
    // parser-specific; an adapter for a different library would word it differently, and tests
    // asserting the TEXT would not survive the swap the seam exists to make cheap. The message is
    // preserved on `cause` for logs.
    throw new XmlPortError('MALFORMED', `XML is not well-formed: ${messageOf(cause)}`, { cause })
  }

  const root = libDocument.root
  if (root === null) {
    throw new XmlPortError('MALFORMED', 'XML has no root element')
  }

  // The declaration is a CHILD of the document, not a property of it: there is no
  // `document.declaration` accessor, and `preserveXmlDeclaration: true` is what puts the node in
  // `children` for this search to find.
  const declaration = libDocument.children.find(
    (child): child is LibDeclaration => child instanceof LibDeclaration,
  )

  return {
    root: toNeutralTree(root),
    declaredEncoding: declaration?.encoding ?? null,
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
