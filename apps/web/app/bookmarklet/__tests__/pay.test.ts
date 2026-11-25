import { describe, expect, it } from 'vitest'

import { extractVacancy } from '../extract'
import { DESCRIPTION_MAX } from '../limits'
import { findPane } from '../pane'
import { type Visible } from '../text'

// Synthetic fixtures only: trimmed, invented markup in the shapes the bench pages showed.

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')
const all: Visible = () => true
const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
const HREF = 'https://jobs.example.com/1'
const PANE = `<h3>Responsibilities</h3><p>Ship it</p><h3>Requirements</h3><p>${words(120)}</p>`

/** A JSON-LD page with no pane: the description is the JSON-LD text alone. */
const ldPage = (job: Record<string, unknown>, body = ''): Document =>
  parse(
    `<head><title>Rust Engineer | Acme</title><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Rust Engineer',
      hiringOrganization: { name: 'Acme' },
      description: '<p>Build the engine.</p>',
      ...job,
    })}</script></head><body>${body}</body>`,
  )
const described = (job: Record<string, unknown>): string | undefined =>
  extractVacancy(ldPage(job), HREF, '').description

describe('the salary line from JSON-LD', () => {
  it.each([
    ['a number value', { currency: 'USD', value: 5000 }, '5000 USD'],
    [
      'a QuantitativeValue amount',
      {
        currency: 'EUR',
        value: { '@type': 'QuantitativeValue', value: '4500', unitText: 'MONTH' },
      },
      '4500 EUR / month',
    ],
    [
      'a QuantitativeValue range',
      { currency: 'USD', value: { minValue: 100000, maxValue: '140000.0', unitText: 'YEAR' } },
      '100000–140000 USD / year',
    ],
    [
      'a decimal range',
      { currency: 'USD', value: { minValue: '45.5', maxValue: 60, unitText: 'HOUR' } },
      '45.5–60 USD / hour',
    ],
    ['a minimum only', { currency: 'PLN', value: { minValue: 9000 } }, '9000 PLN'],
    ['a maximum only', { currency: 'PLN', value: { maxValue: 12000 } }, '12000 PLN'],
    ['an equal range', { currency: 'USD', value: { minValue: 5000, maxValue: 5000 } }, '5000 USD'],
    ['no currency', { value: { value: 5000, unitText: 'week' } }, '5000 / week'],
    [
      'a unit outside hour, day, week, month and year',
      { currency: 'USD', value: { value: 5000, unitText: 'P1M' } },
      '5000 USD',
    ],
    ['the day unit', { currency: 'USD', value: { value: 300, unitText: 'DAY' } }, '300 USD / day'],
    ['a unit word inside a longer one', { value: { value: 300, unitText: 'HOURLY' } }, '300'],
    ['a unit word after another', { value: { value: 300, unitText: 'PER MONTH' } }, '300'],
    ['a zero minimum', { currency: 'USD', value: { minValue: 0, maxValue: 5000 } }, '5000 USD'],
  ])('appends %s after a blank line', (_, baseSalary, line) => {
    expect(described({ baseSalary })).toBe(`Build the engine.\n\n${line}`)
  })

  it('reads estimatedSalary when there is no baseSalary', () => {
    expect(described({ estimatedSalary: { currency: 'USD', value: 7000 } })).toBe(
      'Build the engine.\n\n7000 USD',
    )
  })

  it.each([
    ['a currency and no amount', { currency: 'USD' }],
    ['a zero amount', { currency: 'USD', value: 0 }],
    ['an empty amount', { currency: 'USD', value: '' }],
    ['a blank amount', { currency: 'USD', value: '  ' }],
    ['an amount that is not a number', { currency: 'USD', value: 'competitive' }],
    ['a negative amount', { currency: 'USD', value: -5 }],
    ['a minimum over the maximum', { currency: 'USD', value: { minValue: 9000, maxValue: 5000 } }],
    ['a salary given as text', '$100k'],
    ['no salary at all', undefined],
  ])('adds nothing for %s', (_, baseSalary) => {
    expect(described({ baseSalary })).toBe('Build the engine.')
  })

  it.each(['Pay: 100 000 USD', 'Pay: 100,000 USD', 'Pay: 100.000 USD', 'Pay: 100 000 USD'])(
    'adds nothing when the description already shows the amount (%s)',
    (shown) => {
      const baseSalary = { currency: 'USD', value: { minValue: 100000, maxValue: 140000 } }
      expect(described({ baseSalary, description: `<p>${shown}</p>` })).toBe(
        shown.replace('\u00a0', ' '),
      )
    },
  )

  it('reads a decimal first amount as shown however its digits are written', () => {
    const baseSalary = { currency: 'USD', value: { minValue: '45.5', maxValue: 60 } }
    expect(described({ baseSalary, description: '<p>Pay: 45.50 USD an hour</p>' })).toBe(
      'Pay: 45.50 USD an hour',
    )
  })

  it('keeps the description found and reads a @graph page', () => {
    const doc = parse(
      `<head><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'Organization', name: 'Acme' },
          {
            '@type': 'JobPosting',
            title: 'Rust Engineer',
            hiringOrganization: { name: 'Acme' },
            description: 'Build the engine.',
            baseSalary: { currency: 'USD', value: 5000 },
          },
        ],
      })}</script></head><body></body>`,
    )
    const out = extractVacancy(doc, HREF, '')
    expect(out.description).toBe('Build the engine.\n\n5000 USD')
    expect(out.status.description).toBe('found')
    expect(out.recognition).toBe('recognized')
  })

  it('still caps the description', () => {
    const description = 'x'.repeat(DESCRIPTION_MAX)
    const out = described({ description, baseSalary: { currency: 'USD', value: 5000 } })
    expect(out).toHaveLength(DESCRIPTION_MAX)
  })

  it('leaves a selection as the HR picked it', () => {
    const selection = `Selected text ${words(40)}`
    const doc = ldPage({ baseSalary: { currency: 'USD', value: 5000 } })
    expect(extractVacancy(doc, HREF, selection).description).toBe(selection)
  })
})

