/**
 * Reading an `XmlDocument`: the query surface Seam 2 and the Personio helper share.
 *
 * These helpers are XML-generic on purpose. The moment one of them knows what an `<item>` is, the
 * Personio path has to route an API response through feed vocabulary — the Shape B failure the ADR
 * rejected. Feed semantics live one layer up.
 */

import type { XmlElementNode, XmlNodeUnion } from './xml-port'

/**
 * "Any namespace" for a query. A symbol, not the string `'any'`: a sentinel that shares a type
 * with real namespace URIs is a sentinel a document could in principle spell.
 */
export const ANY_NAMESPACE: unique symbol = Symbol('ANY_NAMESPACE')

/**
 * Which namespace a query wants.
 *
 * - `ANY_NAMESPACE` — match on local name alone. The pragmatic default: RSS 2.0 puts its own
 *   elements in no namespace, but feeds in the wild are inconsistent about it.
 * - `null` — match only elements genuinely in NO namespace.
 * - a URI — match only that namespace, whatever prefix the document chose for it.
 */
export type NamespaceSelector = string | null | typeof ANY_NAMESPACE

const matchesNamespace = (actual: string | null, want: NamespaceSelector): boolean =>
  want === ANY_NAMESPACE || actual === want

export function isElement(node: XmlNodeUnion): node is XmlElementNode {
  return node.kind === 'element'
}

export function childElements(node: XmlElementNode): readonly XmlElementNode[] {
  return node.children.filter(isElement)
}

export function findChildren(
  node: XmlElementNode,
  localName: string,
  namespace: NamespaceSelector = ANY_NAMESPACE,
): readonly XmlElementNode[] {
  return node.children.filter(
    (child): child is XmlElementNode =>
      isElement(child) &&
      child.localName === localName &&
      matchesNamespace(child.namespaceUri, namespace),
  )
}

/**
 * The FIRST matching child, or `undefined`.
 *
 * First, not "the only": a feed is free to repeat an element the spec says is singular, and
 * throwing on that would turn one sloppy vacancy into a failed collection. Callers that care that
 * there is exactly one use `findChildren` and check the length.
 */
export function findChild(
  node: XmlElementNode,
  localName: string,
  namespace: NamespaceSelector = ANY_NAMESPACE,
): XmlElementNode | undefined {
  return findChildren(node, localName, namespace)[0]
}

/**
 * Value of an attribute, or `undefined`.
 *
 * Defaults to `null` — no namespace — rather than `ANY_NAMESPACE`, because an UNPREFIXED attribute
 * is in no namespace per the Namespaces in XML spec (unlike an unprefixed element, which takes the
 * default namespace). `isPermaLink` on an RSS `<guid>` is exactly this case, and a helper that
 * defaulted to "any" would also answer for `dc:isPermaLink` from an unrelated vocabulary.
 */
export function attributeValue(
  node: XmlElementNode,
  localName: string,
  namespace: NamespaceSelector = null,
): string | undefined {
  return node.attributes.find(
    (attribute) =>
      attribute.localName === localName && matchesNamespace(attribute.namespaceUri, namespace),
  )?.value
}

/**
 * Text of this element and all its descendants, concatenated.
 *
 * The descendant-inclusive reading, as against `node.text`, which is direct children only. Both
 * exist because both are wanted and conflating them is a silent bug: `<description>` wants the
 * deep text, while an `<item>`'s own text should be empty rather than a run-together of every
 * field it contains.
 *
 * Iterative, not recursive: the depth bound keeps a document shallow, but a tree walk that spends
 * a stack frame per level is a second, unbounded reason to care about depth.
 */
export function collectText(node: XmlElementNode): string {
  let text = ''
  const stack: XmlNodeUnion[] = [...node.children].reverse()
  while (stack.length > 0) {
    const current = stack.pop() as XmlNodeUnion
    if (current.kind === 'text') {
      text += current.value
    } else {
      for (let i = current.children.length - 1; i >= 0; i -= 1) {
        stack.push(current.children[i] as XmlNodeUnion)
      }
    }
  }
  return text
}

/** Depth (root = 1) and element count of a parsed tree — the exact figures, after the fact. */
export function measureTree(root: XmlElementNode): { maxDepth: number; elementCount: number } {
  let maxDepth = 0
  let elementCount = 0
  const stack: { node: XmlElementNode; depth: number }[] = [{ node: root, depth: 1 }]
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: XmlElementNode; depth: number }
    elementCount += 1
    if (depth > maxDepth) maxDepth = depth
    for (const child of node.children) {
      if (isElement(child)) stack.push({ node: child, depth: depth + 1 })
    }
  }
  return { maxDepth, elementCount }
}
