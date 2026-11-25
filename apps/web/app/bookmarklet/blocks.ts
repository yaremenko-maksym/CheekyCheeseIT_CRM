/**
 * The block map: the page's visible text blocks with the layout facts a person reads them by
 * (kind, box, font, region), so the CRM can ask which blocks are the vacancy. It reads the rendered
 * page through `Measure` only, and is bundled into the bookmarklet, so it imports no zod.
 */
import { bytesToBase64Url } from '../lib/base64url'

import { BLOCK_TEXT_MAX, BLOCKS_MAX, CHROME_TEXT_MAX, HASH_MAX } from './limits'
import { crmTarget } from './target'

/** Mirrors `PageBlock` of `@crm/shared` (Task 2), field for field. */
export type PageBlock = {
  t: string
  k: string
  fs: number
  fw: number
  x: number
  y: number
  w: number
  r: 'nav' | 'header' | 'footer' | 'aside' | 'dialog' | 'main' | '-'
}

export type Measure = (el: Element) => {
  x: number
  y: number
  w: number
  h: number
  fontSize: number
  fontWeight: number
  display: string
  hidden: boolean
}

const SKIP = /^(script|style|noscript|template)$/
/**
 * Display values that keep an element inside the enclosing block's text: inline, every inline-*
 * (inline-block, inline-flex: a badge in a line of text) and contents.
 */
// Stryker disable next-line Regex: no CSS display value has "inline" or "contents" past its start
const INLINE = /^(inline|contents)/
const REGION = /^(nav|header|footer|aside|dialog|main)$/
const CHROME = ['nav', 'header', 'footer']

/** The browser's layout: page coordinates, computed font, and whether anything shows. */
const layout: Measure = (el) => {
  const view = el.ownerDocument.defaultView as Window
  const s = view.getComputedStyle(el)
  const box = el.getBoundingClientRect()
  return {
    x: box.x + view.scrollX,
    y: box.y + view.scrollY,
    w: box.width,
    h: box.height,
    fontSize: parseFloat(s.fontSize) || 0,
    fontWeight: parseInt(s.fontWeight) || 0,
    display: s.display,
    // opacity and visibility hide the subtree too: it is skipped whole
    hidden:
      s.display == 'none' ||
      s.visibility == 'hidden' ||
      s.visibility == 'collapse' ||
      s.opacity == '0' ||
      box.right + view.scrollX <= 0,
  }
}

type Ctx = { k: string; m: ReturnType<Measure>; r: PageBlock['r']; b?: PageBlock | undefined }

/**
 * What renders inside `el`: its shadow tree, a same-origin frame's page (an iframe, or an object
 * showing HTML), a slot's assigned nodes. A cross-origin frame throws or gives null.
 */
function inside(el: Element): ArrayLike<Node> {
  if (el.shadowRoot) return el.shadowRoot.childNodes
  const frame = (el as HTMLIFrameElement).contentDocument?.body
  if (frame) return frame.childNodes
  const slotted = el.localName == 'slot' ? (el as HTMLSlotElement).assignedNodes() : []
  // an empty slot shows its own children, the fallback content
  return slotted.length ? slotted : el.childNodes
}

/**
 * The page's visible text blocks in page order. A block is the nearest ancestor that is not
 * inline, inline-* or contents; text after a nested block starts a new block of the same kind.
 */
export function readBlockMap(doc: Document, measure: Measure = layout): PageBlock[] {
  const out: PageBlock[] = []
  const walk = (nodes: ArrayLike<Node>, c: Ctx): void => {
    for (const n of Array.from(nodes)) {
      if (n.nodeType == 3) {
        const data = (n as Text).data
        if (!c.b && /\S/.test(data) && c.m.w && c.m.h && out.length < BLOCKS_MAX) {
          const { x, y, w, fontSize, fontWeight } = c.m
          c.b = { t: '', k: c.k, fs: fontSize, fw: fontWeight, x, y, w, r: c.r }
          for (const key of ['fs', 'x', 'y', 'w'] as const) c.b[key] = Math.round(c.b[key])
          out.push(c.b)
        }
        if (c.b) c.b.t += data
      } else if (n.nodeType == 1) {
        const el = n as Element
        const tag = el.localName
        if (SKIP.test(tag) || el.getAttribute('aria-hidden') == 'true') continue
        const m = measure(el)
        if (m.hidden) continue
        const inner = INLINE.test(m.display)
          ? c
          : { k: tag, m, r: REGION.test(tag) ? (tag as PageBlock['r']) : c.r }
        try {
          walk(inside(el), inner)
        } catch {
          // a cross-origin frame or a closed tree: skip that subtree, keep the rest of the page
        }
        if (inner != c) c.b = undefined
      }
    }
  }
  // no body (an SVG or XML file) throws, and the caller opens the CRM without a map
  walk(doc.body.childNodes, { k: 'body', m: measure(doc.body), r: '-' })
  // a block starts at a non-space character, so none is empty here
  for (const b of out) b.t = b.t.replace(/\s+/g, ' ').trim().slice(0, BLOCK_TEXT_MAX)
  return out
}

/**
 * Fits the map into `maxChars` of JSON. Nav / header / footer text is cut to a line always (it
 * carries the HR's own name on a logged-in site); over budget those blocks go first, then the
 * longest texts are cut to a common length, then trailing blocks go.
 */
export function fitBlockMap(blocks: PageBlock[], maxChars: number): PageBlock[] {
  const fits = (list: PageBlock[]): boolean => JSON.stringify(list).length <= maxChars
  const cut = (list: PageBlock[], n: number): PageBlock[] =>
    list.map((b) => ({ ...b, t: b.t.slice(0, n) }))
  let out = blocks.map((b) =>
    CHROME.includes(b.r) ? { ...b, t: b.t.slice(0, CHROME_TEXT_MAX) } : b,
  )
  if (fits(out)) return out
  out = out.filter((b) => !CHROME.includes(b.r))
  let lo = 0
  let hi = BLOCK_TEXT_MAX
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(cut(out, mid))) lo = mid
    else hi = mid - 1
  }
  out = cut(out, lo)
  while (out.length && !fits(out)) out.pop()
  return out
}

/** The map as JSON, deflated (`deflate-raw`) and base64url'd: about a fifth of the JSON. */
export async function encodeBlockMap(blocks: PageBlock[]): Promise<string> {
  const json = new Response(JSON.stringify(blocks)).body as ReadableStream<Uint8Array<ArrayBuffer>>
  const packed = json.pipeThrough(new CompressionStream('deflate-raw'))
  return bytesToBase64Url(new Uint8Array(await new Response(packed).arrayBuffer()))
}

/**
 * The CRM target with the page's block map as `b`. The map never costs the vacancy: when it does
 * not fit the hash in three tries, or reading it throws, the target goes without it.
 */
export async function mapTarget(
  origin: string,
  doc: Document,
  href: string,
  selection: string,
  measure?: Measure,
): Promise<string> {
  const target = (b?: string): string => crmTarget(origin, doc, href, selection, b)
  const hash = (url: string): number => url.length - url.indexOf('#external=') - 10
  try {
    const map = readBlockMap(doc, measure)
    // shortcut: the budget counts JSON chars, not encoded ones; the retries absorb the difference
    for (let i = 0, room = HASH_MAX - hash(target('')); map.length && i < 3; i++, room /= 2) {
      const url = target(await encodeBlockMap(fitBlockMap(map, room)))
      if (hash(url) <= HASH_MAX) return url
    }
  } catch {
    // the block map is an extra: the vacancy still opens without it
  }
  return target()
}
