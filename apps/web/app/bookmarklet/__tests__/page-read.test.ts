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

  it('keeps an escaped tag mention inside real markup as text', () => {
    expect(
      htmlText(
        '<p>Semantic HTML: &lt;section&gt; and &lt;script&gt; loading. Tail text stays.</p><p>Second paragraph.</p>',
      ),
    ).toBe('Semantic HTML: <section> and <script> loading. Tail text stays.\n\nSecond paragraph.')
    expect(
      htmlText(
        '<p>Icons as inline &lt;svg&gt; in React. Tail text stays.</p><p>Second paragraph.</p>',
      ),
    ).toBe('Icons as inline <svg> in React. Tail text stays.\n\nSecond paragraph.')
    expect(htmlText('<p>List&lt;String&gt; in Java</p>')).toBe('List<String> in Java')
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

  it('keeps a tag mention in plain text, and decodes formatting next to raw markup', () => {
    expect(htmlText('Knowledge of &lt;script&gt; loading. Tail text.')).toBe(
      'Knowledge of <script> loading. Tail text.',
    )
    expect(htmlText('List&lt;String&gt; and &lt;svg&gt; icons')).toBe(
      'List<String> and <svg> icons',
    )
    expect(htmlText('&lt;p&gt;Build&lt;/p&gt;<br>more')).toBe('Build\nmore')
  })

  it('decodes a second time for every formatting tag, and for no other tag', () => {
    for (const tag of [
      'p',
      'br',
      'strong',
      'b',
      'i',
      'em',
      'u',
      'ul',
      'ol',
      'li',
      'h1',
      'h6',
      'div',
      'span',
      'a',
    ]) {
      expect(htmlText(`x &lt;${tag}&gt;y`), tag).not.toContain('<')
    }
    expect(htmlText('x &lt;span class="k"&gt;y')).toBe('x y')
    expect(htmlText('x &lt;input&gt;y')).toBe('x <input>y')
    expect(htmlText('x &lt;h7&gt;y')).toBe('x <h7>y')
  })

  it('keeps an escaped script inert', () => {
    expect(htmlText('&lt;img src=x onerror="window.__pwned3=1"&gt;ok')).toBe(
      '<img src=x onerror="window.__pwned3=1">ok',
    )
    expect(htmlText('&lt;p&gt;&lt;img src=x onerror="window.__pwned3=1"&gt;ok&lt;/p&gt;')).toBe(
      'ok',
    )
    expect((window as unknown as { __pwned3?: number }).__pwned3).toBeUndefined()
  })
})

