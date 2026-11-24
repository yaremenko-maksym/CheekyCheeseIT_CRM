import type { ExternalVacancyPrefill } from '@crm/shared'
import { describe, expect, it } from 'vitest'

import { toBase64Url } from '../../lib/base64url'
import { extractVacancy, SELECTION_MIN } from '../extract'
import { fitToHash } from '../fit'
import { HASH_MAX, PAGE_TEXT_MAX } from '../limits'
import { readProfile } from '../profiles'
import { htmlText, nodeText } from '../text'

const doc = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')
const body = (html: string): HTMLElement => doc(html).body
const jsonLd = (data: unknown, rest = ''): Document =>
  doc(`<script type="application/ld+json">${JSON.stringify(data)}</script>${rest}`)
const URL_ = 'https://boards.example.com/jobs/1'
const CUES = 'Requirements: five years of TypeScript.'

describe('nodeText', () => {
  it('drops scripts, styles, noscript, svg and iframe content, and comments', () => {
    const html =
      'a<script>s</script><style>t</style><noscript>n</noscript><svg><text>v</text></svg>' +
      '<iframe>i</iframe><!-- c -->b'
    expect(nodeText(body(html))).toBe('ab')
  })

  it('keeps inline elements on the line and puts each block on its own', () => {
    expect(nodeText(body('x<sup>2</sup><picture>p</picture>a<hr>b'))).toBe('x2pab')
    expect(nodeText(body('<h2>Title</h2>tail'))).toBe('Title\ntail')
  })

  it('bullets a list item with its own spacing trimmed', () => {
    expect(nodeText(body('<ul><li>  one  </li><li>two</li></ul>'))).toBe('- one\n\n- two')
  })

  it('collapses runs of spaces and the spaces around a line break', () => {
    expect(nodeText(body('a \n\t  b'))).toBe('a b')
    expect(nodeText(body('<p>a</p> b'))).toBe('a\nb')
    expect(nodeText(body('<p>a </p>b'))).toBe('a\nb')
  })

  it('keeps at most one empty line between blocks', () => {
    expect(nodeText(body('<p>a</p><p>b</p>'))).toBe('a\n\nb')
    expect(nodeText(body('<div><p>a</p></div><p>b</p>'))).toBe('a\n\nb')
  })

  it('reads markup in a string as text only', () => {
    expect(htmlText('<b>bold</b> &amp; <img src=x onerror=alert(1)>')).toBe('bold &')
  })
})

describe('readProfile', () => {
  const gh = (title: string, extra = '') =>
    doc(`<title>${title}</title><div class="job__title"><h1>Engineer</h1></div>${extra}`)

  it('takes the Greenhouse company from the page title, else from the logo', () => {
    expect(readProfile(gh('Job Application for Engineer at Acme Corp'), 'greenhouse.io')).toEqual({
      title: 'Engineer',
      company: 'Acme Corp',
      description: '',
    })
    expect(
      readProfile(gh('Engineer', '<img alt="Acme Logo">'), 'boards.greenhouse.io')?.company,
    ).toBe('Acme')
  })

  it('matches a site and its subdomains only', () => {
    expect(readProfile(gh('Engineer at Acme'), 'evilgreenhouse.io')).toBeNull()
  })

  it('gives nothing for a known site page that has neither a title nor a description', () => {
    expect(readProfile(doc('<p>login</p>'), 'jobs.dou.ua')).toBeNull()
  })
})

describe('fitToHash', () => {
  it('leaves a payload that is exactly at the limit as it is', () => {
    const base: ExternalVacancyPrefill = {
      v: 1,
      recognition: 'partial',
      pageText: '',
      status: { url: 'missing', title: 'missing', company: 'missing', description: 'missing' },
    }
    // 3 JSON bytes are 4 base64url chars, so this JSON length encodes to HASH_MAX exactly
    const pad = (HASH_MAX / 4) * 3 - JSON.stringify(base).length
    const p = { ...base, pageText: 'a'.repeat(pad) }
    expect(toBase64Url(JSON.stringify(p))).toHaveLength(HASH_MAX)
    expect(fitToHash(p)).toEqual(p)
  })
})

