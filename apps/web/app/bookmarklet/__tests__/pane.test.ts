import { describe, expect, it } from 'vitest'

import { extractVacancy } from '../extract'
import { findPane, guessTitle } from '../pane'
import type { Visible } from '../text'

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')
const URL_ = 'https://jobs.example.com/view/1'
const all: Visible = () => true
const notHidden: Visible = (el) => !el.hasAttribute('data-hidden')

// A paragraph whose words never repeat and carry no section cue.
const words = (n: number, from = 0): string =>
  Array.from({ length: n }, (_, i) => `word${from + i}`).join(' ')

const sections = (
  id = 'pane',
  intro = words(100),
): string => `<div id="${id}"><p>${intro}</p><h3>Responsibilities</h3><ul><li>Ship the ledger</li></ul>
  <h3>Requirements</h3><ul><li>Rust</li></ul></div>`

describe('findPane', () => {
  it('finds the cue cluster in a page with nav, footer and related jobs', () => {
    const doc = parse(`<body><nav><a href="/">Jobs</a><p>Requirements</p><p>Benefits</p></nav>
      <main>${sections()}<section><h3>Related jobs</h3><ul><li><a href="/2">Other role at Other Co</a></li></ul></section></main>
      <footer><p>What we offer</p><p>Perks</p></footer></body>`)
    const pane = findPane(doc, all)
    expect(pane?.cue).toBe(true)
    expect(pane?.el.id).toBe('pane')
    expect(pane?.text).toContain('word0')
    expect(pane?.text).toContain('- Rust')
    expect(pane?.text).not.toContain('Related jobs')
    expect(pane?.text).not.toContain('Jobs')
  })

  it('climbs from the sections to the block that holds their intro', () => {
    const doc = parse(
      `<body><main><div id="job"><p>${words(60)}</p>${sections('cues', 'Hi')}</div></main></body>`,
    )
    const pane = findPane(doc, all)
    expect(pane?.el.tagName).toBe('MAIN')
    expect(pane?.text.startsWith('word0')).toBe(true)
  })

  it('stops climbing once the block holds enough text', () => {
    const doc = parse(`<body><main><p>${words(90)}</p>${sections()}</main></body>`)
    expect(findPane(doc, all)?.el.id).toBe('pane')
  })

  it('rejects a link-dense result list and falls back to the text block', () => {
    const row = `<li><span>Requirements</span> <a href="/x">${words(12, 500)}</a></li>`
    const doc = parse(
      `<body><main><ul>${row.repeat(10)}</ul></main><div id="desc"><p>${words(100)}</p></div></body>`,
    )
    const pane = findPane(doc, all)
    expect(pane?.cue).toBe(false)
    expect(pane?.el.id).toBe('desc')
  })

  it('takes a following salary sibling and skips a link-dense one and anything after three', () => {
    const doc = parse(`<body><main>${sections()}
      <div><p>Team photos</p></div>
      <div><h3>Salary</h3><p>$120k–$150k</p></div>
      <div><a href="/a">Similar job paying $100k ${words(5, 300)}</a></div>
      <div><p>Compensation: 9000 USD</p></div></main></body>`)
    const text = findPane(doc, all)?.text ?? ''
    expect(text).toContain('Salary\n\n$120k–$150k')
    expect(text).not.toContain('Team photos')
    expect(text).not.toContain('Similar job')
    expect(text).not.toContain('9000 USD')
  })

  it('skips a salary sibling over 3000 characters or one the predicate hides', () => {
    const doc = parse(`<body><main>${sections()}
      <div><p>Salary ${'x'.repeat(3000)}</p></div>
      <div data-hidden><p>Salary 5000 EUR</p></div>
      <div><p>Salary 4000 EUR</p></div></main></body>`)
    const text = findPane(doc, notHidden)?.text ?? ''
    expect(text).toContain('Salary 4000 EUR')
    expect(text).not.toContain('xxx')
    expect(text).not.toContain('5000')
  })

  it('ignores a cue cluster the predicate hides', () => {
    const hidden = `<div id="old" data-hidden><h3>Requirements</h3><h3>Responsibilities</h3><h3>Benefits</h3></div>`
    const doc = parse(`<body><main>${hidden}${sections()}</main></body>`)
    expect(findPane(doc, notHidden)?.el.id).toBe('pane')
  })

  it('falls back to the largest low-link-density block when there are no cues', () => {
    const doc = parse(`<body><nav>${'<a href="/">Menu item</a>'.repeat(80)}</nav>
      <article id="post"><p>${words(120)}</p><p>${words(40, 200)}</p></article></body>`)
    const pane = findPane(doc, all)
    expect(pane?.cue).toBe(false)
    expect(pane?.el.id).toBe('post')
    expect(pane?.text).toBe(`${words(120)}\n\n${words(40, 200)}`)
  })

  it('takes no fallback block under 500 characters or one the predicate hides', () => {
    expect(findPane(parse(`<body><div><p>${'a'.repeat(450)}</p></div></body>`), all)).toBeNull()
    const doc = parse(`<body><div data-hidden><p>${words(100)}</p></div></body>`)
    expect(findPane(doc, notHidden)).toBeNull()
  })

  it('reads uk and pl section headings as cues', () => {
    const uk = parse(
      `<body><main><div id="pane"><p>${words(100)}</p><h3>Обов'язки</h3><p>a</p><h3>Вимоги</h3><p>b</p></div></main></body>`,
    )
    expect(findPane(uk, all)).toMatchObject({ cue: true, el: { id: 'pane' } })
    const pl = parse(
      `<body><main><div id="pane"><p>${words(100)}</p><h3>Wymagania</h3><p>a</p><h3>Oferujemy</h3><p>b</p></div></main></body>`,
    )
    expect(findPane(pl, all)).toMatchObject({ cue: true, el: { id: 'pane' } })
  })

  it.each([
    ['nl', 'Functieomschrijving', 'Functie-eisen', 'Wat bieden wij?'],
    [
      'en long form',
      "What you'll be doing:",
      'What we need to see:',
      'Ways to stand out from the crowd:',
    ],
  ])('reads %s section headings as cues', (_, ...heads) => {
    const cues = heads.map((h) => `<b>${h}</b><p>x</p>`).join('')
    const doc = parse(`<body><main><div id="pane"><p>${words(100)}</p>${cues}</div></main></body>`)
    expect(findPane(doc, all)).toMatchObject({ cue: true, el: { id: 'pane' } })
  })

  it('needs two cues and counts no cue inside a link, a button or a long block', () => {
    const one = parse(
      `<body><main><div id="pane"><p>${words(100)}</p><h3>Requirements</h3></div></main></body>`,
    )
    expect(findPane(one, all)?.cue).toBe(false)
    const linked =
      parse(`<body><main><div><p>${words(100)}</p><a href="/r">Requirements</a><button>Benefits</button>
      <p>Requirements ${'z'.repeat(80)}</p></div></main></body>`)
    expect(findPane(linked, all)?.cue).toBe(false)
  })
})

