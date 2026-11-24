import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { extractVacancy, isVisible, pageText } from '../extract'
import { htmlText, nodeText } from '../text'

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')
const URL_ = 'https://jobs.example.com/view/1'
const ld = (data: unknown): string =>
  `<script type="application/ld+json">${JSON.stringify(data)}</script>`
const job = (title: string, description: string, company = 'Acme'): object => ({
  '@type': 'JobPosting',
  title,
  description,
  hiringOrganization: { name: company },
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('htmlText on an escaped JSON-LD field', () => {
  it('decodes markup escaped twice into plain text', () => {
    expect(htmlText('&lt;p&gt;Build&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;')).toBe(
      'Build\n\n- Go',
    )
  })

  it('still decodes markup escaped once in one pass', () => {
    expect(htmlText('<p>Build</p><ul><li>Go</li></ul>')).toBe('Build\n\n- Go')
  })

  it('takes a closing, an upper-case or an attributed tag as markup', () => {
    expect(htmlText('a&lt;/b&gt;b')).toBe('ab')
    expect(htmlText('a&lt;B&gt;b')).toBe('ab')
    expect(htmlText('&lt;a href="x"&gt;link&lt;/a&gt;')).toBe('link')
  })

  it('decodes no further when the text only looks like comparisons', () => {
    expect(htmlText('5 &amp;lt; 6')).toBe('5 &lt; 6')
    expect(htmlText('&lt; 6 &gt; &amp;amp;')).toBe('< 6 > &amp;')
  })

  it('decodes at most twice', () => {
    expect(htmlText('&lt;b&gt;&amp;lt;i&amp;gt;x')).toBe('<i>x')
  })

  it('keeps an escaped script inert', () => {
    expect(htmlText('&lt;img src=x onerror="window.__pwned3=1"&gt;ok')).toBe('ok')
    expect((window as unknown as { __pwned3?: number }).__pwned3).toBeUndefined()
  })
})

describe('nodeText with a visibility predicate', () => {
  it('skips an element the predicate rejects, with its subtree', () => {
    const body = parse('<p>keep</p><div data-hidden><p>drop</p>x</div><p>tail</p>').body
    expect(nodeText(body, (el) => !el.hasAttribute('data-hidden'))).toBe('keep\n\ntail')
  })

  it('keeps everything without a predicate', () => {
    expect(nodeText(parse('<p hidden>a</p><p>b</p>').body)).toBe('a\n\nb')
  })
})

describe('pageText', () => {
  it('drops the text of an element the injected predicate rejects', () => {
    const doc = parse('<main><p>Visible role</p><div data-hidden>{"theme":"dark"}</div></main>')
    const text = pageText(doc, (el) => !el.hasAttribute('data-hidden'))
    expect(text).toBe('Visible role')
  })

  it('drops [hidden] and aria-hidden="true" text with the default predicate, keeping the rest', () => {
    document.body.innerHTML =
      '<p>one</p><p hidden>two</p><p aria-hidden="true">three</p><p aria-hidden="false">four</p>'
    expect(pageText(document)).toBe('one\n\nfour')
  })

  it('drops page chrome and what the layout hides, reading the live page', () => {
    document.body.innerHTML =
      '<nav>menu</nav><header>top</header><main>body</main><aside>side</aside><footer>end</footer><p style="display:none">gone</p>'
    expect(pageText(document)).toBe('body')
  })
})

describe('isVisible', () => {
  it('asks the layout for an element of a rendered page', () => {
    document.body.innerHTML = '<p>x</p>'
    const p = document.querySelector('p') as Element
    const check = vi.spyOn(p, 'checkVisibility').mockReturnValue(false)
    expect(isVisible(p)).toBe(false)
    expect(check).toHaveBeenCalledWith({ checkOpacity: true, checkVisibilityCSS: true })
  })

  it('sees visibility:hidden as hidden on a rendered page', () => {
    document.body.innerHTML = '<p style="visibility:hidden">x</p><p style="opacity:0">y</p>'
    const [hidden, clear] = Array.from(document.querySelectorAll('p'))
    expect(isVisible(hidden as Element)).toBe(false)
    expect(isVisible(clear as Element)).toBe(false)
  })

  it('keeps an element when the browser has no checkVisibility', () => {
    document.body.innerHTML = '<p>x</p>'
    const p = document.querySelector('p') as Element
    Object.defineProperty(p, 'checkVisibility', { value: undefined })
    expect(isVisible(p)).toBe(true)
  })

  it('keeps a display:contents wrapper, which has no box of its own', () => {
    document.body.innerHTML = '<div style="display:contents"><p>x</p></div>'
    const div = document.querySelector('div') as Element
    vi.spyOn(div, 'checkVisibility').mockReturnValue(false)
    expect(isVisible(div)).toBe(true)
  })

  it('keeps every element of a document without a window, which has no layout', () => {
    const doc = parse('<p>x</p>')
    Object.defineProperty(doc, 'defaultView', { value: null })
    const p = doc.querySelector('p') as Element
    vi.spyOn(p, 'checkVisibility').mockReturnValue(false)
    expect(isVisible(p)).toBe(true)
  })
})

const fixture = (name: string): Document =>
  parse(readFileSync(resolve(__dirname, '../__fixtures__', name), 'utf8'))

describe('extractVacancy on JSON-LD', () => {
  it('reads an HTML-escaped JSON-LD description as plain text', () => {
    const p = extractVacancy(fixture('escaped-jsonld-job.html'), URL_, '')
    expect(p.recognition).toBe('recognized')
    expect(p.title).toBe('Backend Engineer')
    expect(p.company).toBe('Example Freight')
    expect(p.description).toBe(
      'We move parcels across Europe.\n\nRequirements\n\n- Go\n\n- PostgreSQL',
    )
    expect(p.description).not.toMatch(/[<>]/)
    expect((window as unknown as { __pwned2?: number }).__pwned2).toBeUndefined()
  })

  const fullText = `${'We build a payments ledger in Rust. '.repeat(60)}The tail: a four-day week.`
  const truncated = (): Document =>
    parse(
      `<head><title>Remote jobs</title></head><body>${ld([
        job('Data Analyst', 'Related job, full text. '.repeat(5), 'Other Co'),
        job('Senior Rust Engineer', `${fullText.slice(0, 1000)}…`, 'Acme Remote'),
      ])}<nav>${'Jobs '.repeat(400)}</nav><h1>Senior Rust Engineer</h1><main><p>${fullText}</p></main></body>`,
    )

  it('takes a JSON-LD description cut short of the page as missing and sends the page text', () => {
    const p = extractVacancy(truncated(), URL_, '')
    expect(p.recognition).toBe('partial')
    expect(p.status.description).toBe('missing')
    expect(p.description).toBeUndefined()
    expect(p.pageText).toContain('The tail: a four-day week.')
    expect(p.title).toBe('Senior Rust Engineer')
    expect(p.company).toBe('Acme Remote')
    expect(p.status.title).toBe('found')
  })

  const sized = (description: number, body: string): ReturnType<typeof extractVacancy> =>
    extractVacancy(
      parse(`<body>${ld(job('Dev', 'd'.repeat(description)))}${body}</body>`),
      URL_,
      '',
    )

  it('counts a description of exactly half the main text, not one character shorter', () => {
    const main = `<main>${'m'.repeat(40)}</main>`
    expect(sized(20, main).status.description).toBe('found')
    expect(sized(19, main).status.description).toBe('missing')
  })

  it('measures against the longest main block, in either order', () => {
    const short = `<article>${'a'.repeat(10)}</article>`
    const long = `<div role="main">${'l'.repeat(40)}</div>`
    expect(sized(15, short + long).status.description).toBe('missing')
    expect(sized(15, long + short).status.description).toBe('missing')
    expect(sized(20, short + long).status.description).toBe('found')
  })

  it('measures the body without its chrome when the page has no main block', () => {
    const body = `<nav>${'n'.repeat(100)}</nav><p>${'p'.repeat(20)}</p>`
    expect(sized(10, body).status.description).toBe('found')
    expect(sized(9, body).status.description).toBe('missing')
  })

  it('does not count hidden text of the main block', () => {
    const main = `<main>${'m'.repeat(20)}<div hidden>${'h'.repeat(100)}</div></main>`
    expect(sized(10, main).status.description).toBe('found')
  })

  it('prefers the JobPosting the page names, case-insensitive, over the first one', () => {
    const two = (head: string, body = ''): string | undefined =>
      extractVacancy(
        parse(
          `<head>${head}</head><body>${ld([job('Other', 'x'), job('Rust Dev', 'y')])}${body}</body>`,
        ),
        URL_,
        '',
      ).title
    expect(two('', '<h1>RUST DEV at Acme</h1>')).toBe('Rust Dev')
    expect(two('<meta property="og:title" content="Rust Dev | Board">')).toBe('Rust Dev')
    expect(two('<title>Rust Dev — Board</title>')).toBe('Rust Dev')
    expect(two('<title>Board</title>', '<h1>Jobs</h1>')).toBe('Other')
  })

  it('never matches a JobPosting by an empty title', () => {
    const p = extractVacancy(
      parse(`<body>${ld([job('', 'x'), job('Rust Dev', 'y')])}<h1>Rust Dev</h1></body>`),
      URL_,
      '',
    )
    expect(p.title).toBe('Rust Dev')
  })

  it('never matches a JobPosting title across two of the page names', () => {
    const p = extractVacancy(
      parse(
        `<head><meta property="og:title" content="Go Rust "></head><body>${ld([job('Other', 'x'), job('Rust Dev', 'y')])}<h1>Developer</h1></body>`,
      ),
      URL_,
      '',
    )
    expect(p.title).toBe('Other')
  })
})