describe('extractVacancy: JSON-LD edges', () => {
  it('reads a JobPosting typed as a list, with the company as a plain string', () => {
    const p = extractVacancy(
      jsonLd({ '@type': ['JobPosting', 'Thing'], title: 'Dev', hiringOrganization: 'Acme' }),
      URL_,
      '',
    )
    expect(p.title).toBe('Dev')
    expect(p.company).toBe('Acme')
  })

  it('reads past a null node and a missing organization, and ignores a title that is not text', () => {
    const p = extractVacancy(
      jsonLd([null, { '@type': 'JobPosting', title: { a: 1 }, hiringOrganization: null }]),
      'not a url',
      '',
    )
    expect(p.recognition).toBe('partial')
    expect(p.title).toBeUndefined()
    expect(p.company).toBeUndefined()
  })
})

describe('extractVacancy: generic page edges', () => {
  const generic = (head: string, main: string) => doc(`<head>${head}</head><body>${main}</body>`)

  it('takes the og:title trimmed, then the h1, then the document title', () => {
    const main = `<main>${CUES}</main>`
    expect(
      extractVacancy(generic('<meta property="og:title" content="  OG  ">', main), URL_, '').title,
    ).toBe('OG')
    expect(
      extractVacancy(
        generic('<meta property="og:title"><title>T</title>', `<h1>H</h1>${main}`),
        URL_,
        '',
      ).title,
    ).toBe('H')
    expect(extractVacancy(generic('<title>T</title>', main), URL_, '').title).toBe('T')
  })

  it('takes the longest main block, the first one on a tie', () => {
    const p = extractVacancy(
      generic(
        '<title>T</title>',
        `<main>${CUES} AAAA</main><article>${CUES} BBBB</article><aside>x</aside>`,
      ),
      URL_,
      '',
    )
    expect(p.description).toBe(`${CUES} AAAA`)
    const q = extractVacancy(
      generic('<title>T</title>', `<main>${CUES}</main><article>${CUES} longer</article>`),
      URL_,
      '',
    )
    expect(q.description).toBe(`${CUES} longer`)
  })

  it('does not recognize vacancy words on a page without any title', () => {
    expect(extractVacancy(generic('', `<main>${CUES}</main>`), URL_, '').recognition).toBe('none')
  })

  it('names no company when the page URL has no host and the page no site name', () => {
    const p = extractVacancy(generic('<title>T</title>', `<main>${CUES}</main>`), 'not a url', '')
    expect(p.recognition).toBe('partial')
    expect(p.company).toBeUndefined()
    expect(p.status.company).toBe('missing')
  })

  it('takes a selection of exactly the minimum length', () => {
    const picked = 'x'.repeat(SELECTION_MIN)
    const p = extractVacancy(generic('', ''), URL_, picked)
    expect(p.description).toBe(picked)
    expect(p.recognition).toBe('partial')
  })

  it('prefers an https canonical link to the page address', () => {
    const p = extractVacancy(
      generic('<link rel="canonical" href="https://boards.example.com/c">', ''),
      URL_,
      '',
    )
    expect(p.url).toBe('https://boards.example.com/c')
  })

  it('caps the page text, and copes with a document that has no body', () => {
    const long = extractVacancy(generic('', `<p>${'w '.repeat(PAGE_TEXT_MAX)}</p>`), URL_, '')
    expect(long.pageText).toHaveLength(PAGE_TEXT_MAX)
    const bare = doc('<p>x</p>')
    bare.documentElement.removeChild(bare.body)
    expect(extractVacancy(bare, URL_, '').pageText).toBe('')
  })
})
