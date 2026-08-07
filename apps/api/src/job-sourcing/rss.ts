/**
 * Minimal RSS 2.0 item extractor — task-job-sourcing-slice1 §2.
 *
 * WHY HAND-ROLLED
 * ---------------
 * The API ships no XML parser and adding a dependency is not something this
 * task may do unilaterally (`.clauderules`). What we actually need is tiny: the
 * five child elements of `<item>` that RSS guarantees. So this is a scanner,
 * not a parser — it never tries to model XML in general.
 *
 * SECURITY: THE INPUT IS A THIRD PARTY'S BYTES
 * --------------------------------------------
 *   - **No entity expansion.** Only a fixed table of five XML entities plus
 *     numeric escapes is decoded. `<!DOCTYPE>`/`<!ENTITY>` declarations are
 *     skipped without being interpreted, so the billion-laughs and XXE
 *     file-disclosure classes are structurally impossible here — there is no
 *     code path that can resolve an external entity.
 *   - **No backtracking regexes.** Element extraction is `indexOf`-based
 *     scanning, so a hostile feed cannot trigger catastrophic backtracking
 *     (ReDoS). The only regexes run over already-bounded slices.
 *   - **Bounded work.** Input over `MAX_FEED_BYTES` is rejected outright and at
 *     most `MAX_ITEMS` items are returned, so one bad response cannot pin a
 *     worker or blow up memory.
 *
 * What this deliberately does NOT do: namespaces, attributes, nested repeated
 * elements, RDF/Atom. If a second source needs those, it gets its own parser —
 * this one stays small enough to audit in one sitting.
 */

/** Hard cap on a feed body (2 MiB) — DOU's is ~200 KiB. */
export const MAX_FEED_BYTES = 2 * 1024 * 1024
/** Hard cap on items taken from one feed. */
export const MAX_ITEMS = 200

export interface RawRssItem {
  title: string
  link: string
  guid: string
  pubDate: string
  description: string
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/**
 * Decode the fixed XML entity set + numeric character references. Anything
 * else (`&foo;`, an entity a hostile DTD might declare) is left as literal
 * text — never resolved.
 */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      // Reject non-characters and anything outside the Unicode range rather
      // than throwing — a malformed reference should not abort the whole feed.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const named = XML_ENTITIES[body.toLowerCase()]
    return named ?? match
  })
}

/** Strip CDATA wrappers, then decode entities. */
function readText(raw: string): string {
  let text = raw
  const cdataOpen = '<![CDATA['
  const cdataClose = ']]>'
  if (text.includes(cdataOpen)) {
    let out = ''
    let cursor = 0
    while (cursor < text.length) {
      const start = text.indexOf(cdataOpen, cursor)
      if (start === -1) {
        out += text.slice(cursor)
        break
      }
      out += text.slice(cursor, start)
      const end = text.indexOf(cdataClose, start + cdataOpen.length)
      if (end === -1) {
        // Unterminated CDATA — take the rest verbatim rather than dropping it.
        out += text.slice(start + cdataOpen.length)
        break
      }
      // CDATA content is literal: no entity decoding inside it.
      out += text.slice(start + cdataOpen.length, end)
      cursor = end + cdataClose.length
    }
    return out.trim()
  }
  text = decodeXmlEntities(text)
  return text.trim()
}

/**
 * Value of the FIRST `<tag>…</tag>` inside `block`. Returns `''` when the tag
 * is absent, self-closing, or unterminated.
 */
function extractTag(block: string, tag: string): string {
  const openPrefix = `<${tag}`
  const close = `</${tag}>`
  const openIdx = block.indexOf(openPrefix)
  if (openIdx === -1) return ''
  // Guard against `<guidfoo>` matching `<guid`: the next char must end the name.
  const afterName = block[openIdx + openPrefix.length]
  if (afterName !== undefined && afterName !== '>' && afterName !== ' ' && afterName !== '/') {
    return ''
  }
  const contentStart = block.indexOf('>', openIdx)
  if (contentStart === -1) return ''
  if (block[contentStart - 1] === '/') return '' // self-closing `<description/>`
  const closeIdx = block.indexOf(close, contentStart)
  if (closeIdx === -1) return ''
  return readText(block.slice(contentStart + 1, closeIdx))
}

/**
 * Extract `<item>` elements from an RSS document.
 *
 * Malformed input yields `[]` rather than an exception — a feed we cannot read
 * is "0 items", not a 500. The ONE exception is a body over `MAX_FEED_BYTES`,
 * which throws: that is a resource-exhaustion signal, and silently returning
 * `[]` for it would look identical to an empty feed (code review round 3 — the
 * docblock used to claim "never throws", which was simply untrue).
 */
export function parseRssItems(xml: string): RawRssItem[] {
  if (typeof xml !== 'string' || xml.length === 0) return []
  if (xml.length > MAX_FEED_BYTES) {
    throw new Error(`RSS feed too large: ${xml.length} bytes (max ${MAX_FEED_BYTES})`)
  }

  const items: RawRssItem[] = []
  let cursor = 0

  while (items.length < MAX_ITEMS) {
    const openIdx = xml.indexOf('<item', cursor)
    if (openIdx === -1) break
    const afterName = xml[openIdx + 5]
    if (afterName !== '>' && afterName !== ' ') {
      // `<items>` / `<itemFoo>` — not an item element, keep scanning.
      cursor = openIdx + 5
      continue
    }
    const closeIdx = xml.indexOf('</item>', openIdx)
    if (closeIdx === -1) break

    const block = xml.slice(openIdx, closeIdx)
    items.push({
      title: extractTag(block, 'title'),
      link: extractTag(block, 'link'),
      guid: extractTag(block, 'guid'),
      pubDate: extractTag(block, 'pubDate'),
      description: extractTag(block, 'description'),
    })
    cursor = closeIdx + '</item>'.length
  }

  return items
}
