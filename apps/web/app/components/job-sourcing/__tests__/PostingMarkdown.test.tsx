/**
 * r5 Task 7.3 — `PostingMarkdown` pinned on its own, so a second call site (the queue card) can
 * never weaken the hardening the suggestion dialog's tests pin. Each prop has a test that reddens on
 * ITS removal alone (see the matrix in `JobSuggestionDialog.test.tsx`).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MARKDOWN_URL_TRANSFORM, PostingMarkdown } from '../PostingMarkdown'

function renderMd(markdown: string) {
  render(<PostingMarkdown markdown={markdown} testId="md" />)
  return screen.getByTestId('md')
}

describe('PostingMarkdown', () => {
  it('renders markdown (bold becomes <strong>)', () => {
    renderMd('**Strong** text')
    expect(screen.getByText('Strong', { selector: 'strong' })).toBeInTheDocument()
  })

  it('a <script> renders as inert text, never an element', () => {
    const md = renderMd('<script>alert(document.cookie)</script>Real text')
    expect(md.innerHTML).not.toMatch(/<script/i)
    expect(md.textContent).toBe('<script>alert(document.cookie)</script>Real text')
  })

  it('an <img onerror> payload stays text', () => {
    const md = renderMd('<img src=x onerror="alert(1)"> Job')
    expect(screen.queryByRole('img')).toBeNull()
    expect(md.innerHTML).not.toMatch(/<img/i)
    expect(md.textContent).toContain('<img src=x onerror="alert(1)">')
  })

  it('no markdown image is ever rendered (beacon class)', () => {
    const md = renderMd('![a](https://evil.example/a.png) and ![](/local.png) Job')
    expect(screen.queryByRole('img')).toBeNull()
    expect(md.innerHTML).not.toMatch(/<img/i)
    expect(md.innerHTML).not.toContain('evil.example')
  })

  it('pins urlTransform: an http: link never reaches the DOM as a live href', () => {
    const md = renderMd('[click](http://insecure.example/x)')
    expect(screen.queryByRole('link')).toBeNull()
    expect(md.innerHTML).not.toContain('insecure.example')
    expect(md.textContent).toBe('click')
  })

  it('pins the `a` component: an https link gets rel/noopener and a new tab', () => {
    renderMd('[Apply](https://jobs.dou.ua/x/1)')
    const link = screen.getByRole('link', { name: 'Apply' })
    expect(link.getAttribute('href')).toBe('https://jobs.dou.ua/x/1')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('a javascript: destination renders as text with no href', () => {
    const md = renderMd('[click me](javascript:alert(1))')
    expect(screen.queryByRole('link')).toBeNull()
    expect(md.textContent).toBe('click me')
    expect(MARKDOWN_URL_TRANSFORM('javascript:alert(1)')).toBe('')
  })

  it('a bare non-https URL is not autolinked', () => {
    renderMd('<http://insecure.example/x>')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('the transform returns the trimmed string it validated', () => {
    expect(MARKDOWN_URL_TRANSFORM(' https://host.test/a ')).toBe('https://host.test/a')
  })

  it('merges the caller class with the typography base', () => {
    render(<PostingMarkdown markdown="x" testId="md2" className="mt-4" />)
    expect(screen.getByTestId('md2')).toHaveClass('mt-4', 'text-sm', 'leading-relaxed')
  })

  // UX-M-1 / QA-LOW-4: `@tailwindcss/typography` is not installed, so `prose*` styled nothing;
  // the typography is explicit (numbered lists, quotes, code) and the dead classes are gone
  it('styles lists, quotes and code explicitly and carries no dead prose class', () => {
    const md = renderMd('1. one\n2. two\n\n> quoted\n\n`code`')
    expect(md).toHaveClass(
      'break-words',
      '[&>:first-child]:mt-0',
      '[&_p]:my-2',
      '[&_ul]:my-2',
      '[&_ul]:list-disc',
      '[&_ul]:pl-5',
      '[&_ol]:my-2',
      '[&_ol]:list-decimal',
      '[&_ol]:pl-5',
      '[&_li]:my-0.5',
      '[&_blockquote]:my-2',
      '[&_blockquote]:border-l-2',
      '[&_blockquote]:pl-3',
      '[&_blockquote]:text-muted-foreground',
      '[&_code]:rounded',
      '[&_code]:bg-muted',
      '[&_code]:px-1',
      '[&_code]:font-mono',
      '[&_code]:text-xs',
      '[&_pre]:my-2',
      '[&_pre]:overflow-x-auto',
      '[&_pre]:rounded-md',
      '[&_pre]:bg-muted',
      '[&_pre]:p-3',
      '[&_pre_code]:bg-transparent',
      '[&_pre_code]:p-0',
    )
    expect(md.className).not.toMatch(/(^|\s)(dark:)?prose(-\S+)?(\s|$)/)
    expect(md.className).not.toContain('max-w-none')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('list').tagName).toBe('OL')
  })

  // UX-L-1: a link reads as one, in the accent colour, and keeps its underline
  it('links take the primary colour and keep the underline', () => {
    expect(renderMd('[Apply](https://jobs.dou.ua/x/1)')).toHaveClass(
      '[&_a]:text-primary',
      '[&_a]:underline',
      '[&_a]:underline-offset-4',
    )
  })

  // UX-M-1: the description sits under the card's own h3 («Опис») and the dialog's h2 title, so a
  // posting's heading never outranks them: h1–h2 step down to h4, h3–h6 to h5
  it.each([
    ['# Title', 4],
    ['## Title', 4],
    ['### Title', 5],
    ['#### Title', 5],
    ['##### Title', 5],
    ['###### Title', 5],
  ])('%s renders as an h%i', (markdown, level) => {
    renderMd(markdown)
    const heading = screen.getByRole('heading', { name: 'Title' })
    expect(heading.tagName).toBe(`H${level}`)
    expect(heading).toHaveClass(
      ...(level === 4
        ? ['mt-4', 'mb-1', 'text-sm', 'font-semibold']
        : ['mt-3', 'mb-1', 'text-sm', 'font-medium']),
    )
    for (const higher of [1, 2, 3]) {
      expect(screen.queryByRole('heading', { level: higher })).toBeNull()
    }
  })
})