describe('guessTitle', () => {
  it('takes the pane h2 over the result-list h1 above it on a two-pane board', () => {
    const doc =
      parse(`<head><title>Board</title></head><body><main><h1>1,204 Go jobs</h1><ul><li>Other</li></ul>
      <div id="pane"><h2>Senior Go Engineer</h2></div></main></body>`)
    expect(guessTitle(doc, doc.getElementById('pane'), all)).toBe('Senior Go Engineer')
  })

  it('prefers a heading the tab title names, h1 first, at the nearest level', () => {
    const doc = parse(`<head><title>Data Engineer | Acme</title></head><body><main>
      <div id="pane"><h2>Team</h2><h2>Data Engineer</h2></div><h1>Acme</h1></main></body>`)
    expect(guessTitle(doc, doc.getElementById('pane'), all)).toBe('Data Engineer')
    const og = parse(
      `<head><meta property="og:title" content="QA Lead"></head><body><h2>Other</h2><h2>QA Lead</h2><h1>QA Lead</h1></body>`,
    )
    expect(guessTitle(og, null, all)).toBe('QA Lead')
  })

  it('skips a section-cue or generic heading', () => {
    const doc = parse(
      `<body><div id="pane"><h2>About the role</h2><h2>Description</h2><h2>Data Engineer</h2></div></body>`,
    )
    expect(guessTitle(doc, doc.getElementById('pane'), all)).toBe('Data Engineer')
  })

  it('skips a board brand the tab title names', () => {
    const doc = parse(
      `<head><title>Python Developer | Djinni</title></head><body><h1>Djinni</h1><h2>Python Developer</h2></body>`,
    )
    expect(guessTitle(doc, null, all)).toBe('Python Developer')
  })

  it('finds the first tab-title segment as a bare element when no heading names it', () => {
    const doc = parse(
      `<head><title>Platform Engineer · Oxide</title></head><body><h1>Careers</h1><div><span>Platform Engineer</span></div></body>`,
    )
    expect(guessTitle(doc, null, all)).toBe('Platform Engineer')
    const dashed = parse(
      `<head><title>MDE, SoftGoods - Jobs - Careers at Apple</title></head><body><h1>Shop</h1><div><span>MDE, SoftGoods</span></div></body>`,
    )
    expect(guessTitle(dashed, null, all)).toBe('MDE, SoftGoods')
  })

  it('skips a hidden heading and one in nav or footer, and gives nothing without one', () => {
    const doc = parse(
      `<body><nav><h1>Menu</h1></nav><h1 data-hidden>Old</h1><footer><h2>Links</h2></footer></body>`,
    )
    expect(guessTitle(doc, null, notHidden)).toBe('')
  })
})

