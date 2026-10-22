import type { DateContract, DateSemantics } from '../normalize/date-policy'
import {
  attributeValue,
  collectText,
  FEED_NAMESPACES,
  findChild,
  findChildren,
  isElement,
  type NamespaceSelector,
  type XmlDocument,
  type XmlElementNode,
  type XmlNodeUnion,
} from '../xml'

/**
 * Seam 2 of the vacancy-sourcing XML stack: FEED semantics over Seam 1's neutral tree (r5 Task 2.4,
 * `docs/architecture/2026-10-20-xml-parser-dependency-review.md`, "Shape C").
 *
 * A pure function over an already-parsed `XmlDocument`, not a second port: it does no I/O and has
 * one implementation, so a port here would be a seam with nothing varying through it. The bytes
 * -> document step stays behind `XmlPort`, which is where the bounds and the hardening live.
 *
 * DELETION TEST: delete this and each of the ~25 feed adapters re-implements `guid isPermaLink`,
 * Atom link relations, `content:encoded` by namespace URI, multiple authors and the three feed
 * dialects. That complexity would surface at 25 callers, so the module earns its place.
 *
 * WHAT IT DOES NOT DO: identity, URL canonicalisation, and deciding what a vacancy is. The `guid`
 * is handed up VERBATIM (trimmed only), because GUID is opaque identity (Task 2.4); turning a
 * `link` into an identity is the observation builder's job, and DOU's legacy timestamp-query
 * policy (`canonicalizePostingUrl`) belongs to `rss.ts`, which this file neither imports nor
 * replaces (constraint C-20).
 */

export type FeedFormat = 'RSS_2' | 'RSS_1' | 'ATOM'

/** A date as the feed wrote it, with the wire contract its element is specified to use. */
export interface FeedDate {
  readonly raw: string
  readonly contract: Extract<DateContract, 'RFC_2822' | 'ISO_ZONED'>
  readonly semantics: Extract<DateSemantics, 'PUBLISHED' | 'UPDATED'>
}

/**
 * One item / entry. Every text field is trimmed, and a blank one is `null` rather than `''`, so a
 * caller never has to tell "absent" from "present but empty" — for every field here they mean the
 * same thing.
 */
export interface FeedEntry {
  /** RSS 2.0 `<guid>`, Atom `<id>`, RSS 1.0 `rdf:about`. Opaque: never parsed, never rewritten. */
  readonly guid: string | null
  /** RSS `<link>`; Atom's alternate link; a permalink `<guid>` when an RSS item has no `<link>`. */
  readonly link: string | null
  readonly title: string | null
  /** RSS `<description>`, Atom `<summary>`. HTML is left as text for the caller to sanitise. */
  readonly summary: string | null
  /** `content:encoded` (any dialect), or Atom `<content>`. */
  readonly content: string | null
  readonly authors: readonly string[]
  readonly categories: readonly string[]
  readonly dates: readonly FeedDate[]
}

export interface FeedDocument {
  readonly format: FeedFormat
  readonly title: string | null
  readonly entries: readonly FeedEntry[]
}

/**
 * The document is well-formed XML and is not a feed we can read. Drift, not an empty feed: a valid
 * feed with no items returns `entries: []` and never throws this.
 */
export class FeedDriftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedDriftError'
  }
}

const NO_NAMESPACE: NamespaceSelector = null

/** Trimmed text, or `null` when there is none. */
function textOf(node: XmlElementNode | undefined): string | null {
  if (node === undefined) return null
  const text = collectText(node).trim()
  return text === '' ? null : text
}

function textsOf(nodes: readonly XmlElementNode[]): string[] {
  return nodes.map(textOf).filter((text): text is string => text !== null)
}

function datesOf(
  pairs: ReadonlyArray<
    readonly [XmlElementNode | undefined, FeedDate['contract'], FeedDate['semantics']]
  >,
): FeedDate[] {
  const dates: FeedDate[] = []
  for (const [node, contract, semantics] of pairs) {
    const raw = textOf(node)
    if (raw !== null) dates.push({ raw, contract, semantics })
  }
  return dates
}

const contentEncoded = (item: XmlElementNode): string | null =>
  textOf(findChild(item, 'encoded', FEED_NAMESPACES.content))

/**
 * Items of an RSS 2.0 channel, in document order — including those a feed wraps in a container
 * element of its own (the plan's "partial group"), and never an `<item>` nested inside an item.
 *
 * Iterative, for the same reason `collectText` is: the depth bound keeps a document shallow, but a
 * walk that spends a stack frame per level is a second reason to care about depth.
 */
function rss2Items(channel: XmlElementNode): XmlElementNode[] {
  const items: XmlElementNode[] = []
  const stack: XmlElementNode[] = [...channel.children].filter(isElement).reverse()
  while (stack.length > 0) {
    const node = stack.pop() as XmlElementNode
    if (node.localName === 'item' && node.namespaceUri === null) {
      items.push(node)
    } else {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i] as XmlNodeUnion
        if (isElement(child)) stack.push(child)
      }
    }
  }
  return items
}

