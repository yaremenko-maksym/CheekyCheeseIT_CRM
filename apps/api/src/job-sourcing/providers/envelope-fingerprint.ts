import { createHash } from 'node:crypto'
import type { XmlElementNode } from '../xml/xml-port'

/**
 * The envelope fingerprint (source fetch strategy U2; ADR 2026-10-25 section 10): a sha256 of the
 * sorted, de-duplicated set of field NAMES a response carried, so a format change shows before
 * parsing fails. Values and order do not count. The sorted list is hashed as JSON, so a name that
 * contains a separator cannot collide with two names.
 */
function fingerprintOf(names: ReadonlySet<string>): string {
  return createHash('sha256')
    .update(JSON.stringify([...names].sort()))
    .digest('hex')
}

/**
 * A parsed JSON value's object keys, at every depth. Array positions are not names. Iterative, like
 * `countNodesWithin`: it runs only on a value `parseBoundedJson` already bounded.
 */
export function jsonEnvelopeFingerprint(value: unknown): string {
  const names = new Set<string>()
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const node = stack.pop()
    if (typeof node !== 'object' || node === null) continue
    if (!Array.isArray(node)) for (const key of Object.keys(node)) names.add(key)
    for (const child of Object.values(node)) stack.push(child)
  }
  return fingerprintOf(names)
}

/** A parsed XML document's element names and attribute names (`@`-prefixed), as written. */
export function xmlEnvelopeFingerprint(root: XmlElementNode): string {
  const names = new Set<string>()
  const stack: XmlElementNode[] = [root]
  while (stack.length > 0) {
    const element = stack.pop() as XmlElementNode
    names.add(element.qualifiedName)
    for (const attribute of element.attributes) names.add(`@${attribute.qualifiedName}`)
    for (const child of element.children) if (child.kind === 'element') stack.push(child)
  }
  return fingerprintOf(names)
}