describe('htmlText under Trusted Types, by hand', () => {
  const refuse = (): void => {
    vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(() => {
      throw new TypeError('This document requires TrustedHTML assignment')
    })
  }

  it('decodes the entities a field uses, &amp; last', () => {
    refuse()
    expect(htmlText('Tom &quot;J&quot; &#39;s &lt;3 &gt; 2')).toBe('Tom "J" \'s <3 > 2')
    expect(htmlText('5 &amp;lt; 6')).toBe('5 &lt; 6')
  })

  it('decodes formatting escaped twice, and keeps a tag mention as text', () => {
    refuse()
    expect(htmlText('&lt;p&gt;Build&lt;/p&gt;&lt;b&gt;Go&lt;/b&gt;')).toBe('Build Go')
    expect(htmlText('<p>List&lt;String&gt; in Java</p>')).toBe('List<String> in Java')
    expect(htmlText('Knowledge of &lt;script&gt; loading.')).toBe('Knowledge of <script> loading.')
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

  it('drops [hidden] text with the default predicate, keeping aria-hidden text', () => {
    document.body.innerHTML =
      '<p>one</p><p hidden>two</p><p aria-hidden="true">behind a dialog</p><p>four</p>'
    expect(pageText(document)).toBe('one\n\nbehind a dialog\n\nfour')
  })

  it('drops page chrome and what the layout hides, reading the live page', () => {
    document.body.innerHTML =
      '<nav>menu</nav><header>top</header><main>body</main><aside>side</aside><footer>end</footer><p style="display:none">gone</p>'
    expect(pageText(document)).toBe('body')
  })
})

describe('isVisible', () => {
  it('asks the layout for an element of a rendered page, ignoring opacity', () => {
    document.body.innerHTML = '<p>x</p>'
    const p = document.querySelector('p') as Element
    const check = vi.spyOn(p, 'checkVisibility').mockReturnValue(false)
    expect(isVisible(p)).toBe(false)
    expect(check).toHaveBeenCalledWith({ checkVisibilityCSS: true })
  })

  it('sees visibility:hidden as hidden and opacity:0 as shown, as a scroll reveal starts there', () => {
    document.body.innerHTML = '<p style="visibility:hidden">x</p><p style="opacity:0">y</p>'
    const [hidden, faded] = Array.from(document.querySelectorAll('p'))
    expect(isVisible(hidden as Element)).toBe(false)
    expect(isVisible(faded as Element)).toBe(true)
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

  const read = (description: string, body: string): ReturnType<typeof extractVacancy> =>
    extractVacancy(parse(`<body>${ld(job('Dev', description))}${body}</body>`), URL_, '')

  // A paragraph whose words never repeat, so its tail is found only where the text really ends.
  const words = (n: number, from = 0): string =>
    Array.from({ length: n }, (_, i) => `word${from + i}`).join(' ')

  it('keeps a full description on a two-pane board whose result list repeats its opening', () => {
    const description = `${words(60)}.`
    const list = `<li>Other role · Other Co · ${description.slice(0, 80)}… 3 days ago</li>`.repeat(
      30,
    )
    const p = read(
      description,
      `<main><ul>${list}</ul><section><h2>Dev</h2><div>${description}</div></section></main>`,
    )
    expect(p.recognition).toBe('recognized')
    expect(p.description).toBe(description)
  })

  it('keeps a short full description in a wrapper with company, benefits and apply text', () => {
    const body = `<p>We build a freight platform.</p><p>Requirements</p><ul><li>${words(8)}</li></ul>`
    const p = read(
      body,
      `<main><div>Acme · Remote</div><div>${body}</div><p>Benefits: ${words(
        10,
        100,
      )}</p><a href="/apply">Apply now and join the team today</a></main>`,
    )
    expect(p.recognition).toBe('recognized')
    expect(p.description).toBe(`We build a freight platform.\n\nRequirements\n\n- ${words(8)}`)
  })

  it('keeps a description the page does not show, or shows only in hidden or chrome blocks', () => {
    const d = words(20)
    const more = ` ${words(20, 50)}`
    expect(read(d, `<main><p>${words(40, 100)}</p></main>`).status.description).toBe('found')
    expect(read(d, `<div hidden><p>${d}${more}</p></div>`).status.description).toBe('found')
    expect(read(d, `<aside><p>${d}${more}</p></aside><main>x</main>`).status.description).toBe(
      'found',
    )
    expect(
      read(d, `<script type="text/template">${d}${more}</script><main>x</main>`).status.description,
    ).toBe('found')
  })

  it('does not count a full copy the layout hides', () => {
    document.body.innerHTML = `${ld(job('Dev', words(20)))}<div style="display:none"><p>${words(
      20,
    )} ${words(20, 50)}</p></div><main>x</main>`
    expect(extractVacancy(document, URL_, '').status.description).toBe('found')
  })

  it('takes a description cut after "..." as missing', () => {
    const p = read(`${words(20)}...`, `<main><p>${words(20)} ${words(20, 50)}</p></main>`)
    expect(p.recognition).toBe('partial')
    expect(p.status.description).toBe('missing')
  })

  it('needs at least 20 more page characters after the tail, not 19', () => {
    const d = words(10)
    expect(read(d, `<p>${d} ${'z'.repeat(20)}</p>`).status.description).toBe('missing')
    expect(read(d, `<p>${d} ${'z'.repeat(19)}</p>`).status.description).toBe('found')
  })

  it('reads a tail of 20 characters or more, and none shorter', () => {
    const more = ` ${'z'.repeat(40)}`
    expect(read('a'.repeat(20), `<p>${'a'.repeat(20)}${more}</p>`).status.description).toBe(
      'missing',
    )
    expect(read('a'.repeat(19), `<p>${'a'.repeat(19)}${more}</p>`).status.description).toBe('found')
  })

  it('matches only the last 40 characters of the last line', () => {
    const d = `<p>First paragraph.</p><p>${'x'.repeat(10)}${'y'.repeat(40)}</p>`
    expect(read(d, `<p>${'y'.repeat(40)}${'z'.repeat(20)}</p>`).status.description).toBe('missing')
  })

  it('reads the tail from the last line only, and from one walk of the page lines', () => {
    const d = `<p>${words(12)}</p><p>${words(12, 50)}</p>`
    // The first paragraph goes on, the last one ends: the description is whole.
    expect(
      read(d, `<p>${words(12)} ${words(10, 200)}</p><p>${words(12, 50)}</p>`).status.description,
    ).toBe('found')
    // The tail ends one line and the next line holds more: still whole.
    expect(read(d, `<p>${words(12, 50)}</p><p>${words(10, 200)}</p>`).status.description).toBe(
      'found',
    )
  })

  it('takes the tail from a short last line alone', () => {
    const d = `<p>${words(12)}</p><p>${'y'.repeat(25)}</p>`
    const page = `<p>${words(12)}</p><p>${'y'.repeat(25)}${'z'.repeat(20)}</p>`
    expect(read(d, page).status.description).toBe('missing')
  })

  it('compares the tail without whitespace, dashes and bullets', () => {
    const d = 'Rust - Go – SQL — Kafka ‐ gRPC ‑ Redis ‒ Nats • Linux · Bash'
    const page = `Rust — Go - SQL – Kafka - gRPC - Redis - Nats · Linux • Bash ${words(10, 100)}`
    expect(read(d, `<p>${page}</p>`).status.description).toBe('missing')
  })

  it('keeps a JSON-LD description on a page without a body', () => {
    const doc = parse(`<head>${ld(job('Dev', 'Do things', 'Acme'))}</head>`)
    doc.documentElement.removeChild(doc.body)
    expect(extractVacancy(doc, URL_, '').description).toBe('Do things')
  })

  const two = (head: string, body: string, ...titles: string[]): string | undefined =>
    extractVacancy(
      parse(`<head>${head}</head><body>${ld(titles.map((t) => job(t, 'x')))}${body}</body>`),
      URL_,
      '',
    ).title

  it('prefers the JobPosting the page names, case-insensitive, over the first one', () => {
    expect(two('', '<h1>RUST DEV at Acme</h1>', 'Other', 'Rust Dev')).toBe('Rust Dev')
    expect(
      two('<meta property="og:title" content="Rust Dev | Board">', '', 'Other', 'Rust Dev'),
    ).toBe('Rust Dev')
    expect(two('<title>Rust Dev — Board</title>', '', 'Other', 'Rust Dev')).toBe('Rust Dev')
    expect(two('<title>Board</title>', '<h1>Jobs</h1>', 'Other', 'Rust Dev')).toBe('Other')
    expect(two('<title>Remote jobs board</title>', '', 'Other', 'Senior Rust Developer')).toBe(
      'Other',
    )
  })

  it('prefers the longest contained title over a shorter related one listed first', () => {
    const SBE = 'Senior Backend Engineer'
    const h1 = `<h1>${SBE}</h1>`
    expect(two('', h1, 'Engineer', SBE)).toBe(SBE)
    // Contained, not exact: the longest wins wherever it is listed, and one page name is enough.
    const head = '<meta property="og:title" content="Acme careers">'
    const named = `<h1>${SBE} at Acme</h1>`
    expect(two(head, named, 'Engineer', SBE, 'Backend')).toBe(SBE)
    expect(two(head, named, 'Engineer', 'Backend', SBE)).toBe(SBE)
    expect(two(head, named, SBE, 'Engineer', 'Backend')).toBe(SBE)
  })

  it('matches a page name either way and takes the largest overlap', () => {
    // The own title holds the h1, a related one is held by it: the own one overlaps more.
    const h1 = '<h1>Senior QA Engineer</h1>'
    expect(two('', h1, 'Senior QA Engineer (m/f/d)', 'QA Engineer')).toBe(
      'Senior QA Engineer (m/f/d)',
    )
    expect(two('', h1, 'QA Engineer', 'Senior QA Engineer (m/f/d)')).toBe(
      'Senior QA Engineer (m/f/d)',
    )
    // A generic title held by a long tab title loses to the posting the h1 names.
    expect(
      two(
        '<title>Engineering jobs at Acme</title>',
        '<h1>Senior Data Engineer</h1>',
        'Engineering',
        'Senior Data Engineer',
      ),
    ).toBe('Senior Data Engineer')
  })

  it('trims page names and keeps document order on an equal overlap', () => {
    const og = '<meta property="og:title" content=" backend ENGINEER ">'
    expect(two(og, '', 'Senior Backend Engineer', 'Backend Engineer')).toBe(
      'Senior Backend Engineer',
    )
    expect(two(og, '', 'Backend Engineer', 'Senior Backend Engineer')).toBe('Backend Engineer')
  })

  it('never matches a JobPosting by an empty title', () => {
    expect(two('', '<h1>Rust Dev</h1>', '', 'Rust Dev')).toBe('Rust Dev')
    expect(two('<title>Board</title>', '', 'Other', '')).toBe('Other')
    expect(two('', '', 'Other', '')).toBe('Other')
  })
})
