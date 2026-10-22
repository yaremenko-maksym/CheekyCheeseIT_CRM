/**
 * Seam 1 of the vacancy-sourcing XML stack. Import from here, never from `parse-xml.adapter`.
 *
 * `parse-xml.adapter` is deliberately NOT re-exported: it is the one file that names the parser,
 * and an adapter reachable through the barrel is an adapter a caller can reach past the bounds.
 * Tests that need the parser layer with the gates bypassed import it by path and say why.
 */

export { BoundedXmlPort, xmlPort } from './bounded-xml-port'
export {
  FEED_NAMESPACES,
  NamespaceScope,
  splitQName,
  XML_NAMESPACE,
  XMLNS_NAMESPACE,
} from './namespaces'
export {
  DEFAULT_XML_LIMITS,
  MAX_XML_BYTES,
  MAX_XML_DEPTH,
  MAX_XML_ELEMENTS,
  MAX_XML_WALL_CLOCK_MS,
} from './xml-limits'
export type {
  XmlAttribute,
  XmlDocument,
  XmlElementNode,
  XmlFailureReason,
  XmlLimits,
  XmlName,
  XmlNodeUnion,
  XmlPort,
  XmlTextNode,
} from './xml-port'
export { XmlPortError } from './xml-port'
export {
  ANY_NAMESPACE,
  attributeValue,
  childElements,
  collectText,
  findChild,
  findChildren,
  isElement,
} from './xml-tree'
export type { NamespaceSelector } from './xml-tree'
