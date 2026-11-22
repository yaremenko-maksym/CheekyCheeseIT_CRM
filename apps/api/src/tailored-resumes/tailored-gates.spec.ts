import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import type { ContactContext } from '../resumes/verification/contact-scan'
import {
  payloadStatements,
  RunFailure,
  type WritingPayload,
} from '../resumes/verification/content-gates'
import type { EntailmentClaim, EntailmentScores } from '../resumes/verification/inference-clients'
import type { TailoredDraft } from './tailored-draft'
import { gateDraft, LATIN, LOOKALIKE, type GateDeps } from './tailored-gates'
import { assemblePrepared } from './tailored-prepare'
import { TailoredRunFailure } from './tailored-run'

const contacts: ContactContext[] = [
  { fullName: 'Jane Doe', emails: ['jane@example.com'], telegram: null },
]
const content: ResumeContent = {
  ...EMPTY_RESUME_CONTENT,
  summary: 'Backend engineer who builds APIs.',
  skills: ['Postgres', 'TypeScript'],
  experience: [
    {
      company: 'Acme',
      role: 'Dev',
      period: '2020 - 2022',
      bullets: ['Used React for dashboards', '  ', 'Ran 40 deploys a week'],
    },
  ],
}
const prepared = assemblePrepared({
  base: {
    id: 'r1',
    version: 1,
    content,
    templateName: 'classic',
    layout: DEFAULT_RESUME_LAYOUT,
    pdfPages: 1,
  },
  owner: { displayName: 'Jane Doe', email: 'jane@example.com', contacts },
  opportunity: {
    title: 'Senior Engineer',
    employerName: 'Globex',
    descriptionMd: 'We use React, Kubernetes and Kafka.',
    tags: [],
  },
  now: new Date('2026-11-22T00:00:00Z'),
})

const UNIT = ['I', 'build', 'APIs', 'with', 'TypeScript', 'at', 'Acme']
/** One grounded sentence of `words` words. */
const coverOf = (words: number): string =>
  `${Array.from({ length: words }, (_, i) => UNIT[i % UNIT.length]).join(' ')}.`

const draft = (over: Partial<TailoredDraft> = {}): TailoredDraft => ({
  summary: 'Backend engineer who builds APIs.',
  skills: ['PostgreSQL', 'TypeScript'],
  items: [
    {
      bullets: [
        { text: 'Used React for dashboards', sourceIndices: [0] },
        { text: 'Ran 40 deploys a week', sourceIndices: [1] },
      ],
    },
  ],
  coverBody: coverOf(105),
  ...over,
})

/** Entailment that supports a claim when `supports(claim)`; every request recorded. */
function deps(supports: (c: EntailmentClaim) => boolean = () => true) {
  const requests: EntailmentClaim[][] = []
  const score = vi.fn(async (claims: EntailmentClaim[]): Promise<EntailmentScores> => {
    requests.push(claims)
    return new Map(claims.map((c) => [c.id, supports(c) ? 1 : 0]))
  })
  const d: GateDeps = { entailment: { score }, beforeModelCall: vi.fn(async () => undefined) }
  return { d, requests, score }
}

