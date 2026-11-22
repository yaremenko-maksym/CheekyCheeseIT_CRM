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
import { gateDraft, type GateDeps } from './tailored-gates'
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

  // Owner decision 2026-11-22: the writer never gets the company name, and every cover sentence is
  // gated as written. The former neutraliser bypasses (SR-H-4, SR-M-1, SR-M-2) fail on their claim.
  it.each([
    ['the posting employer named', 'Globex', 'I am applying to Globex.', 'Globex'],
    [
      'a past employer behind "I apply at" (SR-H-4)',
      'Google',
      'The practices I apply at Google every day keep releases calm.',
      'Google',
    ],
    [
      'an employer string carrying a claim (SR-M-1)',
      'Stripe After Running Their Payments Org',
      'I am applying to Stripe After Running Their Payments Org.',
      'Stripe, After, Running, Their, Payments, Org',
    ],
    [
      'an applying phrase followed by a claim (SR-M-2)',
      'Globex',
      'I am applying to Globex, where I previously led the payments team.',
      'Globex',
    ],
  ])('%s is gated as written and fails UNGROUNDED', async (_, employer, sentence, tokens) => {
    const { d, requests } = deps()
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} ${sentence}` }),
      postingOf('Senior Engineer', employer),
      d,
    )
    expect(r.failing).toEqual([
      { path: 'coverLetter.1', reason: 'UNGROUNDED', detail: ungrounded(tokens) },
    ])
    // The fact gate refuses it before Jev: no model judges the sentence.
    expect(requests.flat().map((c) => c.text)).not.toContain(sentence)
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
