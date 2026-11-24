// <template> needs no entry: its content is a fragment, never in childNodes
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME'])
const BLOCK =
  /^(P|DIV|UL|OL|LI|H[1-6]|BR|TR|TABLE|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|NAV|BLOCKQUOTE|PRE|DL|DT|DD)$/

/** Says whether an element of the page is shown; one it rejects is skipped with its subtree. */
export type Visible = (el: Element) => boolean

const MARKUP = /<\/?[a-z][^>]*>/i

function walk(node: Node, visible: Visible): string {
  let out = ''
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += (child as Text).data.replace(/\s/g, ' ')
      return
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return
    const tag = (child as Element).tagName.toUpperCase()
    if (SKIP.has(tag) || !visible(child as Element)) return
    const inner = walk(child, visible)
    if (!BLOCK.test(tag)) out += inner
    else out += tag === 'LI' ? `\n- ${inner.trim()}\n` : `\n${inner}\n`
  })
  return out
}

/**
 * Visible text of a node, one line per block and a `- ` bullet per list item. It reads text nodes
 * only, so markup from a foreign page never becomes markup in the CRM. `innerText` is not used:
 * it depends on layout, and on a detached or parsed document it degrades to `textContent`.
 */
export function nodeText(node: Node | null | undefined, visible: Visible = () => true): string {
  if (!node) return ''
  return walk(node, visible)
    .replace(/ +/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const parsedText = (html: string): string =>
  nodeText(new DOMParser().parseFromString(html, 'text/html').body)

/**
 * HTML from an untrusted string (a JSON-LD field) as plain text, parsed in an inert document. A field
 * escaped twice (LinkedIn: `&lt;p&gt;`) still holds markup after one pass, so it gets one more.
 */
export function htmlText(html: string): string {
  try {
    const text = parsedText(html)
    return MARKUP.test(text) ? parsedText(text) : text
  } catch {
    // A page enforcing Trusted Types refuses a plain string here: drop the tags by hand instead.
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
}