describe('extractVacancy with a vacancy pane', () => {
  const ld = (description: string): string =>
    `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Rust Engineer',
      description,
      hiringOrganization: { name: 'Acme' },
    })}</script>`
  // A pane of even length, so a JSON-LD text of exactly half of it exists.
  const [body, paneText] = [100, 101]
    .map((n) => `<body><main>${sections('pane', words(n))}</main></body>`)
    .map((b) => [b, findPane(parse(b), all)?.text ?? ''] as const)
    .find(([, t]) => t.length % 2 === 0) as readonly [string, string]

  it('replaces a JSON-LD description the site cut short with the cue pane, as partial', () => {
    const cut = 'x'.repeat(paneText.length / 2 - 1)
    const p = extractVacancy(parse(`<head>${ld(cut)}</head>${body}`), URL_, '')
    expect(p.description).toBe(paneText)
    expect(p.status.description).toBe('guessed')
    expect(p.status.title).toBe('found')
    expect(p.recognition).toBe('partial')
    expect(p.pageText).toContain('word0')
  })

  it('keeps a JSON-LD description of at least half the cue pane', () => {
    const half = 'x'.repeat(paneText.length / 2)
    const p = extractVacancy(parse(`<head>${ld(half)}</head>${body}`), URL_, '')
    expect(p.description).toBe(half)
    expect(p.recognition).toBe('recognized')
    expect(p.pageText).toBeUndefined()
  })

  it('never replaces JSON-LD with a fallback block', () => {
    const doc = parse(
      `<head>${ld('Short.')}</head><body><article><p>${words(200)}</p></article></body>`,
    )
    const p = extractVacancy(doc, URL_, '')
    expect(p.description).toBe('Short.')
    expect(p.recognition).toBe('recognized')
  })

  it('reads a page with no JSON-LD from its cue pane, title guessed', () => {
    const doc = parse(
      `<head><title>Rust Engineer | Acme</title></head><body><main><h1>Rust Engineer</h1>${sections()}</main></body>`,
    )
    const p = extractVacancy(doc, URL_, '')
    expect(p.recognition).toBe('partial')
    expect(p.title).toBe('Rust Engineer')
    expect(p.status.title).toBe('guessed')
    expect(p.description).toContain('Requirements\n\n- Rust')
    expect(p.status.description).toBe('guessed')
    expect(p.company).toBeUndefined()
  })

  it('takes a job h1 inside an article header, which the page text leaves out', () => {
    const doc = parse(
      `<head><title>Fullstack Engineer · Fly</title></head><body><main><header><h1>Fullstack Engineer</h1></header><h2>A fussy role</h2>${sections()}</main></body>`,
    )
    expect(extractVacancy(doc, URL_, '').title).toBe('Fullstack Engineer')
    const site = parse(
      `<head><title>Search for Jobs</title></head><body><header><h1>Careers at Acme</h1></header><main><h2>SRE Engineer</h2>${sections()}</main></body>`,
    )
    expect(extractVacancy(site, URL_, '').title).toBe('SRE Engineer')
  })

  it('does not recognize a page from a fallback block alone', () => {
    const doc = parse(
      `<head><title>News</title></head><body><article><h1>News</h1><p>${words(200)}</p></article></body>`,
    )
    const p = extractVacancy(doc, URL_, '')
    expect(p.recognition).toBe('none')
    expect(p.description).toBeUndefined()
    expect(p.title).toBeUndefined()
  })
})