describe('gateDraft', () => {
  it('a faithful draft passes every gate', async () => {
    const { d } = deps()
    const r = await gateDraft(draft(), prepared, d)
    expect(r.failing).toEqual([])
    expect(r.gate).toEqual({ gate: 'content', ok: true, items: [] })
  })

  it('a faithful rewrite of the base summary passes the summary entailment gate', async () => {
    // The base summary is the payload headline, so it is among the summary's sources.
    const { d, requests } = deps(
      (c) =>
        c.text !== 'An engineer who builds APIs.' ||
        c.sources.includes('Backend engineer who builds APIs.'),
    )
    const r = await gateDraft(draft({ summary: 'An engineer who builds APIs.' }), prepared, d)
    expect(r.failing).toEqual([])
    const claim = requests.flat().find((c) => c.text === 'An engineer who builds APIs.')
    // The summary is checked against the payload only: no application premise.
    expect(claim?.sources.some((s) => s.includes('applying'))).toBe(false)
  })

  it('a bullet is judged against the base bullets of its sourceIndices only (blank bullets skipped)', async () => {
    const { d, requests } = deps()
    await gateDraft(draft(), prepared, d)
    const claims = requests.flat()
    expect(claims.find((c) => c.text === 'Ran 40 deploys a week')?.sources).toEqual([
      'Ran 40 deploys a week',
    ])
    expect(claims.find((c) => c.text === 'Used React for dashboards')?.sources).toEqual([
      'Used React for dashboards',
    ])
  })

  it('"used" reworded to "led" that Jev does not support fails that bullet only', async () => {
    const { d } = deps((c) => !c.text.startsWith('Led'))
    const bullets = [
      { text: 'Led React dashboards', sourceIndices: [0] },
      { text: 'Ran 40 deploys a week', sourceIndices: [1] },
    ]
    const r = await gateDraft(draft({ items: [{ bullets }] }), prepared, d)
    expect(r.failing).toEqual([
      {
        path: 'experience.0.bullets.0',
        reason: 'NOT_SUPPORTED',
        detail: 'FACTS do not support it',
      },
    ])
    expect(r.gate).toEqual({
      gate: 'content',
      ok: false,
      items: [{ path: 'experience.0.bullets.0', reason: 'NOT_SUPPORTED' }],
    })
  })

  it.each([
    ['summary', (t: string) => draft({ summary: `Backend engineer. ${t}` }), 'summary.1'],
    [
      'a bullet',
      (t: string) => draft({ items: [{ bullets: [{ text: t, sourceIndices: [0] }] }] }),
      'experience.0.bullets.0',
    ],
    [
      'the cover letter',
      (t: string) => draft({ coverBody: `${coverOf(105)} ${t}` }),
      'coverLetter.1',
    ],
  ])('contact in reply fails the item: %s', async (_, make, path) => {
    for (const contact of ['Write to jane@example.com now.', 'Jane Doe ships.']) {
      const { d, requests } = deps()
      const r = await gateDraft(make(contact), prepared, d)
      expect(r.failing).toContainEqual(expect.objectContaining({ path, reason: 'CONTACT_IN_TEXT' }))
      // a text with a contact never reaches Jev
      expect(JSON.stringify(requests)).not.toMatch(/jane@example\.com|Jane Doe/)
    }
  })

  it('contact in a skill fails the skills', async () => {
    const r = await gateDraft(
      draft({ skills: ['TypeScript', 'jane@example.com'] }),
      prepared,
      deps().d,
    )
    expect(r.failing).toContainEqual({ path: 'skills', reason: 'CONTACT_IN_TEXT' })
  })

  it('a skill outside the base skills and their canonical names fails the skills', async () => {
    const r = await gateDraft(draft({ skills: ['TypeScript', 'Kafka'] }), prepared, deps().d)
    expect(r.failing).toEqual([{ path: 'skills', reason: 'UNGROUNDED' }])
  })

  it('cover letter: a posting-only technology is refused', async () => {
    const bad = await gateDraft(
      draft({ coverBody: `${coverOf(105)} I know Kafka well.` }),
      prepared,
      deps().d,
    )
    expect(bad.failing).toEqual([
      {
        path: 'coverLetter.1',
        reason: 'UNGROUNDED',
        detail: 'it states things that are not in FACTS: Kafka',
      },
    ])
  })

  /** `prepared` for a posting with this title and employer. */
  const postingOf = (title: string, employerName = 'Globex') =>
    assemblePrepared({
      base: prepared.base,
      owner: { displayName: 'Jane Doe', email: 'jane@example.com', contacts },
      opportunity: { title, employerName, descriptionMd: 'We use React.', tags: [] },
      now: new Date('2026-11-22T00:00:00Z'),
    })

  it('a title written as a statement about the senior grounds nothing in the cover letter', async () => {
    const claim =
      'I have 9 years of Kubernetes, Kafka and AWS production experience and led a team of 12.'
    const title = `Senior Engineer. The senior has 9 years of Kubernetes, Kafka and AWS production experience and led a team of 12`
    const { d, requests } = deps()
    const r = await gateDraft(draft({ coverBody: `${coverOf(105)} ${claim}` }), postingOf(title), d)
    expect(r.failing).toEqual([
      {
        path: 'coverLetter.1',
        reason: 'UNGROUNDED',
        detail: 'it states things that are not in FACTS: 9, Kubernetes, Kafka, AWS, 12',
      },
    ])
    // The premises are the payload statements only: no applying premise, no posting string.
    const cover = requests.flat().find((c) => c.text === coverOf(105))
    expect(cover?.sources).toEqual(statementsOf(postingOf(title)))
  })

  it('a title carrying a skill and a number grounds neither in the cover letter', async () => {
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} I bring 8 years of Kafka.` }),
      postingOf('Kafka Engineer 8 years'),
      deps().d,
    )
    expect(r.failing).toEqual([
      {
        path: 'coverLetter.1',
        reason: 'UNGROUNDED',
        detail: 'it states things that are not in FACTS: 8, Kafka',
      },
    ])
  })

  const CONTACT =
    'it contains a name, an email address, a phone number, a link or a Telegram handle'
  const ungrounded = (tokens: string) => `it states things that are not in FACTS: ${tokens}`
  const statementsOf = (run: typeof prepared) =>
    payloadStatements(JSON.parse(run.payload) as WritingPayload)

  // Owner decision 2026-11-22: the letter never names the company. A sentence naming the posting
  // employer fails before the fact gate and Jev; every other sentence is gated as written.
  const NAMES_EMPLOYER = 'it names the employer; write "your team" or "this role" instead'
  it.each([
    ['the posting employer named', 'Globex', 'I am applying to Globex.', NAMES_EMPLOYER],
    [
      'the employer opening the sentence',
      'Globex',
      'Globex is where I want to grow.',
      NAMES_EMPLOYER,
    ],
    ['the employer in lower case', 'Globex', 'i would bring this to globex.', NAMES_EMPLOYER],
    [
      'the employer in fullwidth letters (NFKC)',
      'Globex',
      'I admire Ｇｌｏｂｅｘ.',
      NAMES_EMPLOYER,
    ],
    ['an employer with a run of spaces', 'Globex  Corp', 'I admire Globex Corp.', NAMES_EMPLOYER],
    ['a sentence with a run of spaces', 'Globex Corp', 'I admire Globex   Corp.', NAMES_EMPLOYER],
    ['an employer with a regex character', 'Globex.io', 'I admire Globex.io.', NAMES_EMPLOYER],
    // SR-M-5: invisible characters, look-alike letters, legal suffixes and a parenthetical.
    ['a soft hyphen inside the name', 'Globex', 'I admire Glo\u00ADbex.', NAMES_EMPLOYER],
    ['a word joiner inside the name', 'Globex', 'I admire Glo\u2060bex.', NAMES_EMPLOYER],
    ['a Cyrillic o inside the name', 'Globex', 'I admire Gl\u043Ebex.', NAMES_EMPLOYER],
    ['a Cyrillic o inside the employer', 'Gl\u043Ebex', 'I admire Globex.', NAMES_EMPLOYER],
    // SR-M-6: either folding matches, so case and shape both hold.
    ['an upper-case Cyrillic employer', 'ЛУКОЙЛ', 'I admire Лукойл.', NAMES_EMPLOYER],
    ['a lower-case Cyrillic employer', 'Лукойл', 'I admire ЛУКОЙЛ.', NAMES_EMPLOYER],
    ['an upper-case Greek employer', 'ΝΙΚΗ', 'I admire νικη.', NAMES_EMPLOYER],
    ['an upper-case Greek employer with upsilon', 'ΥΠΑΤΙΑ', 'I admire υπατια.', NAMES_EMPLOYER],
    ['a Greek look-alike employer', 'ΝΙΚΕ', 'I admire Nike.', NAMES_EMPLOYER],
    ['a Greek eta for n in the sentence', 'Amazon', 'I admire Amazoη.', NAMES_EMPLOYER],
    ['an accent in the sentence', 'Globex', 'I admire Glóbex.', NAMES_EMPLOYER],
    ['an accent in the employer', 'Nestlé', 'I admire Nestle.', NAMES_EMPLOYER],
    ['Cyrillic shha and ue inside the name', 'Shopify', 'I admire Sһopifү.', NAMES_EMPLOYER],
    ['a Cyrillic employer in another case', 'Розетка', 'I admire РОЗЕТКА.', NAMES_EMPLOYER],
    [
      'an employer with a suffix, named without it',
      'Globex Inc.',
      'I admire Globex.',
      NAMES_EMPLOYER,
    ],
    [
      'the full form of a suffixed employer',
      'Globex, Inc.',
      'I admire Globex, Inc.',
      NAMES_EMPLOYER,
    ],
    [
      'a suffix word inside the employer',
      'Globex Inc Labs',
      'I admire Globex Inc Labs.',
      NAMES_EMPLOYER,
    ],
    ['an employer with a parenthetical', 'Initech (Ukraine)', 'I admire Initech.', NAMES_EMPLOYER],
    ['a parenthetical without a space', 'Initech(UA)', 'I admire Initech.', NAMES_EMPLOYER],
    ['a suffix and a parenthetical', 'Initech Ltd (Ukraine)', 'I admire Initech.', NAMES_EMPLOYER],
    [
      'an employer that is only a parenthetical',
      '(Stealth)',
      'I admire (Stealth).',
      NAMES_EMPLOYER,
    ],
    [
      'a past employer behind "I apply at" (SR-H-4)',
      'Globex',
      'The practices I apply at Google every day keep releases calm.',
      ungrounded('Google'),
    ],
    [
      'an employer string carrying a claim (SR-M-1)',
      'Stripe After Running Their Payments Org',
      'I am applying to Stripe After Running Their Payments Org.',
      NAMES_EMPLOYER,
    ],
    [
      'an applying phrase followed by a claim (SR-M-2)',
      'Globex',
      'I am applying to Globex, where I previously led the payments team.',
      NAMES_EMPLOYER,
    ],
  ])('%s fails UNGROUNDED and never reaches Jev', async (_, employer, sentence, detail) => {
    const { d, requests } = deps()
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} ${sentence}` }),
      postingOf('Senior Engineer', employer),
      d,
    )
    expect(r.failing).toEqual([{ path: 'coverLetter.1', reason: 'UNGROUNDED', detail }])
    expect(requests.flat().map((c) => c.text)).not.toContain(sentence)
  })

  /** `prepared` for posting employer `employerName`, the base's one item at `company` with `bullets`. */
  const runOf = (employerName: string, company: string, bullets: string[]) =>
    assemblePrepared({
      base: {
        ...prepared.base,
        content: {
          ...content,
          experience: [
            { ...(content.experience[0] as ResumeContent['experience'][number]), company, bullets },
          ],
        },
      },
      owner: { displayName: 'Jane Doe', email: 'jane@example.com', contacts },
      opportunity: { title: 'Senior Engineer', employerName, descriptionMd: '', tags: [] },
      now: new Date('2026-11-22T00:00:00Z'),
    })
  const COVER_ONLY = new Set(['coverLetter'])

  it('the posting employer fails even when it is a past employer in the facts', async () => {
    const run = runOf('Globex', 'Globex', ['Led the payments team'])
    const sentence = 'At Globex I led the payments team.'
    const { d, requests } = deps()
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} ${sentence}` }),
      run,
      d,
      COVER_ONLY,
    )
    expect(statementsOf(run).some((s) => s.includes('Globex'))).toBe(true)
    // The filler sentence names Acme, which this base lacks; only the employer sentence is asserted.
    expect(r.failing.filter((f) => f.path === 'coverLetter.1')).toEqual([
      { path: 'coverLetter.1', reason: 'UNGROUNDED', detail: NAMES_EMPLOYER },
    ])
    expect(requests.flat().map((c) => c.text)).not.toContain(sentence)
  })

  it.each([
    ['Meta', 'metadata'],
    ['Data', 'metadata'],
    // A regex character in the name is literal: "meta.io" is not "metaxio".
    ['Meta.io', 'metaxio'],
    // Words are not joined: "met a" is not "Meta".
    ['Meta', 'met a'],
    // A suffix inside the name, or a parenthetical before its end, is part of the name.
    ['Acme Inc Labs', 'Acme'],
    ['Globex (UA) Labs', 'Globex Labs'],
    // A suffix needs a space before it: "Zinc" is not "Z" plus "inc".
    ['Zinc', 'Z'],
    // Four passes at most: a fifth suffix stays.
    ['Globex Inc Inc Inc Inc Inc', 'Globex'],
  ])('employer %s does not match %s in a sentence', async (employer, word) => {
    const run = runOf(employer, 'Acme', [`Built ${word} pipelines`])
    const sentence = `I built ${word} pipelines.`
    const { d, requests } = deps()
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} ${sentence}` }),
      run,
      d,
      COVER_ONLY,
    )
    expect(r.failing).toEqual([])
    expect(requests.flat().map((c) => c.text)).toContain(sentence)
  })

  it.each([
    ', Inc.',
    ' Inc.',
    ' inc',
    ' LLC',
    ' Ltd',
    ' Ltd.',
    ' GmbH',
    ' B.V.',
    ' S.A.',
    ' plc',
    ' Corp',
    ' Corp.',
    // SR-M-7: the longer list, no space after the comma, and stacked suffixes and parentheticals.
    ',Inc.',
    ' Limited',
    ' LLP',
    ' Co.',
    ' AG',
    ' SE',
    ' KG',
    ' Pty',
    ' Sp. z o.o.',
    ' SRL',
    ' SARL',
    ' Oy',
    ' AB',
    ' NV',
    ' BV',
    ' SA',
    ' Pty Ltd',
    ' (UK) Ltd',
    ' Ltd (UK)',
    ' (Ukraine) Inc',
    ' GmbH & Co. KG',
  ])('employer "Globex%s" fails a sentence naming Globex', async (suffix) => {
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} I admire Globex.` }),
      postingOf('Senior Engineer', `Globex${suffix}`),
      deps().d,
      COVER_ONLY,
    )
    expect(r.failing).toEqual([
      { path: 'coverLetter.1', reason: 'UNGROUNDED', detail: NAMES_EMPLOYER },
    ])
  })

  // Each look-alike Cyrillic or Greek letter, in order, beside the Latin letter it reads as.
  it.each([
    ['aeopcyxijsdqwbkmht', 'аеорсухіјѕԁԛԝвкмнт'],
    ['ABEKMHOPCTXIJS', 'АВЕКМНОРСТХІЈЅ'],
    ['oaevptukbzniux', 'οαενρτυκβζηιμχ'],
    ['YDQWhHlyYea', 'УԀԚԜһҺӏүҮҽɑ'],
    ['ABEZHIKMNOPTYX', 'ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ'],
  ])('employer %s written in look-alike letters (%s) fails', async (employer, lookalike) => {
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} I admire ${lookalike}.` }),
      postingOf('Senior Engineer', employer),
      deps().d,
      COVER_ONLY,
    )
    expect(r.failing).toEqual([
      { path: 'coverLetter.1', reason: 'UNGROUNDED', detail: NAMES_EMPLOYER },
    ])
  })

  // SR-M-4: a name holding ". ", "! " or "? " is split across sentences; the cover fails as a whole.
  it.each(['Dr. Oetker', 'Yahoo! Japan', 'J. P. Morgan'])(
    'employer %s written in the cover fails the cover as a whole',
    async (employer) => {
      const { d, requests } = deps()
      const r = await gateDraft(
        draft({ coverBody: `${coverOf(105)} I admire ${employer} and its work.` }),
        postingOf('Senior Engineer', employer),
        d,
        COVER_ONLY,
      )
      expect(r.failing).toEqual([
        { path: 'coverLetter', reason: 'UNGROUNDED', detail: NAMES_EMPLOYER },
      ])
      expect(r.gate.ok).toBe(false)
      // The letter is regenerated whole: none of its sentences reaches the fact gate or Jev.
      expect(requests).toEqual([])
    },
  )

  it('an employer name with padding around it still matches a sentence opener', async () => {
    // `assemblePrepared` trims the employer; a padded one reaches the gate only from a hand-made run.
    const run = { ...prepared, posting: { ...prepared.posting, employerName: ' Globex ' } }
    const sentence = 'Globex is where I want to grow.'
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} ${sentence}` }),
      run,
      deps().d,
      COVER_ONLY,
    )
    expect(r.failing).toEqual([
      { path: 'coverLetter.1', reason: 'UNGROUNDED', detail: NAMES_EMPLOYER },
    ])
  })

  // `assemblePrepared` already strips invisible characters; these runs are built by hand.
  it('a zero-width space inside the employer is dropped by the gate', async () => {
    const run = { ...prepared, posting: { ...prepared.posting, employerName: 'Goo\u200Bgle' } }
    const sentence = 'I admire Google.'
    const { d, requests } = deps()
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} ${sentence}` }),
      run,
      d,
      COVER_ONLY,
    )
    expect(r.failing).toEqual([
      { path: 'coverLetter.1', reason: 'UNGROUNDED', detail: NAMES_EMPLOYER },
    ])
    expect(requests.flat().map((c) => c.text)).not.toContain(sentence)
  })

  it('an employer of invisible characters only names nothing', async () => {
    const run = { ...prepared, posting: { ...prepared.posting, employerName: '\u200B' } }
    const sentence = 'I like \u200B this team.'
    const { d, requests } = deps()
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} ${sentence}` }),
      run,
      d,
      COVER_ONLY,
    )
    expect(r.failing).toEqual([])
    expect(requests.flat().map((c) => c.text)).toContain(sentence)
  })

  it('the look-alike table pairs one UTF-16 unit with one ASCII letter, each letter once', () => {
    expect(LATIN).toHaveLength(LOOKALIKE.length)
    expect([...LOOKALIKE]).toHaveLength(LOOKALIKE.length)
    expect(new Set(LOOKALIKE).size).toBe(LOOKALIKE.length)
    expect(LATIN).toMatch(/^[A-Za-z]+$/u)
  })

  it.each(['', '   '])('an empty employer name (%j) skips the check', async (employer) => {
    const { d, requests } = deps()
    const r = await gateDraft(draft(), postingOf('Senior Engineer', employer), d, COVER_ONLY)
    expect(r.failing).toEqual([])
    expect(requests.flat().map((c) => c.text)).toContain(coverOf(105))
  })

  it('a contact in a cover sentence fails the contact gate', async () => {
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} I worked with Jane Doe.` }),
      prepared,
      deps().d,
    )
    expect(r.failing).toEqual([
      { path: 'coverLetter.1', reason: 'CONTACT_IN_TEXT', detail: CONTACT },
    ])
  })

  /** `prepared` whose base has the payments-team fact. */
  const withPayments = assemblePrepared({
    base: {
      ...prepared.base,
      content: {
        ...content,
        experience: [
          {
            ...(content.experience[0] as ResumeContent['experience'][number]),
            bullets: ['Led a payments team of eight engineers'],
          },
        ],
      },
    },
    owner: { displayName: 'Jane Doe', email: 'jane@example.com', contacts },
    opportunity: { title: 'Senior Engineer', employerName: 'Globex', descriptionMd: '', tags: [] },
    now: new Date('2026-11-22T00:00:00Z'),
  })
  const PAYMENTS = 'I have led a payments team of eight engineers.'

  it('a grounded cover sentence passes, judged as written against the payload statements only', async () => {
    const { d, requests } = deps()
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} ${PAYMENTS}` }),
      withPayments,
      d,
      new Set(['coverLetter']),
    )
    expect(r.failing).toEqual([])
    const claim = requests.flat().find((c) => c.text === PAYMENTS)
    expect(claim?.sources).toEqual(statementsOf(withPayments))
    expect(claim?.sources).toContain('Led a payments team of eight engineers')
  })

  it('a cover claim the facts do not hold reaches Jev as written and fails NOT_SUPPORTED', async () => {
    const { d, requests } = deps((c) => c.text !== PAYMENTS)
    const r = await gateDraft(draft({ coverBody: `${coverOf(105)} ${PAYMENTS}` }), prepared, d)
    expect(r.failing).toEqual([
      { path: 'coverLetter.1', reason: 'NOT_SUPPORTED', detail: 'FACTS do not support it' },
    ])
    const claim = requests.flat().find((c) => c.text === PAYMENTS)
    expect(claim?.sources).toEqual(statementsOf(prepared))
  })

  it('the posting title and employer do not ground a bullet', async () => {
    const r = await gateDraft(
      draft({ items: [{ bullets: [{ text: 'Shipped for Globex', sourceIndices: [0] }] }] }),
      prepared,
      deps().d,
    )
    expect(r.failing).toEqual([
      expect.objectContaining({ path: 'experience.0.bullets.0', reason: 'UNGROUNDED' }),
    ])
  })

  it.each([
    [99, false],
    [100, true],
    [220, true],
    [221, false],
  ])('cover length: %s words → pass %s', async (words, pass) => {
    const r = await gateDraft(draft({ coverBody: coverOf(words) }), prepared, deps().d)
    expect(r.failing).toEqual(pass ? [] : [{ path: 'coverLetter', reason: 'COVER_LENGTH' }])
  })

  it('an empty summary and an empty cover letter fail as EMPTY', async () => {
    const r = await gateDraft(draft({ summary: '', coverBody: '' }), prepared, deps().d)
    expect(r.failing).toEqual([
      { path: 'summary', reason: 'EMPTY' },
      { path: 'coverLetter', reason: 'EMPTY' },
    ])
  })

  it('only the units asked for are gated', async () => {
    const { d, requests } = deps(() => false)
    const r = await gateDraft(draft(), prepared, d, new Set(['experience.0.bullets.1']))
    expect(r.failing).toEqual([
      {
        path: 'experience.0.bullets.1',
        reason: 'NOT_SUPPORTED',
        detail: 'FACTS do not support it',
      },
    ])
    expect(requests.flat().map((c) => c.text)).toEqual(['Ran 40 deploys a week'])
  })

  it('the cover unit alone gates the cover letter only', async () => {
    const { d, requests } = deps(() => false)
    const r = await gateDraft(draft({ skills: ['Kafka'] }), prepared, d, new Set(['coverLetter']))
    expect(r.failing.map((f) => f.path)).toEqual(['coverLetter.0'])
    expect(requests).toHaveLength(1)
  })

  it('entailment unavailable → RunFailure ENTAILMENT_UNAVAILABLE with a closed reason', async () => {
    const d: GateDeps = {
      entailment: { score: async () => ({ kind: 'unavailable', cause: 'TIMEOUT' }) },
      beforeModelCall: async () => undefined,
    }
    const e = await gateDraft(draft(), prepared, d).catch((err: unknown) => err)
    expect(e).toBeInstanceOf(TailoredRunFailure)
    expect(e).toMatchObject({
      code: 'ENTAILMENT_UNAVAILABLE',
      origin: { provider: 'jev', reason: 'TIMEOUT' },
    })
  })

  it('a role at the start of a payload statement grounds a bullet (statements stay apart)', async () => {
    const r = await gateDraft(
      draft({
        items: [{ bullets: [{ text: 'Worked as Dev on dashboards', sourceIndices: [0] }] }],
      }),
      prepared,
      deps().d,
    )
    expect(r.failing).toEqual([])
  })

  it('a verified-base failure other than an entailment outage is rethrown as is', async () => {
    const stalled = new RunFailure('STALLED')
    const d: GateDeps = {
      entailment: { score: async () => new Map() },
      beforeModelCall: async () => {
        throw stalled
      },
    }
    await expect(gateDraft(draft(), prepared, d)).rejects.toBe(stalled)
  })

  it('another failure inside a gate is rethrown as is', async () => {
    const stalled = new TailoredRunFailure('STALLED')
    const d: GateDeps = {
      entailment: { score: async () => new Map() },
      beforeModelCall: async () => {
        throw stalled
      },
    }
    await expect(gateDraft(draft(), prepared, d)).rejects.toBe(stalled)
  })
})