function rss2Entry(item: XmlElementNode): FeedEntry {
  const guidNode = findChild(item, 'guid', NO_NAMESPACE)
  const guid = textOf(guidNode)
  // RSS 2.0: "isPermaLink is optional, its default value is true". Only the literal `false`
  // withdraws it, and a guid that is not a permalink is never used as a URL, whatever it looks like.
  // The cast: a non-null `guid` was read FROM `guidNode`, so the node exists on this branch; a
  // separate `!== undefined` check would be a condition no input can falsify.
  const permalink =
    guid !== null && attributeValue(guidNode as XmlElementNode, 'isPermaLink') !== 'false'
  const link = textOf(findChild(item, 'link', NO_NAMESPACE))
  return {
    guid,
    link: link ?? (permalink ? guid : null),
    title: textOf(findChild(item, 'title', NO_NAMESPACE)),
    summary: textOf(findChild(item, 'description', NO_NAMESPACE)),
    content: contentEncoded(item),
    authors: [
      ...textsOf(findChildren(item, 'author', NO_NAMESPACE)),
      ...textsOf(findChildren(item, 'creator', FEED_NAMESPACES.dublinCore)),
    ],
    categories: textsOf(findChildren(item, 'category', NO_NAMESPACE)),
    dates: datesOf([
      [findChild(item, 'pubDate', NO_NAMESPACE), 'RFC_2822', 'PUBLISHED'],
      [findChild(item, 'date', FEED_NAMESPACES.dublinCore), 'ISO_ZONED', 'PUBLISHED'],
    ]),
  }
}

function rss1Entry(item: XmlElementNode): FeedEntry {
  const ns = FEED_NAMESPACES.rss1
  const about = attributeValue(item, 'about', FEED_NAMESPACES.rdf)?.trim()
  return {
    guid: about === undefined || about === '' ? null : about,
    link: textOf(findChild(item, 'link', ns)),
    title: textOf(findChild(item, 'title', ns)),
    summary: textOf(findChild(item, 'description', ns)),
    content: contentEncoded(item),
    authors: textsOf(findChildren(item, 'creator', FEED_NAMESPACES.dublinCore)),
    categories: textsOf(findChildren(item, 'subject', FEED_NAMESPACES.dublinCore)),
    dates: datesOf([
      [findChild(item, 'date', FEED_NAMESPACES.dublinCore), 'ISO_ZONED', 'PUBLISHED'],
    ]),
  }
}

/**
 * RFC 4287 §4.2.7.2: "If the 'rel' attribute is not present, the link element MUST be interpreted
 * as if the link relation type is 'alternate'." The first alternate wins; `related`, `self`,
 * `enclosure` and the rest are never the posting's link.
 */
function atomAlternate(entry: XmlElementNode): string | null {
  for (const link of findChildren(entry, 'link', FEED_NAMESPACES.atom)) {
    const rel = attributeValue(link, 'rel')?.trim() ?? 'alternate'
    const href = attributeValue(link, 'href')?.trim()
    if (rel === 'alternate' && href !== undefined && href !== '') return href
  }
  return null
}

function atomEntry(entry: XmlElementNode): FeedEntry {
  const ns = FEED_NAMESPACES.atom
  return {
    guid: textOf(findChild(entry, 'id', ns)),
    link: atomAlternate(entry),
    title: textOf(findChild(entry, 'title', ns)),
    summary: textOf(findChild(entry, 'summary', ns)),
    content: textOf(findChild(entry, 'content', ns)) ?? contentEncoded(entry),
    authors: findChildren(entry, 'author', ns).flatMap((author) =>
      textsOf(findChildren(author, 'name', ns)),
    ),
    categories: findChildren(entry, 'category', ns)
      .map((category) => attributeValue(category, 'term')?.trim() ?? '')
      .filter((term) => term !== ''),
    dates: datesOf([
      [findChild(entry, 'published', ns), 'ISO_ZONED', 'PUBLISHED'],
      [findChild(entry, 'updated', ns), 'ISO_ZONED', 'UPDATED'],
    ]),
  }
}

/**
 * Read a parsed document as a feed, or throw `FeedDriftError`.
 *
 * The dialect is decided by the ROOT's expanded name — local name AND namespace — never by the
 * local name alone: `<feed>` outside the Atom namespace is not Atom, and an `<rss>` someone put in a
 * namespace is not RSS 2.0. Guessing there would turn a provider's format change into a silently
 * different reading of the same bytes.
 */
export function readFeed(document: XmlDocument): FeedDocument {
  const root = document.root

  if (root.localName === 'rss' && root.namespaceUri === null) {
    const channel = findChild(root, 'channel', NO_NAMESPACE)
    if (channel === undefined) throw new FeedDriftError('an <rss> document with no <channel>')
    return {
      format: 'RSS_2',
      title: textOf(findChild(channel, 'title', NO_NAMESPACE)),
      entries: rss2Items(channel).map(rss2Entry),
    }
  }

  if (root.localName === 'feed' && root.namespaceUri === FEED_NAMESPACES.atom) {
    return {
      format: 'ATOM',
      title: textOf(findChild(root, 'title', FEED_NAMESPACES.atom)),
      entries: findChildren(root, 'entry', FEED_NAMESPACES.atom).map(atomEntry),
    }
  }

  if (root.localName === 'RDF' && root.namespaceUri === FEED_NAMESPACES.rdf) {
    const channel = findChild(root, 'channel', FEED_NAMESPACES.rss1)
    if (channel === undefined) {
      throw new FeedDriftError('an rdf:RDF document with no RSS 1.0 <channel>')
    }
    return {
      format: 'RSS_1',
      title: textOf(findChild(channel, 'title', FEED_NAMESPACES.rss1)),
      entries: findChildren(root, 'item', FEED_NAMESPACES.rss1).map(rss1Entry),
    }
  }

  throw new FeedDriftError(
    `the document root {${root.namespaceUri ?? ''}}${root.localName} is not RSS 2.0, RSS 1.0 or Atom`,
  )
}
