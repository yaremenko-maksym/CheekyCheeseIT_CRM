import { describe, expect, it } from 'vitest'

import { extractVacancy } from '../extract'
import { findPane, guessTitle } from '../pane'
import { nodeText, type Visible } from '../text'

// Boundaries of the pane and title rules: each case sits exactly on a limit or a regex edge.

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')
const all: Visible = () => true
const notHidden: Visible = (el) => !el.hasAttribute('data-hidden')
const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
const CUES = '<h3>Responsibilities</h3><p>Ship it</p><h3>Requirements</h3><p>Rust</p>'

describe('findPane boundaries', () => {
  // One sure cue next to the one under test: a pane exists only when the second one counts.
  const counted = (cue: string): boolean =>
    findPane(parse(`<body><div><h3>Requirements</h3>${cue}<p>${words(20)}</p></div></body>`), all)
      ?.cue === true

  it.each([
    ['a trimmed cue under 70 characters', `<h3>  Benefits${'.'.repeat(61)}  </h3>`, true],
    ['a cue of exactly 70 characters', `<h3>Benefits${'.'.repeat(62)}</h3>`, false],
    ['a cue with two child elements', '<h3><span>What</span> we <span>offer</span></h3>', true],
    [
      'a cue with three child elements',
      '<h3><span>What</span> <span>we</span> <span>offer</span></h3>',
      false,
    ],
    ['"What youll bring"', '<h3>What youll bring</h3>', true],
    ['"What you\'ll do"', "<h3>What you'll do</h3>", true],
    ['"Were looking for"', '<h3>Were looking for</h3>', true],
  ])('counts %s as a cue: %s', (_, cue, expected) => {
    expect(counted(cue)).toBe(expected)
  })

  it('keeps a cue pane whose link density is exactly the limit', () => {
    // 26 letters of text and 14 of links: 14 / 40 = 0.35.
    const doc = parse(
      `<body><div id="p"><h3>Requirements</h3><h3>Benefits</h3><p>abcdef</p><a href="/x">abcdefghijklmn</a></div></body>`,
    )
    expect(findPane(doc, all)?.el.id).toBe('p')
  })

  it('stops climbing at exactly 600 characters of pane text', () => {
    const build = (pad: string): Document =>
      parse(`<body><section><div id="p">${CUES}<p>${pad}</p></div></section></body>`)
    const short = nodeText(build('y').getElementById('p'), all).length
    const doc = build('y'.repeat(1 + 600 - short))
    expect(nodeText(doc.getElementById('p'), all)).toHaveLength(600)
    expect(findPane(doc, all)?.el.id).toBe('p')
  })

  it('joins the pane and its pay sibling with a blank line', () => {
    const doc = parse(
      `<body><div id="p">${CUES}<p>${words(100)}</p></div><div><p>Salary 100k</p></div></body>`,
    )
    const pane = findPane(doc, all)
    expect(pane?.text).toBe(`${nodeText(doc.getElementById('p'), all)}\n\nSalary 100k`)
  })

  it('gives only the pay sibling when the pane itself shows no text', () => {
    const doc = parse(
      `<body><div id="a"><p data-hidden>${'x'.repeat(600)}</p></div><div><p>Salary 100k</p></div></body>`,
    )
    expect(findPane(doc, notHidden)?.text).toBe('Salary 100k')
  })

  const sibling = (block: string): string =>
    findPane(parse(`<body><div id="p">${CUES}<p>${words(100)}</p></div>${block}</body>`), all)
      ?.text ?? ''

  it.each(['$5', '$ 5', '€5', '€ 5', '£5', '£ 5', '5usd', '5 usd'])(
    'takes a sibling naming a pay of %s',
    (pay) => {
      expect(sibling(`<div><p>From ${pay}</p></div>`)).toContain(`From ${pay}`)
    },
  )

  it('takes a pay sibling of exactly 3000 characters', () => {
    const pay = `Salary ${'x'.repeat(2993)}`
    expect(sibling(`<div><p>${pay}</p></div>`)).toContain(pay)
  })

  it('takes a pay sibling whose link density is exactly the limit', () => {
    // 13 letters of text and 7 of links: 7 / 20 = 0.35.
    expect(sibling('<div>Salary 1234567<a href="/a">abcdefg</a></div>')).toContain('Salary 1234567')
  })

  it('counts letters, not spaces, in a pay sibling made mostly of a link', () => {
    expect(sibling('<div>Salary <a href="/a">abcdefghij</a></div>')).not.toContain('Salary')
  })

  it('takes a fallback block of exactly 500 characters', () => {
    expect(findPane(parse(`<body><div id="f">${'x'.repeat(500)}</div></body>`), all)?.el.id).toBe(
      'f',
    )
  })

  it('takes the block that holds the text, not a wrapper around one child', () => {
    const doc = parse(`<body><section id="s"><div id="d">${'x'.repeat(600)}</div></section></body>`)
    expect(findPane(doc, all)?.el.id).toBe('d')
  })

  it('keeps the first of two equal fallback blocks', () => {
    const block = (id: string): string => `<div id="${id}">${'x'.repeat(600)}</div>`
    expect(findPane(parse(`<body>${block('a')}${block('b')}</body>`), all)?.el.id).toBe('a')
  })
})

