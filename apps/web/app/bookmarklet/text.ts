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

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', '#39': "'" }

/** One pass of HTML to text: parsed in an inert document, or by hand where the page refuses that. */
function toText(html: string): string {
  try {
    return nodeText(new DOMParser().parseFromString(html, 'text/html').body)
  } catch {
    // A page enforcing Trusted Types refuses a plain string here: drop the tags by hand instead.
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name] as string)
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  }
}

/**
 * HTML from an untrusted string (a JSON-LD field) as plain text. A field escaped twice (LinkedIn:
 * `&lt;p&gt;`) holds no markup itself yet still does after one pass, so it gets one more; a field
 * with real markup keeps an escaped tag it mentions (`List&lt;String&gt;`) as text.
 */
export function htmlText(html: string): string {
  const text = toText(html)
  // shortcut: plain text that only mentions an escaped tag (`use &lt;div&gt;`) loses it to the second pass; upgrade if a board ships that
  return !MARKUP.test(html) && MARKUP.test(text) ? toText(text) : text
}