/** The pane with one wrapper per entry; entry i follows the wrapper i + 1 levels above the pane. */
const nested = (after: string[]): string => {
  let html = `<div id="pane">${PANE}</div>`
  for (const block of after) html = `<div>${html}</div>${block}`
  return html
}
const far = (after: string[], visible: Visible = all): string[] | undefined =>
  findPane(parse(`<body>${nested(after)}</body>`), visible)?.more

describe('pay and benefit blocks after the pane ancestors', () => {
  it('takes a pay block two levels up', () => {
    expect(far(['', '<div><h3>Salary</h3><p>Competitive</p></div>'])).toEqual([
      'Salary\n\nCompetitive',
    ])
  })

  it('takes a pay block three levels up, but not four', () => {
    const pay = '<div><h3>Salary</h3><p>Competitive</p></div>'
    expect(far(['', '', pay])).toEqual(['Salary\n\nCompetitive'])
    expect(far(['', '', '', pay])).toEqual([])
  })

  it('reads three siblings per level, not a fourth', () => {
    expect(far(['<p>a</p><p>b</p><p>Salary: competitive</p>'])).toEqual(['Salary: competitive'])
    expect(far(['<p>a</p><p>b</p><p>c</p><p>Salary: competitive</p>'])).toEqual([])
  })

  it.each([
    'Salary',
    'Compensation',
    'Pay range',
    'Base pay',
    'Benefits',
    'Perks',
    'What we offer',
    'Зарплата',
    'Заробітна плата',
    'Wynagrodzenie',
    'Ми пропонуємо',
    'Мы предлагаем',
  ])('takes a block whose first line is the heading "%s"', (heading) => {
    expect(far([`<div><h3>${heading}</h3><p>Good terms</p></div>`])).toEqual([
      `${heading}\n\nGood terms`,
    ])
  })

  it.each([
    '$5000',
    '$ 5000',
    '€5000',
    '£5000',
    '5000 usd',
    '5000EUR',
    '5000 uah',
    '5000 pln',
    '5000 грн',
    '5000 czk',
    '5000 chf',
    '5000 gbp',
  ])('takes a block holding the amount "%s"', (amount) => {
    expect(far([`<p>From ${amount} gross</p>`])).toEqual([`From ${amount} gross`])
  })

  it.each([
    [
      'a promo whose first line is no heading',
      '<div><p>Unlock all 40 benefits! Browse jobs.</p></div>',
    ],
    ['an apply prompt', '<div><h3>Apply quicker</h3><p>Complete your profile</p></div>'],
    ['a heading word inside a longer word', '<div><h3>Payment terms</h3><p>Net 30</p></div>'],
    ['a number with no currency', '<p>Join 5000 engineers</p>'],
  ])('skips %s', (_, block) => {
    expect(far([block])).toEqual([])
  })

  it('keeps a block of exactly 3000 characters and skips a longer one', () => {
    const block = (n: number): string => `<p>Salary ${'x'.repeat(n - 7)}</p>`
    expect(far([block(3000)])?.[0]).toHaveLength(3000)
    expect(far([block(3001)])).toEqual([])
  })

  it('skips a block that is mostly links', () => {
    expect(far([`<div><h3>Salary</h3><a href="/x">${'x'.repeat(40)}</a></div>`])).toEqual([])
  })

  it.each(['nav', 'footer', 'aside', 'header'])('skips a pay block that is a <%s>', (tag) => {
    expect(far([`<${tag}><h3>Salary</h3><p>5000 USD</p></${tag}>`])).toEqual([])
  })

  it('skips a hidden pay block', () => {
    const shown: Visible = (el) => !el.hasAttribute('data-hidden')
    expect(far(['<div data-hidden><h3>Salary</h3><p>5000 USD</p></div>'], shown)).toEqual([])
  })

  it('keeps the direct-sibling rule for the pane itself', () => {
    const doc = parse(`<body><div id="pane">${PANE}</div><p>Unlock all 40 benefits</p></body>`)
    expect(findPane(doc, all)?.text).toMatch(/Unlock all 40 benefits$/)
  })

  it('skips an editorial city block holding a billion amount and a block with a raised million amount', () => {
    const city =
      '<div><p>Top Skills: React, Node. What you need to know about the San Francisco Tech Scene. Funding Landscape: $50.5 billion in venture capital funding.</p></div>'
    expect(far([city])).toEqual([])
    expect(far(['<p>The company raised $40 million in series B</p>'])).toEqual([])
  })

  it('skips a related-jobs block with linked postings and pay ranges', () => {
    const similar = `<div>
      <h3>Similar Jobs at Acme</h3>
      <p><a href="/job/1">Senior Account Executive</a> — $120,000 - $150,000</p>
      <p><a href="/job/2">Account Executive</a> — $100,000 - $120,000</p>
      <p><a href="/job/3">Junior Account Executive</a> — $80,000 - $100,000</p>
    </div>`
    expect(far([similar])).toEqual([])
  })

  it('skips a heading-less list of two pay ranges without links', () => {
    const list = '<div><p>$120,000 - $150,000 per year</p><p>$100,000 - $120,000 per year</p></div>'
    expect(far([list])).toEqual([])
  })

  it('skips a heading-less block holding more than one pay-shaped amount', () => {
    expect(far(['<div><p>Role A: $120k base</p><p>Role B: $150k OTE</p></div>'])).toEqual([])
    expect(
      far(['<div><p>$120,000 - $150,000 per year</p><p>Bonus: $20,000 annually</p></div>']),
    ).toEqual([])
    expect(
      far(['<div><p>Bonus: $20,000 annually</p><p>$120,000 - $150,000 per year</p></div>']),
    ).toEqual([])
  })

  it.each([
    'Similar Jobs at Acme',
    'Related Jobs',
    'More jobs from this company',
    'Other jobs at Acme',
    'Recommended Jobs',
    'Jobs you may like',
    'You may also like',
    'People also viewed',
    'Offres similaires',
    'Vergelijkbare vacatures',
    'Weitere Jobs',
    'Andere Stellenangebote',
    'Ähnliche Stellen',
    'Ähnliche Stellenangebote',
    'Схожі вакансії',
    'Інші вакансії компанії',
    'Похожие вакансии',
    'Другие вакансии компании',
    'Ähnliche Jobs',
    'Podobne oferty pracy',
  ])('skips related listings opening with "%s"', (heading) => {
    const block = `<div><h3>${heading}</h3><p>$120,000 - $150,000 per year</p></div>`
    expect(far([block])).toEqual([])
  })

  it('skips related listings with lead text before the heading', () => {
    const block =
      '<div><p>Explore more</p><h3>Similar Jobs</h3><p><a href="/job/1">Dev</a>: $120,000 - $150,000 per year</p></div>'
    expect(far([block])).toEqual([])
  })

  it('keeps a pay block that says "more job" in its text', () => {
    const pay =
      '<div><p>Salary: $120,000 - $150,000 per year. More job flexibility than most.</p></div>'
    expect(far(['', pay])).toEqual([
      'Salary: $120,000 - $150,000 per year. More job flexibility than most.',
    ])
  })

  it('keeps a pay block whose related-jobs words sit past its first 120 characters', () => {
    const lead =
      'We offer a friendly team, remote work, flexible hours and a learning budget for everyone who joins us this year'
    const text = `${lead}. Salary: $5,000 per month. Similar jobs often pay less.`
    expect(far(['', `<div><p>${text}</p></div>`])).toEqual([text])
  })

  it('reads a range with a leading hryvnia or rouble sign', () => {
    expect(far(['', '<div><p>Зарплата ₴50000 – ₴70000</p></div>'])).toEqual([
      'Зарплата ₴50000 – ₴70000',
    ])
    expect(far(['', '<div><p>Зарплата ₽150000 – ₽200000</p></div>'])).toEqual([
      'Зарплата ₽150000 – ₽200000',
    ])
  })

  it('skips German and French related job headings', () => {
    expect(
      far(['<div><h3>Ähnliche Stellenangebote</h3><p>$120,000 - $150,000 per year</p></div>']),
    ).toEqual([])
    expect(
      far(['<div><h3>Offres similaires</h3><p>$120,000 - $150,000 per year</p></div>']),
    ).toEqual([])
  })

  it('takes a heading-less range with pay unit and a heading-less salary amount', () => {
    expect(far(['<p>$120,000 – $150,000 per year</p>'])).toEqual(['$120,000 – $150,000 per year'])
    expect(far(['<p>Salary: 6000 USD</p>'])).toEqual(['Salary: 6000 USD'])
  })

  it.each([
    ['$120,000 - $150,000', '$120,000 - $150,000'],
    ['120k–150k USD', '120k–150k USD'],
    ['5000 to 7000 EUR', '5000 to 7000 EUR'],
    ['5000 до 7000 грн', '5000 до 7000 грн'],
    ['15000 до 20000 zł', '15000 до 20000 zł'],
    ['50000 - 70000 ₴', '50000 - 70000 ₴'],
    ['100000 - 150000 ₽', '100000 - 150000 ₽'],
    ['100000 до 150000 руб', '100000 до 150000 руб'],
  ])('takes the heading-less range "%s"', (range, expected) => {
    expect(far([`<p>${range}</p>`])).toEqual([expected])
  })

  it.each([
    ['10 - 20'],
    ['$10 - $20 million'],
    ['Budget was $10 - $20 million for the year'],
    ['Series B: $10 - $20 million raised, we pay well'],
    ['$10 - $20 billion'],
    ['$40 miljoen salary fund'],
    ['$40 miljard salary fund'],
    ['40 млн грн інвестицій'],
    ['40 млрд USD'],
    ['The company raised $40 million for base salary'],
    ['Total was $40 million salary'],
    ['25 European offices, base salary competitive'],
    ['base ' + '-'.repeat(40) + '$5000'],
    ['$5000' + '-'.repeat(41) + '/yr'],
    ['Note: salary ' + 'x'.repeat(45) + ' $5000'],
  ])('skips amounts not pay-shaped (%s)', (text) => {
    expect(far([`<p>${text}</p>`])).toEqual([])
  })

  it.each([
    ['base$5000'],
    ['base ' + '-'.repeat(39) + '$5000'],
    ['$5000/yr'],
    ['$5000' + '-'.repeat(40) + '/yr'],
    ['Note: salary ' + 'x'.repeat(30) + ' $5000'],
    ['$120k base'],
    ['150k USD OTE'],
    ['wynagrodzenie: 5000 PLN'],
    ['Gehalt: 5000 EUR'],
    ['salaire: 5000 EUR'],
    ['оплата: 5000 грн'],
    ['Wynagrodzenie 15000 zł brutto'],
    ['Оплата 50000 ₴'],
    ['Зарплата 150000 ₽'],
    ['Зарплата 150000 руб'],
    ['Long prefix string exceeding forty characters for testing index: salary $5000'],
    ['Long prefix string exceeding forty characters for testing index: $5000 salary'],
  ])('takes a pay-shaped amount near pay words (%s)', (text) => {
    expect(far([`<p>${text}</p>`])).toEqual([text])
  })
})

