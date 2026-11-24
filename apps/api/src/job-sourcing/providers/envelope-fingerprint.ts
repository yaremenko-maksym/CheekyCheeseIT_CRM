import { createHash } from 'node:crypto'
import type { XmlElementNode } from '../xml/xml-port'

/**
 * The envelope fingerprint (source fetch strategy U2; ADR 2026-10-25 section 10): a sha256 of the
 * sorted, de-duplicated set of field NAMES a response's envelope carried, so a format change shows
 * before parsing fails. Values and order do not count. XML hashes every element and attribute name;
 * JSON only the top-level keys (`jsonEnvelopeFingerprint`). The sorted list is hashed as JSON, so a name that
 * contains a separator cannot collide with two names.
 */
function fingerprintOf(names: ReadonlySet<string>): string {
  return createHash('sha256')
    .update(JSON.stringify([...names].sort()))
    .digest('hex')
}

/**
 * The JSON fingerprint's algorithm tag. A JSON fingerprint is `feed0002` + the first 56 hex of its
 * sha256, so it still matches the column CHECK `^[0-9a-f]{64}$`, and `detectFormatDrift` can tell it
 * from a legacy (every-depth) JSON or an XML fingerprint and never compare across the change. An
 * untagged sha256 starts with the tag only by a 2^-32 chance.
 */
const JSON_TOP_LEVEL_TAG = 'feed0002'

/** Which algorithm made a stored fingerprint; values of different algorithms are not compared. */
export function fingerprintAlgorithm(fingerprint: string): 'json-top-level' | 'legacy' {
  return fingerprint.startsWith(JSON_TOP_LEVEL_TAG) ? 'json-top-level' : 'legacy'
}

/**
 * A parsed JSON value's ENVELOPE: its top-level object keys only. Nested values are not walked, so
 * items with optional keys and a short last page do not move it; item-level drift is the item
 * schema's job (`invalid / received`, `PARSE_DRIFT`). A root array hashes the fixed input `array`,
 * which no key list (always a JSON `[...]`) can produce, so object <-> array is still a change.
 */
export function jsonEnvelopeFingerprint(value: unknown): string {
  const input = Array.isArray(value)
    ? 'array'
    : JSON.stringify(typeof value === 'object' && value !== null ? Object.keys(value).sort() : [])
  const digest = createHash('sha256').update(input).digest('hex')
  return `${JSON_TOP_LEVEL_TAG}${digest.slice(0, 64 - JSON_TOP_LEVEL_TAG.length)}`
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
