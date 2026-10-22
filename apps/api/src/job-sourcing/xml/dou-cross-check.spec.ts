/**
 * Compatibility evidence: the new port reads the DOU feed to the SAME values the legacy scanner
 * produced, and the legacy scanner's own golden outcomes are untouched.
 *
 * WHY THIS IS THE STRONGEST TEST IN THE DIRECTORY
 * ----------------------------------------------
 * Every other spec here checks the port against values this task wrote. This one checks it against
 * `dou-feed.golden.expected.json` — captured from `parseRssItems` BEFORE this task existed and
 * pinned by `dou-golden.spec.ts`. That makes the expected values an INDEPENDENT source rather than
 * a restatement of the implementation, which is the one property that separates a real assertion
 * from a tautological one. If the port and the hand-rolled scanner disagree about a real feed, one
 * of them is wrong and this goes red.
 *
 * C-20: `rss.ts` STAYS DOU-ONLY and is not refactored onto the port. This file only reads it.
 * Nothing here changes DOU's production path — `DouRssProvider` still calls `parseRssItems`, and
 * the golden specs still gate it. The cross-check is additive evidence that a future migration is
 * possible, not the migration.
 */

import { describe, expect, it } from 'vitest'
import { douFeedBytes, douGolden } from '../../test/xml-corpus'
import { MAX_FEED_BYTES, MAX_ITEMS, parseRssItems } from '../rss'
import { BoundedXmlPort } from './bounded-xml-port'
import type { XmlElementNode } from './xml-port'
import { findChild, findChildren } from './xml-tree'

const port = new BoundedXmlPort()

/**
 * The five RSS fields, read through the port with the same semantics `rss.ts` documents: first
 * matching child, CDATA unwrapped, entities decoded, trimmed.
 *
 * Note what is NOT here: no canonicalisation, no timestamp-query policy, no URL rewriting. Those
 * are DOU's legacy identity rules and they live in `canonicalizePostingUrl`. The port's job stops
 * at delivering the bytes' meaning faithfully.
 */
function readItemsThroughPort(): Record<string, string>[] {
  const document = port.parseDocument(douFeedBytes())
  const channel = findChild(document.root, 'channel', null) as XmlElementNode
  return findChildren(channel, 'item', null).map((item) => ({
    title: findChild(item, 'title', null)?.text.trim() ?? '',
    link: findChild(item, 'link', null)?.text.trim() ?? '',
    guid: findChild(item, 'guid', null)?.text.trim() ?? '',
    pubDate: findChild(item, 'pubDate', null)?.text.trim() ?? '',
    description: findChild(item, 'description', null)?.text.trim() ?? '',
  }))
}

describe('the XML port reads the DOU feed exactly as the legacy scanner does', () => {
  const golden = douGolden().rawItems
  const throughPort = readItemsThroughPort()

  it('POSITIVE CONTROL: the golden file actually carries items to compare against', () => {
    // An empty or renamed golden file would make every comparison below vacuous — `[] === []`
    // passes and says nothing. This is the one failure mode a cross-check of this shape has.
    expect(golden.length).toBeGreaterThan(2)
    expect(golden[0]?.title).toBeTruthy()
  })

  it('finds the same number of items', () => {
    expect(throughPort).toHaveLength(golden.length)
  })

  it.each([0, 1, 2])('item %i matches the golden capture field for field', (index) => {
    // Field by field rather than one deep-equal, so a failure names WHICH field diverged. A
    // whole-object comparison on five fields reports "objects differ" and costs a debugging round.
    const expected = golden[index] as Record<string, string>
    const actual = throughPort[index] as Record<string, string>
    for (const field of ['title', 'link', 'guid', 'pubDate', 'description']) {
      expect(actual[field], `item ${index} field ${field}`).toBe(expected[field])
    }
  })

  it('every remaining item matches too', () => {
    expect(throughPort).toEqual(golden.map((item) => ({ ...item })))
  })

  it('the entity-escaped HTML description round-trips identically', () => {
    // The hardest field: DOU ships `&lt;p&gt;We are &lt;strong&gt;…` and the double-escaped
    // `&amp;amp;`. The scanner decodes a fixed five-entity table by hand; the parser decodes per
    // the XML spec. That these agree on a real feed is the substance of the compatibility claim.
    expect(throughPort[0]?.description).toContain('<p>We are <strong>hiring</strong>')
    expect(throughPort[0]?.description).toContain('GraphQL &amp; REST')
    expect(throughPort[0]?.description).toBe(golden[0]?.description)
  })

  it('the channel-level title is NOT read as an item', () => {
    // The fixture carries a `<title>` on `<channel>` labelled "must NOT be read as an item". A
    // descendant search instead of a direct-child search would pick it up, and the first vacancy
    // of every DOU run would be the channel name.
    expect(throughPort.map((item) => item.title)).not.toContain(
      'Channel title that must NOT be read as an item',
    )
  })

  it('the guid carries DOU`s timestamp query verbatim, un-canonicalised', () => {
    // DOU's guid changes on every fetch. Normalising it is `canonicalizePostingUrl`'s job and the
    // port must not pre-empt it — a port that "helpfully" stripped the query would silently
    // change DOU's identity semantics.
    expect(throughPort[0]?.guid).toContain('?1786092518')
    expect(throughPort[0]?.guid).not.toBe(throughPort[0]?.link)
  })
})

describe('C-20: the legacy scanner is unchanged and still authoritative for DOU', () => {
  it('parseRssItems on the same fixture still produces the golden outcomes', () => {
    // Run directly here as well, so this file fails if the legacy path regresses — independently
    // of whether `dou-golden.spec.ts` happens to be in the same run.
    const legacy = parseRssItems(new TextDecoder().decode(douFeedBytes()))
    expect(legacy).toEqual(douGolden().rawItems.map((item) => ({ ...item })))
  })

  it('its caps are the ones the port borrows, with the same values', () => {
    // `MAX_FEED_BYTES` is imported by `xml-limits.ts` rather than re-declared — one number for one
    // job. Pinned against independent literals so a change to either side is visible.
    expect(MAX_FEED_BYTES).toBe(2097152)
    expect(MAX_ITEMS).toBe(200)
  })
})