describe('guessTitle boundaries', () => {
  const title = (head: string, pane: string): string => {
    const doc = parse(`<head>${head}</head><body><div id="pane">${pane}</div></body>`)
    return guessTitle(doc, doc.getElementById('pane'), all).replace(/\s+/g, ' ')
  }

  it('takes an h1 over an earlier h2 at the same level', () => {
    expect(title('', '<h2>Team</h2><h1>Rust Engineer</h1>')).toBe('Rust Engineer')
  })

  it('takes a named h1 over an earlier named h2', () => {
    expect(
      title(
        '<title>Senior Rust Engineer | Acme</title>',
        '<h2>Rust Engineer</h2><h1>Senior Rust Engineer</h1>',
      ),
    ).toBe('Senior Rust Engineer')
  })

  it('matches a heading to the tab title by its words, whatever its spacing', () => {
    expect(
      title(
        '<title>Rust Engineer | Acme Lab</title>',
        '<h1>AcmeLab</h1><h1>Here</h1><h2>\n  Rust   Engineer\n</h2>',
      ),
    ).toBe('Rust Engineer')
  })

  it('names a heading from og:title when the tab title does not', () => {
    expect(
      title(
        '<title>Acme Careers</title><meta property="og:title" content="Rust Engineer">',
        '<h1>Platform</h1><h2>Rust Engineer</h2>',
      ),
    ).toBe('Rust Engineer')
  })

  it('skips a heading of 2 trimmed characters or of 160', () => {
    expect(title('', `<h1>\n AB \n</h1><h1>${'Q'.repeat(160)}</h1><h2>Rust Engineer</h2>`)).toBe(
      'Rust Engineer',
    )
  })

  it.each([
    ['a 3-character', '<title>Abc | Acme</title>', '<span>Abc</span>'],
    ['a board', '<title>LinkedIn | Jobs</title>', '<span>LinkedIn</span>'],
    ['a non-bare', '<title>Rust Engineer · Acme</title>', '<div><b>Rust</b> Engineer</div>'],
  ])('skips %s tab-title segment', (_, head, el) => {
    expect(title(head, `${el}<h1>Platform Team</h1>`)).toBe('Platform Team')
  })

  it.each([
    ['Product details', true],
    ['Description writer', true],
    ['Beschrijving van het bedrijf', false],
    ['Опис вакансії', false],
    ['Apply now', false],
  ])('treats the heading "%s" as a job title: %s', (heading, kept) => {
    expect(title('', `<h1>${heading}</h1><h1>Rust Engineer</h1>`)).toBe(
      kept ? heading : 'Rust Engineer',
    )
  })

  it.each([
    ['Careers advisor', false],
    ['Acme career', true],
    ['Remote jobs', false],
    ['Jobs at Acme', false],
    ['Job', true],
    ['Rust Engineer job id 7', false],
  ])('treats the named heading "%s" as a board name: %s', (heading, board) => {
    expect(title(`<title>${heading} | Acme</title>`, `<h1>Platform</h1><h2>${heading}</h2>`)).toBe(
      board ? 'Platform' : heading,
    )
  })
})

describe('extractVacancy recognition from a cue pane', () => {
  it('recognizes a page whose only vacancy signal is a cue pane outside main or article', () => {
    const doc = parse(`<body><div>${CUES}<p>${words(30)}</p></div></body>`)
    expect(extractVacancy(doc, 'https://jobs.example.com/1', '').recognition).toBe('partial')
  })
})
