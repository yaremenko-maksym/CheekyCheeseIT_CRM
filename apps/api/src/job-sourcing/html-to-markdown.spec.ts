import { describe, expect, it } from 'vitest'
import { MAX_DESCRIPTION_CHARS, htmlToMarkdown } from './html-to-markdown'

/**
 * AC6 — "Описание с внедрённым скриптом рендерится безопасно".
 *
 * This is the INGEST half of that guarantee: whatever the feed sends, what
 * lands in `job_postings.description_md` contains no HTML at all. The RENDER
 * half (react-markdown without rehype-raw) is pinned separately in
 * apps/web/app/components/job-sourcing/__tests__/JobSuggestionDialog.test.tsx.
 * Both layers are tested because either one alone would be a single point of
 * failure for stored XSS in an authenticated origin.
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
    expect(htmlToMarkdown('<a href="https://example.com/job">Apply</a>')).toBe(
      '[Apply](https://example.com/job)',
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