describe('the far blocks in the description', () => {
  const LONG = `<p>${words(200)}</p>`
  const pay = '<div><h3>Salary</h3><p>5000 USD</p></div>'

  it('appends a far pay block to a JSON-LD description', () => {
    const doc = ldPage({ description: LONG }, nested(['', pay]))
    const out = extractVacancy(doc, HREF, '')
    expect(out.description).toBe(`${words(200)}\n\nSalary\n\n5000 USD`)
    expect(out.status.description).toBe('found')
  })

  it('appends a far pay block to a pane description', () => {
    const doc = parse(`<body>${nested([pay])}</body>`)
    expect(extractVacancy(doc, HREF, '').description).toMatch(/\n\nSalary\n\n5000 USD$/)
  })

  it('does not append a block the description already holds', () => {
    const doc = ldPage({ description: `${LONG}<p>Salary</p><p>5000 USD</p>` }, nested([pay]))
    const out = extractVacancy(doc, HREF, '').description
    expect(out).toMatch(/Salary\s+5000 USD$/)
    expect(out?.split('5000 USD')).toHaveLength(2)
  })

  it('appends the salary line after the far blocks, unless they show the amount', () => {
    const job = { description: LONG, baseSalary: { currency: 'USD', value: 5000 } }
    const shown = extractVacancy(ldPage(job, nested([pay])), HREF, '').description
    expect(shown).toBe(`${words(200)}\n\nSalary\n\n5000 USD`)
    const other = '<div><h3>Benefits</h3><p>Gym</p></div>'
    const added = extractVacancy(ldPage(job, nested([other])), HREF, '').description
    expect(added).toBe(`${words(200)}\n\nBenefits\n\nGym\n\n5000 USD`)
  })

  it('appends nothing to a selection', () => {
    const selection = `Selected text ${words(40)}`
    const doc = parse(`<body>${nested([pay])}</body>`)
    expect(extractVacancy(doc, HREF, selection).description).toBe(selection)
  })
})
