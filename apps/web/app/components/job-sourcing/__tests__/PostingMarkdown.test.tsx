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

  it('merges the caller class with the prose base', () => {
    render(<PostingMarkdown markdown="x" testId="md2" className="mt-4" />)
    const md = screen.getByTestId('md2')
    expect(md.className).toContain('mt-4')
    expect(md.className).toContain('prose')
  })
})
