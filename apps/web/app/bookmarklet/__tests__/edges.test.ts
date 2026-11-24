import type { ExternalVacancyPrefill } from '@crm/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { toBase64Url } from '../../lib/base64url'
import { extractVacancy, SELECTION_MIN } from '../extract'
import { fitToHash } from '../fit'
import { HASH_MAX, PAGE_TEXT_MAX, URL_MAX } from '../limits'
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

  it('skips a comment node', () => {
    const p = document.createElement('p')
    p.append('a', document.createComment('c'), 'b')
    expect(nodeText(p)).toBe('ab')
  })

  it('keeps a list item on its bullet line when its text sits in a block', () => {
    expect(nodeText(body('<ul><li><p>one</p></li></ul>'))).toBe('- one')
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

describe('htmlText under Trusted Types', () => {
  afterEach(() => vi.restoreAllMocks())
  it('still reads the text when the page refuses to parse a plain string', () => {
    vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(() => {
      throw new TypeError('This document requires TrustedHTML assignment')
    })
    expect(htmlText('<p>Senior  <b>Dev</b></p>\n<ul><li>x</li></ul><p>Go</p><p>Rust</p>')).toBe(
      'Senior Dev x Go Rust',
    )
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

  it('strips only the trailing " Logo" from the logo text, and copes with no logo', () => {
    expect(
      readProfile(gh('Engineer', '<img alt="Acme Logo Works Logo">'), 'greenhouse.io')?.company,
    ).toBe('Acme Logo Works')
    expect(readProfile(gh('Engineer'), 'greenhouse.io')?.company).toBe('')
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

  it('reads a JobPosting listed after a null node', () => {
    const p = extractVacancy(jsonLd([null, { '@type': 'JobPosting', title: 'Dev' }]), URL_, '')
    expect(p.title).toBe('Dev')
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

  it('tests vacancy cues against the longest main block, the first one on a tie, with no prefilled description', () => {
    const noCuesTie = `${'x'.repeat(CUES.length)} B`
    const p = extractVacancy(
      generic(
        '<title>T</title>',
        `<main>${CUES} A</main><article>${noCuesTie}</article><aside>x</aside>`,
      ),
      URL_,
      '',
    )
    expect(p.recognition).toBe('partial')
    expect(p.description).toBeUndefined()
    expect(p.status.description).toBe('missing')

    const tieSecondOnly = extractVacancy(
      generic('<title>T</title>', `<main>${noCuesTie}</main><article>${CUES} A</article>`),
      URL_,
      '',
    )
    expect(tieSecondOnly.recognition).toBe('none')

    const q = extractVacancy(
      generic('<title>T</title>', `<main>short</main><article>${CUES} longer</article>`),
      URL_,
      '',
    )
    expect(q.recognition).toBe('partial')
    expect(q.description).toBeUndefined()

    const longerNoCues = extractVacancy(
      generic('<title>T</title>', `<main>${'x'.repeat(60)}</main><article>${CUES}</article>`),
      URL_,
      '',
    )
    expect(longerNoCues.recognition).toBe('none')

    // A short cue block (6 chars) must win over the empty initial reduce seed
    const shortCue = extractVacancy(generic('<title>T</title>', '<main>Вимоги</main>'), URL_, '')
    expect(shortCue.recognition).toBe('partial')
  })

  it('does not recognize vacancy words on a page without any title', () => {
    expect(extractVacancy(generic('', `<main>${CUES}</main>`), URL_, '').recognition).toBe('none')
  })

  it('takes the generic company from og:site_name only, never from the page host', () => {
    const withoutSiteName = extractVacancy(
      generic('<title>T</title>', `<main>${CUES}</main>`),
      URL_,
      '',
    )
    expect(withoutSiteName.recognition).toBe('partial')
    expect(withoutSiteName.company).toBeUndefined()
    expect(withoutSiteName.status.company).toBe('missing')

    const withSiteName = extractVacancy(
      generic(
        '<title>T</title><meta property="og:site_name" content="Acme Corp">',
        `<main>${CUES}</main>`,
      ),
      URL_,
      '',
    )
    expect(withSiteName.company).toBe('Acme Corp')
    expect(withSiteName.status.company).toBe('guessed')
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

  it('ignores a canonical link on another host, so the note never names a site the HR was not on', () => {
    const p = extractVacancy(
      generic('<link rel="canonical" href="https://trusted.example.org/c">', ''),
      URL_,
      '',
    )
    expect(p.url).toBe(URL_)
  })

  it('sends no link longer than the CRM keeps, rather than one it would drop', () => {
    const at = `${URL_}?q=${'x'.repeat(URL_MAX - URL_.length - 3)}`
    expect(extractVacancy(generic('', ''), at, '').url).toBe(at)
    const p = extractVacancy(generic('', ''), `${at}x`, '')
    expect(p.url).toBeUndefined()
    expect(p.status.url).toBe('missing')
  })

  it('caps the page text, and copes with a document that has no body', () => {
    const long = extractVacancy(generic('', `<p>${'w '.repeat(PAGE_TEXT_MAX)}</p>`), URL_, '')
    expect(long.pageText).toHaveLength(PAGE_TEXT_MAX)
    const bare = doc('<p>x</p>')
    bare.documentElement.removeChild(bare.body)
    expect(extractVacancy(bare, URL_, '').pageText).toBe('')
  })
})
