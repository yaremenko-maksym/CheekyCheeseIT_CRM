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

  it('counts a heading wrapped in a cue element once, so it forms no cluster alone', () => {
    const doc = parse(
      `<body><div><h3><strong>Requirements</strong></h3><p>${words(20)}</p></div></body>`,
    )
    expect(findPane(doc, all)?.cue).not.toBe(true)
  })

  it('counts the inner cues, not a short block that holds two of them', () => {
    const doc = parse('<body><div id="p"><h3>Requirements</h3><h3>Benefits</h3></div></body>')
    expect(findPane(doc, all)?.el.id).toBe('p')
  })

  it('keeps a short cue pane rather than climb into a list of job links', () => {
    const links = Array.from(
      { length: 10 },
      (_, i) => `<li><a href="/j/${i}">Senior Rust Engineer at Example</a></li>`,
    ).join('')
    const doc = parse(
      `<body><section><div id="p">${CUES}<p>Short</p></div><ul>${links}</ul></section></body>`,
    )
    expect(findPane(doc, all)?.el.id).toBe('p')
  })

  it('climbs into a parent whose link density is exactly the limit', () => {
    // The pane shows 52 letters, the parent adds 28 of links: 28 / 80 = 0.35.
    const doc = parse(
      `<body><section id="s"><div id="p">${CUES}<p>abcdefghijklmn</p></div><a href="/x">abcdefghijklmnopqrstuvwxyzab</a></section></body>`,
    )
    expect(findPane(doc, all)?.el.id).toBe('s')
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

  it('keeps the first block over a longer one whose links bring its score down to a tie', () => {
    // b: 4000 chars, 10 links of 200 (half its letters): (4000 - 180) * 0.5 ** 2 = 955, a's score.
    const links = Array.from({ length: 10 }, () => `<a href="/x">${'z'.repeat(200)}</a>`).join('')
    const doc = parse(
      `<body><div id="a">${'x'.repeat(955)}</div><div id="b">${'y'.repeat(2000)}${links}</div></body>`,
    )
    expect(findPane(doc, all)?.el.id).toBe('a')
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

  it('takes a named h1 outside the pane over a named h2 inside it', () => {
    const doc = parse(
      '<head><title>Engineer | Acme</title></head><body><h1>Engineer</h1><div id="pane"><h2>Acme</h2></div></body>',
    )
    expect(guessTitle(doc, doc.getElementById('pane'), all)).toBe('Engineer')
  })

  const leading = (head: string, above: string, inPane: string): string => {
    const doc = parse(`<head>${head}</head><body>${above}<div id="pane">${inPane}</div></body>`)
    return guessTitle(doc, doc.getElementById('pane'), all)
  }

  it.each([' | ', ' · ', ' – ', ' — '])(
    'takes the heading the tab title leads with, split on "%s", over a brand h1 it also names',
    (sep) => {
      expect(
        leading(
          `<title>Data Engineer${sep}Acme</title>`,
          '<h1>Acme</h1>',
          '<h2>Data Engineer</h2>',
        ),
      ).toBe('Data Engineer')
    },
  )

  it('takes the heading og:title leads with', () => {
    expect(
      leading(
        '<title>Acme careers</title><meta property="og:title" content="Data Engineer | Acme">',
        '<h1>Acme</h1>',
        '<h2>Data Engineer</h2>',
      ),
    ).toBe('Data Engineer')
  })

  it('does not split the leading segment on a spaced hyphen, which job titles hold', () => {
    expect(
      leading(
        '<title>Data Engineer - Backend | Acme</title>',
        '<h1>Data Engineer - Backend</h1>',
        '<h2>Data Engineer</h2>',
      ),
    ).toBe('Data Engineer - Backend')
  })

  it('takes a named h1 above the pane over a named h2 in it when neither leads the tab title', () => {
    expect(
      leading(
        '<title>Data Engineer, Platform | Acme</title>',
        '<h1>Data Engineer</h1>',
        '<h2>Acme</h2>',
      ),
    ).toBe('Data Engineer')
  })

  it('keeps the spaces between words when matching the leading segment', () => {
    expect(
      title('<title>Rust Engineer | Acme</title>', '<h1>RustEngineer</h1><h2>Rust  Engineer</h2>'),
    ).toBe('Rust Engineer')
  })

  it('names nothing from a missing og:title', () => {
    expect(title('<title>Acme</title>', '<h1>Rust Engineer</h1><h1>Here</h1>')).toBe(
      'Rust Engineer',
    )
  })

  it('skips a leading segment that names the board', () => {
    expect(leading('<title>Jobs | Acme</title>', '<h2>Jobs</h2>', '<h2>Data Engineer</h2>')).toBe(
      'Data Engineer',
    )
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
  it('walks to the title from the pane, not from the body, on a two-pane board', () => {
    const doc = parse(`<body><h1>1,204 Go jobs</h1><ul><li>Other</li></ul>
      <div><h2>Senior Go Engineer</h2>${CUES}<p>${words(30)}</p></div></body>`)
    expect(extractVacancy(doc, 'https://jobs.example.com/1', '').title).toBe('Senior Go Engineer')
  })

  it('guesses the named h1 of a page recognized by its main text alone, with a fallback pane', () => {
    const doc = parse(`<head><title>Data Engineer | Acme</title></head><body><main>
      <h1>Data Engineer</h1><div id="text"><p>Requirements: SQL and Python. ${words(80)}</p></div>
    </main></body>`)
    const p = extractVacancy(doc, 'https://jobs.example.com/1', '')
    expect(findPane(doc, all)?.cue).toBe(false)
    expect(p.recognition).toBe('partial')
    expect(p.title).toBe('Data Engineer')
    expect(p.status.title).toBe('guessed')
    expect(p.description).toContain('Requirements: SQL and Python.')
    expect(p.status.description).toBe('guessed')
  })

  it('recognizes a page whose only vacancy signal is a cue pane outside main or article', () => {
    const doc = parse(`<body><div>${CUES}<p>${words(30)}</p></div></body>`)
    expect(extractVacancy(doc, 'https://jobs.example.com/1', '').recognition).toBe('partial')
  })
})

describe('guessTitle leading rung, round 5', () => {
  const leading = (head: string, above: string, inPane: string): string => {
    const doc = parse(`<head>${head}</head><body>${above}<div id="pane">${inPane}</div></body>`)
    return guessTitle(doc, doc.getElementById('pane'), all)
  }

  it('takes a heading that opens the leading segment over a brand h1', () => {
    expect(
      leading(
        '<title>Senior Java Engineer в Acme – Board</title>',
        '<h1>Acme</h1>',
        '<h2>Senior Java Engineer</h2>',
      ),
    ).toBe('Senior Java Engineer')
  })

  it('takes a heading equal to the leading segment over a nearer prefix of it', () => {
    expect(
      leading(
        '<title>Senior Java Engineer – Acme</title>',
        '<h2>Senior Java Engineer</h2>',
        '<h2>Senior Java</h2>',
      ),
    ).toBe('Senior Java Engineer')
  })

  it('takes a prefix of exactly half the segment, not one under half', () => {
    expect(
      leading('<title>Rust Dev at Acme | Board</title>', '<h1>Acme</h1>', '<h2>Rust Dev</h2>'),
    ).toBe('Rust Dev')
    expect(
      leading('<title>Rust Dev at Acmes | Board</title>', '<h1>Acme</h1>', '<h2>Rust Dev</h2>'),
    ).toBe('Acme')
  })

  it('takes a prefix only at a word boundary', () => {
    expect(
      leading('<title>Rust Dev at X Co | Board</title>', '<h1>X Co</h1>', '<h2>Rust Dev</h2>'),
    ).toBe('Rust Dev')
    expect(
      leading(
        '<title>Rust Developer at Acme | Board</title>',
        '<h1>Acme</h1>',
        '<h2>Rust Dev</h2>',
      ),
    ).toBe('Acme')
  })

  it('takes a prefix from og:title', () => {
    expect(
      leading(
        '<title>Acme careers</title><meta property="og:title" content="Senior Java Engineer в Acme">',
        '<h1>Acme</h1>',
        '<h2>Senior Java Engineer</h2>',
      ),
    ).toBe('Senior Java Engineer')
  })

  it.each(['Required skills', 'Необхідні навички', 'Необходимые навыки', 'Требуемые навыки'])(
    'never takes the section "%s" as the title',
    (section) => {
      expect(
        leading(
          `<title>${section} | Acme</title>`,
          '',
          `<h1>${section}</h1><h2>Rust Engineer</h2>`,
        ),
      ).toBe('Rust Engineer')
    },
  )
})

describe('a page header h1 on the leading rung', () => {
  const titled = (tab: string, header: string): string | undefined =>
    extractVacancy(
      parse(
        `<head><title>${tab}</title></head><body><header>${header}</header><main><div><h2>Platform</h2>${CUES}</div></main></body>`,
      ),
      'https://jobs.example.com/1',
      '',
    ).title

  it('takes a header h1 that leads the tab title', () => {
    expect(titled('Data Engineer | Acme', '<h1>Data Engineer</h1>')).toBe('Data Engineer')
  })

  it.each(['CAREERS AT ACME', 'Career at Acme', 'Join our careers at Acme'])(
    'skips a header h1 that names the careers site ("%s"), even when og:title leads with it',
    (site) => {
      const doc = parse(
        `<head><title>Search for Jobs</title><meta property="og:title" content="${site}"></head><body><header><h1>${site}</h1></header><main><div><h2>Senior SRE Engineer</h2>${CUES}</div></main></body>`,
      )
      expect(extractVacancy(doc, 'https://jobs.example.com/1', '').title).toBe(
        'Senior SRE Engineer',
      )
    },
  )

  it('skips a hidden heading on the leading rung', () => {
    const doc = parse(
      '<head><title>Data Engineer | Acme</title></head><body><h2 data-hidden>Data Engineer</h2><div id="pane"><h2>Platform</h2></div></body>',
    )
    expect(guessTitle(doc, doc.getElementById('pane'), notHidden)).toBe('Platform')
  })

  it('still skips a header h1 that only appears later in the tab title', () => {
    expect(titled('Data Engineer | Acme', '<h1>Acme</h1>')).toBe('Platform')
  })
})
