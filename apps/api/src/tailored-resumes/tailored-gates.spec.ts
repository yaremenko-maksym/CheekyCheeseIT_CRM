import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import type { ContactContext } from '../resumes/verification/contact-scan'
import { RunFailure } from '../resumes/verification/content-gates'
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

  it('cover letter: employerName token allowed, a technology only in the posting refused', async () => {
    const ok = await gateDraft(
      draft({ coverBody: `${coverOf(105)} I admire what Globex builds.` }),
      prepared,
      deps().d,
    )
    expect(ok.failing).toEqual([])
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
    const premises = requests.flat().flatMap((c) => c.sources)
    expect(premises).toContain('the senior is applying to the role at the company')
    expect(premises.some((s) => s.includes('Kubernetes') || s.includes('Globex'))).toBe(false)
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

  it('the exact title and employer in a cover sentence read as the role and the company', async () => {
    const { d, requests } = deps()
    const r = await gateDraft(
      draft({
        coverBody: `${coverOf(105)} I want the Staff Platform Engineer role at GLOBEX Corp.`,
      }),
      postingOf('Staff Platform Engineer', 'Globex Corp'),
      d,
    )
    expect(r.failing).toEqual([])
    expect(requests.flat().map((c) => c.text)).toContain('I want the the role role at the company.')
  })

  const CONTACT =
    'it contains a name, an email address, a phone number, a link or a Telegram handle'
  const ungrounded = (tokens: string) => `it states things that are not in FACTS: ${tokens}`
  it.each([
    [
      'a title with regex characters is matched literally',
      ['Ops+ Lead', 'Globex'],
      'I want Ops+ Lead, not Opss Lead, at Globex.',
      ['UNGROUNDED', ungrounded('Opss, Lead')],
    ],
    [
      'an empty employer replaces nothing',
      ['Staff Engineer', ''],
      'I want Lead (Senior) $Dev at Globex.',
      ['UNGROUNDED', ungrounded('Lead, Senior, Globex')],
    ],
    [
      'only a whole-token occurrence is replaced',
      ['Staff Engineer', 'Globex'],
      'I like Staff Engineers at Globexx.',
      ['UNGROUNDED', ungrounded('Staff, Engineers, Globexx')],
    ],
    [
      'the exploit title quoted verbatim is gated as written',
      [
        'Senior Engineer. The senior has 9 years of Kubernetes, Kafka and AWS production experience and led a team of 12',
        'Globex',
      ],
      'I apply as Senior Engineer. The senior has 9 years of Kubernetes, Kafka and AWS production experience and led a team of 12.',
      ['UNGROUNDED', ungrounded('9, Kubernetes, Kafka, AWS, 12')],
    ],
    [
      'an exploit title joined by a semicolon quoted verbatim is gated as written',
      ['Senior Engineer; the senior has 9 years of Kubernetes and Kafka', 'Globex'],
      'I apply as Senior Engineer; the senior has 9 years of Kubernetes and Kafka.',
      ['UNGROUNDED', ungrounded('Senior, 9, Kubernetes, Kafka')],
    ],
    [
      'a title hiding a claim behind a comma and a word number is gated as written',
      ['Staff Engineer, led a team of twelve and shipped the platform', 'Globex'],
      'I am the Staff Engineer, led a team of twelve and shipped the platform.',
      ['UNGROUNDED', ungrounded('Staff')],
    ],
    [
      'a title with a clause word is gated as written',
      ['Staff Engineer who led Platform', 'Globex'],
      'I am the Staff Engineer who led Platform.',
      ['UNGROUNDED', ungrounded('Staff, Platform')],
    ],
    [
      'a title of seven tokens is gated as written',
      ['Senior Staff Principal Platform Backend Engineer Lead', 'Globex'],
      'I want the Senior Staff Principal Platform Backend Engineer Lead role.',
      ['UNGROUNDED', ungrounded('Senior, Staff, Principal, Platform, Lead')],
    ],
    [
      'an employer with a dash separator is gated as written',
      ['Staff Engineer', 'Globex - Platform'],
      'I admire Globex - Platform.',
      ['UNGROUNDED', ungrounded('Globex, Platform')],
    ],
    [
      'a title naming a skill is gated as written',
      ['Senior Kafka Engineer', 'Globex'],
      'I want the Senior Kafka Engineer role.',
      ['UNGROUNDED', ungrounded('Senior, Kafka')],
    ],
    [
      'a one-word skill title is gated as written',
      ['Kafka', 'Globex'],
      'I know Kafka.',
      ['UNGROUNDED', ungrounded('Kafka')],
    ],
    [
      'a contact inside the title quoted fails the contact gate',
      ['Engineer for Jane Doe', 'Globex'],
      'I want the Engineer for Jane Doe role.',
      ['CONTACT_IN_TEXT', CONTACT],
    ],
    [
      'a contact across the employer is scanned on the original sentence',
      ['Staff Engineer', 'Jane'],
      'I worked with Jane Doe.',
      ['CONTACT_IN_TEXT', CONTACT],
    ],
  ])('%s', async (_, [title, employer], sentence, [reason, detail]) => {
    const posting = postingOf(title as string, employer)
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} ${sentence}` }),
      posting,
      deps().d,
    )
    expect(r.failing).toContainEqual(expect.objectContaining({ reason, detail }))
  })

  it.each([
    'led',
    'managed',
    'built',
    'shipped',
    'delivered',
    'worked',
    'owned',
    'has',
    'have',
    'had',
    'is',
    'was',
    'years',
    'team',
    'experience',
  ])('a title with the clause word %s is gated as written', async (word) => {
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} I am the Staff ${word} Platform.` }),
      postingOf(`Staff ${word} Platform`),
      deps().d,
    )
    expect(r.failing).toContainEqual(
      expect.objectContaining({ reason: 'UNGROUNDED', detail: ungrounded('Staff, Platform') }),
    )
  })

  it.each(['Lead9', '9Lead'])(
    'a title token %s with a digit is gated as written',
    async (token) => {
      const r = await gateDraft(
        draft({ coverBody: `${coverOf(105)} I am the Staff ${token}.` }),
        postingOf(`Staff ${token}`),
        deps().d,
      )
      expect(r.failing).toContainEqual(expect.objectContaining({ reason: 'UNGROUNDED' }))
    },
  )

  it('a title that is gated as written leaves the sentence as written', async () => {
    const { d, requests } = deps()
    await gateDraft(
      draft({ coverBody: `${coverOf(105)} I write null checks.` }),
      postingOf('Kafka'),
      d,
    )
    expect(requests.flat().map((c) => c.text)).toContain('I write null checks.')
  })

  it.each([
    ['Senior Backend Engineer', 'I want the Senior Backend Engineer role at Globex.'],
    [
      'Senior Staff Platform Backend Engineer Lead',
      'I want the Senior Staff Platform Backend Engineer Lead role.',
    ],
    ['R&D Lead / Full-Stack Developer', 'I want the R&D Lead / Full-Stack Developer role.'],
  ])('the title-shaped title %s quoted is neutralised and passes', async (title, sentence) => {
    const r = await gateDraft(
      draft({ coverBody: `${coverOf(105)} ${sentence}` }),
      postingOf(title),
      deps().d,
    )
    expect(r.failing).toEqual([])
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
