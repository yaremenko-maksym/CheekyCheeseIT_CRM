/**
 * Unit spec of stages 3 and 4 (Task 14): the writing payload, the worker fit, the claim groups, the
 * feedback lines and the regenerate-then-fall-back loop, with a fake writer and a fake entailment
 * client. Expected values are hand-written literals, never recomputed through the code under test.
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_EXTRACTION_INPUT_CHARS } from '@crm/inference'
import type { ResumeContent, ResumeFacts } from '@crm/shared'
import type { ContactContext } from './contact-scan'
import {
  cleanedNotes,
  fitToWorker,
  groupClaims,
  payloadStatements,
  redactAll,
  RunFailure,
  splitSentences,
  toFeedback,
  writeGatedContent,
  writeGatedField,
  writingPayload,
  type ContentDeps,
  type ContentInput,
  type WritingPayload,
} from './content-gates'
import { deriveFrozenContent } from './derive-content'
import { resumeWriteInput, type EntailmentClaim, type WriterReply } from './inference-clients'

const CONTACTS: ContactContext[] = [
  { fullName: 'Jane Doe', emails: ['jane.doe@unit.spec'] },
  { fullName: 'Jane Quinn Doe', emails: ['jane.doe@unit.spec'] },
]

const FACTS: ResumeFacts = {
  headline: 'Senior Backend Engineer',
  location: { city: 'Lisbon', country: 'Portugal' },
  workFormat: 'remote',
  skills: ['TypeScript', 'NestJS'],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Tech Lead',
      location: null,
      start: '2021-03',
      end: null,
      current: true,
      technologies: ['TypeScript'],
      notes: ['Led the payments team', '  Moved   billing to TypeScript  ', ''],
    },
    {
      company: 'Globex',
      role: 'Engineer',
      location: null,
      start: '2018-01',
      end: '2021-02',
      current: false,
      technologies: [],
      notes: ['Built the billing service'],
    },
  ],
  education: [
    { institution: 'Stanford University', degree: 'BSc Physics', startYear: 2010, endYear: 2014 },
  ],
  languages: [{ name: 'English', level: 'C1' }],
  links: [{ label: 'GitHub', url: 'https://github.com/janedoe-unit' }],
}

function input(facts: ResumeFacts = FACTS): ContentInput {
  return {
    facts,
    frozen: deriveFrozenContent(facts),
    contacts: CONTACTS,
    template: 'classic',
    now: new Date('2026-11-11T12:00:00Z'),
  }
}

type Call = { task: string; payload: WritingPayload; feedback: string[] }

/** A writer that answers from a per-task script; the last scripted reply repeats. */
function fakeDeps(
  script: { summary?: WriterReply[]; bullets?: (item: string) => WriterReply[] },
  score: (claim: EntailmentClaim) => number | undefined = () => 0.95,
) {
  const calls: Call[] = []
  const claims: EntailmentClaim[] = []
  const counters = new Map<string, number>()
  const deps: ContentDeps & { calls: Call[]; claims: EntailmentClaim[] } = {
    calls,
    claims,
    beforeModelCall: vi.fn(),
    writer: {
      write: vi.fn(async (task, payload: string, feedback: string[]) => {
        const parsed = JSON.parse(payload) as WritingPayload
        calls.push({ task, payload: parsed, feedback })
        const key = task === 'summary' ? 'summary' : (parsed.experience[0]?.company ?? '')
        const n = counters.get(key) ?? 0
        counters.set(key, n + 1)
        const replies =
          task === 'summary'
            ? (script.summary ?? [{ kind: 'ok', summary: 'Backend engineer.' }])
            : (script.bullets?.(key) ?? [
                { kind: 'ok', items: [{ index: 0, bullets: parsed.experience[0]?.notes ?? [] }] },
              ])
        return replies[Math.min(n, replies.length - 1)] as WriterReply
      }),
    },
    entailment: {
      score: vi.fn(async (group: EntailmentClaim[]) => {
        claims.push(...group)
        const scores = new Map<string, number>()
        for (const claim of group) {
          const s = score(claim)
          if (s !== undefined) scores.set(claim.id, s)
        }
        return scores
      }),
    },
  }
  return deps
}

const ok = (summary: string): WriterReply => ({ kind: 'ok', summary })
const bullets = (...b: string[]): WriterReply => ({ kind: 'ok', items: [{ index: 0, bullets: b }] })

describe('cleanedNotes', () => {
  it('collapses whitespace and drops blank notes', () => {
    expect(cleanedNotes(['  a \n  b ', '', ' \t ', 'c'])).toEqual(['a b', 'c'])
  })
})

describe('redactAll', () => {
  it('applies every name context, so the legal name and the email both go', () => {
    const out = redactAll('Jane Quinn Doe wrote from jane.doe@unit.spec today', CONTACTS)
    expect(out).not.toContain('Quinn')
    expect(out).not.toContain('jane.doe@unit.spec')
    expect(out).toContain('[REDACTED]')
    expect(out).toBe('[REDACTED] wrote from [REDACTED] today')
    // The legal context's surname hit must not break the display name's full match either.
    expect(redactAll('Ask Jane Doe now', [...CONTACTS].reverse())).toBe('Ask [REDACTED] now')
  })

  it('leaves text alone without contacts', () => {
    expect(redactAll('Jane Doe', [])).toBe('Jane Doe')
  })
})

describe('writingPayload', () => {
  it('is the minimised facts: no name, email, location, education, languages or links', () => {
    const facts: ResumeFacts = {
      ...FACTS,
      headline: 'Jane Doe, Senior Backend Engineer',
      experience: [
        {
          ...(FACTS.experience[0] as ResumeFacts['experience'][number]),
          company: 'Jane Doe Consulting',
          role: 'Lead for jane.doe@unit.spec',
          technologies: ['TypeScript', 'Jane Doe'],
          notes: ['Asked Jane Doe   twice'],
        },
      ],
    }
    expect(writingPayload(input(facts))).toEqual({
      headline: '[REDACTED], Senior Backend Engineer',
      // the frozen skills carry the item technologies
      skills: ['TypeScript', 'NestJS', '[REDACTED]'],
      // 2021-03 to 2026-11 inclusive is 69 months
      yearsOfExperience: 5,
      experience: [
        {
          company: '[REDACTED] Consulting',
          role: 'Lead for [REDACTED]',
          start: '2021-03',
          end: null,
          current: true,
          technologies: ['TypeScript', '[REDACTED]'],
          notes: ['Asked [REDACTED] twice'],
        },
      ],
    })
  })

  it('counts merged years over every item (2018-01 to 2026-11 is 107 months)', () => {
    expect(writingPayload(input()).yearsOfExperience).toBe(8)
  })
})

describe('payloadStatements', () => {
  it('states the headline, skills, years and each item, skipping blank ones', () => {
    const p: WritingPayload = {
      headline: ' ',
      skills: ['Go'],
      yearsOfExperience: 3,
      experience: [
        {
          company: 'Acme',
          role: 'Dev',
          start: null,
          end: null,
          current: false,
          technologies: [],
          notes: ['Shipped it'],
        },
        {
          company: 'Initech',
          role: 'Lead',
          start: '2020-01',
          end: null,
          current: true,
          technologies: ['Go', 'Rust'],
          notes: [],
        },
      ],
    }
    expect(payloadStatements(p)).toEqual([
      'Skills: Go',
      '3 years of experience',
      'Dev at Acme, from unknown to unknown',
      'Shipped it',
      'Lead at Initech, from 2020-01 to present',
      'Technologies at Initech: Go, Rust',
    ])
  })
})

describe('splitSentences', () => {
  it('splits after . ! and ? followed by whitespace, trimming blanks', () => {
    expect(splitSentences('  One. Two!  Three?\nfour 4.5 five  ')).toEqual([
      'One.',
      'Two!',
      'Three?',
      'four 4.5 five',
    ])
    expect(splitSentences('   ')).toEqual([])
  })
})

describe('groupClaims', () => {
  // `{"id":"c0","text":"","sources":[]}` is 34 bytes, so this text makes a 64 000-byte claim.
  const claim = (id: string, extra = 0): EntailmentClaim => ({
    id,
    text: 'x'.repeat(64_000 - 34 + extra),
    sources: [],
  })

  it('fills a group up to exactly 128 000 bytes', () => {
    const groups = groupClaims([claim('c0'), claim('c1'), claim('c2')])
    expect(groups.map((g) => g.map((c) => c.id))).toEqual([['c0', 'c1'], ['c2']])
  })

  it('starts a new group one byte past the cap', () => {
    const groups = groupClaims([claim('c0'), claim('c1', 1)])
    expect(groups.map((g) => g.map((c) => c.id))).toEqual([['c0'], ['c1']])
  })

  it('keeps small claims together and returns nothing for nothing', () => {
    expect(groupClaims([])).toEqual([])
    const small = [1, 2, 3].map((n) => ({ id: `c${n}`, text: 't', sources: ['s'] }))
    expect(groupClaims(small)).toEqual([small])
  })
})

describe('toFeedback', () => {
  it('numbers the line from 1, keeps an unindexed line bare, redacts and strips CR/LF', () => {
    expect(
      toFeedback(
        'Bullet',
        [
          { index: 0, reason: 'EMPTY', detail: 'it is empty' },
          { index: -1, reason: 'EMPTY', detail: 'The summary is empty' },
          { index: 2, reason: 'X', detail: 'mentions Jane Doe\r\nand more' },
        ],
        CONTACTS,
      ),
    ).toEqual([
      'Bullet 1: it is empty.',
      'The summary is empty.',
      'Bullet 3: mentions [REDACTED] and more.',
    ])
  })

  it('caps a line at 1000 chars and the list at 20 lines', () => {
    const failures = Array.from({ length: 25 }, (_, index) => ({
      index,
      reason: 'X',
      detail: 'y'.repeat(2000),
    }))
    const lines = toFeedback('Bullet', failures, [])
    expect(lines).toHaveLength(20)
    expect(lines.every((l) => l.length === 1000)).toBe(true)
    expect(lines[19]?.startsWith('Bullet 20: ')).toBe(true)
  })
})

describe('fitToWorker', () => {
  const item = (notes: string[]): WritingPayload['experience'][number] => ({
    company: 'Acme',
    role: 'Dev',
    start: null,
    end: null,
    current: false,
    technologies: [],
    notes,
  })
  const size = (p: WritingPayload, f: string[]) => resumeWriteInput(JSON.stringify(p), f).length
  const base: WritingPayload = { headline: 'H', skills: [], yearsOfExperience: 1, experience: [] }

  it('returns a payload that already fits unchanged', () => {
    const p = { ...base, experience: [item(['a']), item(['b'])] }
    expect(fitToWorker(p, ['f1', 'f2'])).toEqual({ payload: p, feedback: ['f1', 'f2'] })
  })

  it('drops trailing items for the summary, never the first one', () => {
    const big = item(['z'.repeat(20_000)])
    const p = { ...base, experience: [big, big, big, big] }
    const out = fitToWorker(p, ['keep me'])
    expect(out.payload.experience).toHaveLength(2)
    expect(out.feedback).toEqual(['keep me'])
    expect(size(out.payload, out.feedback)).toBeLessThanOrEqual(MAX_EXTRACTION_INPUT_CHARS)

    const huge = { ...base, experience: [item(['z'.repeat(60_000)]), item(['a'])] }
    expect(fitToWorker(huge, ['f'])).toEqual({
      payload: { ...base, experience: [huge.experience[0]] },
      feedback: [],
    })
  })

  it('keeps the only item (a bullets call) and drops feedback lines last first until it fits', () => {
    const p = { ...base, experience: [item(['z'.repeat(45_000)])] }
    const feedback = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(1000))
    const out = fitToWorker(p, feedback)
    expect(out.payload).toBe(p)
    const n = out.feedback.length
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(10)
    expect(out.feedback).toEqual(feedback.slice(0, n))
    expect(size(p, out.feedback)).toBeLessThanOrEqual(MAX_EXTRACTION_INPUT_CHARS)
    expect(size(p, feedback.slice(0, n + 1))).toBeGreaterThan(MAX_EXTRACTION_INPUT_CHARS)
  })

  it('a message of exactly 50 000 chars fits, one char more does not', () => {
    const p = { ...base, experience: [item(['a'])] }
    const pad = MAX_EXTRACTION_INPUT_CHARS - size(p, [''])
    expect(size(p, ['x'.repeat(pad)])).toBe(50_000)
    expect(fitToWorker(p, ['x'.repeat(pad)]).feedback).toHaveLength(1)
    expect(fitToWorker(p, ['x'.repeat(pad + 1)]).feedback).toHaveLength(0)
  })
})

describe('writeGatedContent', () => {
  it('happy path: one summary call, one bullets call per item, every gate passed', async () => {
    const deps = fakeDeps({ summary: [ok('  Backend   engineer with TypeScript. ')] })
    const out = await writeGatedContent(input(), deps)
    expect(out.content.summary).toBe('Backend engineer with TypeScript.')
    expect(out.content.experience.map((e) => e.bullets)).toEqual([
      ['Led the payments team', 'Moved billing to TypeScript'],
      ['Built the billing service'],
    ])
    expect(out.content.experience[0]?.company).toBe('Acme Corp')
    expect(out.gate).toEqual({ gate: 'content', ok: true, items: [] })
    expect(out.fallbacks).toEqual([])
    expect(deps.calls.map((c) => c.task)).toEqual(['summary', 'bullets', 'bullets'])
    // Three writer calls and three entailment requests, each preceded by the budget check.
    expect(deps.beforeModelCall).toHaveBeenCalledTimes(6)
  })

  it('sends one experience item per bullets call, the summary gets them all', async () => {
    const deps = fakeDeps({})
    await writeGatedContent(input(), deps)
    expect(deps.calls[0]?.payload.experience.map((e) => e.company)).toEqual(['Acme Corp', 'Globex'])
    expect(deps.calls[1]?.payload.experience.map((e) => e.company)).toEqual(['Acme Corp'])
    expect(deps.calls[2]?.payload.experience.map((e) => e.company)).toEqual(['Globex'])
    const sent = JSON.stringify(deps.calls)
    for (const banned of ['Jane', 'unit.spec', 'Lisbon', 'Stanford', 'English', 'github']) {
      expect(sent).not.toContain(banned)
    }
  })

  it('scores bullets against the item statements and the summary against the whole payload', async () => {
    const deps = fakeDeps({ bullets: () => [bullets('Led the payments team')] })
    await writeGatedContent(input(), deps)
    expect(deps.claims[0]?.sources).toEqual([
      'Senior Backend Engineer',
      'Skills: TypeScript, NestJS',
      '8 years of experience',
      'Tech Lead at Acme Corp, from 2021-03 to present',
      'Technologies at Acme Corp: TypeScript',
      'Led the payments team',
      'Moved billing to TypeScript',
      'Engineer at Globex, from 2018-01 to 2021-02',
      'Built the billing service',
    ])
    expect(deps.claims[1]).toEqual({
      id: 'c0',
      text: 'Led the payments team',
      sources: [
        'Tech Lead at Acme Corp, from 2021-03 to present',
        'Technologies at Acme Corp: TypeScript',
        'Led the payments team',
        'Moved billing to TypeScript',
      ],
    })
    expect(deps.claims[2]?.sources).toEqual([
      'Engineer at Globex, from 2018-01 to 2021-02',
      'Built the billing service',
    ])
  })

  it('invented "40%" is regenerated twice with feedback, then falls back to the notes', async () => {
    const deps = fakeDeps({
      bullets: (company) =>
        company === 'Acme Corp'
          ? [bullets('Cut costs by 40%')]
          : [bullets('Built the billing service')],
    })
    const out = await writeGatedContent(input(), deps)
    const acme = deps.calls.filter(
      (c) => c.task === 'bullets' && c.payload.experience[0]?.company === 'Acme Corp',
    )
    expect(deps.calls.filter((c) => c.task === 'bullets')).toHaveLength(4)
    expect(acme.slice(1).map((c) => c.feedback)).toEqual([
      ['Bullet 1: it states things that are not in FACTS: 40.'],
      ['Bullet 1: it states things that are not in FACTS: 40.'],
    ])
    expect(acme[0]?.feedback).toEqual([])
    expect(out.content.experience[0]?.bullets).toEqual([
      'Led the payments team',
      'Moved billing to TypeScript',
    ])
    expect(out.fallbacks).toEqual(['experience.0.bullets'])
    expect(out.gate).toEqual({
      gate: 'content',
      ok: false,
      items: [{ path: 'experience.0.bullets', reason: 'UNGROUNDED' }],
    })
  })

  it('a regeneration that passes is kept, no fallback', async () => {
    const deps = fakeDeps({
      bullets: (company) =>
        company === 'Acme Corp'
          ? [bullets('Cut costs by 40%'), bullets('Led the payments team')]
          : [bullets('Built the billing service')],
    })
    const out = await writeGatedContent(input(), deps)
    expect(out.content.experience[0]?.bullets).toEqual(['Led the payments team'])
    expect(out.fallbacks).toEqual([])
    expect(deps.calls.filter((c) => c.task === 'bullets')).toHaveLength(3)
  })

  it('feedback names every ungrounded token, comma-separated', async () => {
    const deps = fakeDeps({
      bullets: (company) =>
        company === 'Acme Corp'
          ? [bullets('Cut costs by 40% at Initech')]
          : [bullets('Built the billing service')],
    })
    await writeGatedContent(input(), deps)
    expect(deps.calls[2]?.feedback).toEqual([
      'Bullet 1: it states things that are not in FACTS: 40, Initech.',
    ])
  })

  it('source statements stay separate lines; a bullet may use a skill of the whole resume', async () => {
    const globex = FACTS.experience[1] as ResumeFacts['experience'][number]
    const facts: ResumeFacts = {
      ...FACTS,
      experience: [
        FACTS.experience[0] as ResumeFacts['experience'][number],
        { ...globex, notes: ['Cut latency by 40', '3 services moved'] },
      ],
    }
    // Joined without a separator the notes would read "by 403 services" and lose the 40.
    const deps = fakeDeps({
      summary: [ok('Cut latency by 40 percent.')],
      bullets: (company) =>
        company === 'Globex'
          ? [bullets('Cut latency by 40 percent with NestJS')]
          : [bullets('Led the payments team')],
    })
    const out = await writeGatedContent(input(facts), deps)
    expect(out.fallbacks).toEqual([])
    expect(out.content.summary).toBe('Cut latency by 40 percent.')
    expect(out.content.experience[1]?.bullets).toEqual(['Cut latency by 40 percent with NestJS'])
  })

  it('a summary naming a company the payload does not hold is UNGROUNDED', async () => {
    const deps = fakeDeps({ summary: [ok('Backend engineer at Stryker.')] })
    const out = await writeGatedContent(input(), deps)
    expect(out.gate.items).toEqual([{ path: 'summary', reason: 'UNGROUNDED' }])
    expect(deps.calls[1]?.feedback).toEqual([
      'Sentence 1: it states things that are not in FACTS: Stryker.',
    ])
  })

  it('the summary call drops trailing items to fit the worker; each bullets call keeps its item', async () => {
    const long = 'billing '.repeat(2_500).trim()
    const base = FACTS.experience[1] as ResumeFacts['experience'][number]
    const facts: ResumeFacts = {
      ...FACTS,
      experience: ['Globex', 'Initech', 'Hooli', 'Umbrella'].map((company) => ({
        ...base,
        company,
        notes: [long],
      })),
    }
    const deps = fakeDeps({})
    await writeGatedContent(input(facts), deps)
    expect(deps.calls[0]?.payload.experience.map((e) => e.company)).toEqual(['Globex', 'Initech'])
    expect(deps.calls.slice(1).map((c) => c.payload.experience.map((e) => e.company))).toEqual([
      ['Globex'],
      ['Initech'],
      ['Hooli'],
      ['Umbrella'],
    ])
  })

  it('a name of any one contact context fails the item, not only a name of all of them', async () => {
    const deps = fakeDeps({
      bullets: (company) =>
        company === 'Globex'
          ? [bullets('Worked with Ivanna Petrenko on billing')]
          : [bullets('Led the payments team')],
    })
    const contacts = [
      { fullName: 'Jane Doe', emails: [] },
      { fullName: 'Ivanna Petrenko', emails: [] },
    ]
    const out = await writeGatedContent({ ...input(), contacts }, deps)
    expect(out.gate.items).toEqual([{ path: 'experience.1.bullets', reason: 'CONTACT_IN_TEXT' }])
  })

  it('model text is cleaned for the template: lines joined, spaces collapsed, no break hints', async () => {
    const run = 'x'.repeat(70)
    const deps = fakeDeps({
      summary: [ok('\nBackend engineer.\n\nBuilt billing.\n')],
      bullets: () => [bullets(`Built ${run} billing`)],
    })
    const out = await writeGatedContent(input(), deps)
    expect(out.content.summary).toBe('Backend engineer. Built billing.')
    expect(out.content.experience.map((e) => e.bullets)).toEqual([
      [`Built ${run} billing`],
      [`Built ${run} billing`],
    ])
  })

  it.each([
    ['the full name', 'Worked with Jane Doe on billing'],
    ['the legal name', 'Jane Quinn Doe led the team'],
    ['an email', 'Mail jane.doe@unit.spec for billing'],
    ['a redaction token', 'Worked with [REDACTED] on billing'],
  ])('model output with %s fails that item as CONTACT_IN_TEXT', async (_label, text) => {
    const deps = fakeDeps({
      bullets: (company) =>
        company === 'Globex' ? [bullets(text)] : [bullets('Led the payments team')],
    })
    const out = await writeGatedContent(input(), deps)
    expect(out.fallbacks).toEqual(['experience.1.bullets'])
    expect(out.gate.items).toEqual([{ path: 'experience.1.bullets', reason: 'CONTACT_IN_TEXT' }])
    const globex = deps.calls.filter(
      (c) => c.task === 'bullets' && c.payload.experience[0]?.company === 'Globex',
    )
    expect(globex[1]?.feedback).toEqual([
      'Bullet 1: it contains a name, an email address, a phone number, a link or a Telegram handle.',
    ])
  })

  it.each([
    ['no items', { kind: 'ok', items: [] }],
    ['index 1', { kind: 'ok', items: [{ index: 1, bullets: ['Built the billing service'] }] }],
    [
      'two items',
      {
        kind: 'ok',
        items: [
          { index: 0, bullets: ['Built the billing service'] },
          { index: 0, bullets: ['Built the billing service'] },
        ],
      },
    ],
  ] as [string, WriterReply][])('a bullets reply with %s is BAD_INDEX', async (_label, reply) => {
    const deps = fakeDeps({ bullets: () => [reply] })
    const out = await writeGatedContent(input(), deps)
    expect(out.fallbacks).toEqual(['experience.0.bullets', 'experience.1.bullets'])
    expect(out.gate.items.map((i) => i.reason)).toEqual(['BAD_INDEX', 'BAD_INDEX'])
    expect(deps.calls[2]?.feedback).toEqual([
      'Return exactly one item, with index 0, for the one experience item in FACTS.',
    ])
    expect(deps.entailment.score).toHaveBeenCalledTimes(1)
  })

  it('an empty bullet is EMPTY', async () => {
    const deps = fakeDeps({ bullets: () => [bullets('Led the payments team', '   ')] })
    const out = await writeGatedContent(input(), deps)
    expect(out.gate.items).toContainEqual({ path: 'experience.0.bullets', reason: 'EMPTY' })
    expect(deps.calls[2]?.feedback).toEqual(['Bullet 2: it is empty.'])
  })

  it('an empty summary falls back to "" after three attempts', async () => {
    const deps = fakeDeps({ summary: [ok('   ')] })
    const out = await writeGatedContent(input(), deps)
    expect(deps.calls.filter((c) => c.task === 'summary').map((c) => c.feedback)).toEqual([
      [],
      ['The summary is empty.'],
      ['The summary is empty.'],
    ])
    expect(out.content.summary).toBe('')
    expect(out.fallbacks).toEqual(['summary'])
    expect(out.gate.items).toEqual([{ path: 'summary', reason: 'EMPTY' }])
  })

  it('a summary reply without a summary field reads as empty', async () => {
    const deps = fakeDeps({ summary: [bullets('Led the payments team')] })
    const out = await writeGatedContent(input(), deps)
    expect(out.gate.items).toEqual([{ path: 'summary', reason: 'EMPTY' }])
  })

  it('a bullets reply without items is BAD_INDEX', async () => {
    const deps = fakeDeps({ bullets: () => [ok('Led the payments team')] })
    const out = await writeGatedContent(input(), deps)
    expect(out.gate.items.map((i) => i.reason)).toEqual(['BAD_INDEX', 'BAD_INDEX'])
  })

  it('the entailment threshold 0.8 passes, below it and a missing score do not', async () => {
    const pass = await writeGatedContent(
      input(),
      fakeDeps({}, () => 0.8),
    )
    expect(pass.fallbacks).toEqual([])
    const low = await writeGatedContent(
      input(),
      fakeDeps({}, () => 0.79),
    )
    expect(low.fallbacks).toEqual(['summary', 'experience.0.bullets', 'experience.1.bullets'])
    expect(low.gate.items.map((i) => i.reason)).toEqual([
      'NOT_SUPPORTED',
      'NOT_SUPPORTED',
      'NOT_SUPPORTED',
      'NOT_SUPPORTED',
    ])
    const missing = await writeGatedContent(
      input(),
      fakeDeps({}, () => undefined),
    )
    expect(missing.fallbacks).toHaveLength(3)
  })

  it('feedback lists the failures in bullet order, whatever the gate that found them', async () => {
    const deps = fakeDeps(
      { bullets: () => [bullets('Led the payments team', 'Cut costs by 40%')] },
      (claim) => (claim.text === 'Led the payments team' ? 0.1 : 0.95),
    )
    await writeGatedContent(input(), deps)
    expect(deps.calls[2]?.feedback).toEqual([
      'Bullet 1: FACTS do not support it.',
      'Bullet 2: it states things that are not in FACTS: 40.',
    ])
  })

  it('a summary sentence that is not supported is named in the next feedback', async () => {
    const deps = fakeDeps({ summary: [ok('Backend engineer. Loves billing.')] }, (claim) =>
      claim.text === 'Loves billing.' ? 0 : 0.95,
    )
    await writeGatedContent(input(), deps)
    expect(deps.calls[1]?.feedback).toEqual(['Sentence 2: FACTS do not support it.'])
  })

  it('writer unavailable fails the run WRITER_UNAVAILABLE', async () => {
    const deps = fakeDeps({ summary: [{ kind: 'unavailable', reason: 'TIMEOUT' } as WriterReply] })
    await expect(writeGatedContent(input(), deps)).rejects.toMatchObject({
      name: 'RunFailure',
      code: 'WRITER_UNAVAILABLE',
      origin: { provider: 'extraction-worker:/resume-write', reason: 'TIMEOUT' },
    })
  })

  it('entailment unavailable fails closed with ENTAILMENT_UNAVAILABLE', async () => {
    const deps = fakeDeps({})
    deps.entailment.score = vi.fn(async () => 'unavailable' as const)
    await expect(writeGatedContent(input(), deps)).rejects.toMatchObject({
      code: 'ENTAILMENT_UNAVAILABLE',
      // No gate ran to the end: the report carries no gate of its own.
      gates: [],
      origin: { provider: 'jev', reason: 'UNAVAILABLE' },
    })
  })

  it('a texts list with no claim makes no entailment call', async () => {
    const deps = fakeDeps({ summary: [ok('Jane Doe is great.')], bullets: () => [bullets('')] })
    await writeGatedContent(input(), deps)
    expect(deps.entailment.score).not.toHaveBeenCalled()
  })

  it('the budget check runs before the first model call and stops the run', async () => {
    const deps = fakeDeps({})
    deps.beforeModelCall = () => {
      throw new RunFailure('STALLED')
    }
    await expect(writeGatedContent(input(), deps)).rejects.toMatchObject({ code: 'STALLED' })
    expect(deps.writer.write).not.toHaveBeenCalled()
  })
})

describe('writeGatedField (Task 15 item run)', () => {
  /** The staged content an item run starts from: every text hand-written, so a rewrite shows. */
  function base(): ResumeContent {
    const frozen = input().frozen
    return {
      ...frozen,
      summary: 'Hand summary.',
      experience: frozen.experience.map((item, i) => ({ ...item, bullets: [`Hand bullet ${i}`] })),
    }
  }

  it('bullets of one item: one call for that item, every other text kept', async () => {
    const deps = fakeDeps({})
    const out = await writeGatedField(input(), deps, 1, base())
    expect(deps.calls.map((c) => [c.task, c.payload.experience[0]?.company])).toEqual([
      ['bullets', 'Globex'],
    ])
    expect(out.content.summary).toBe('Hand summary.')
    expect(out.content.experience.map((e) => e.bullets)).toEqual([
      ['Hand bullet 0'],
      ['Built the billing service'],
    ])
    expect(out.gate).toEqual({ gate: 'content', ok: true, items: [] })
    expect(out.fallbacks).toEqual([])
  })

  it('bullets that fail every attempt fall back to the cleaned notes of that item', async () => {
    const deps = fakeDeps({ bullets: () => [bullets('Cut costs by 40%')] })
    const out = await writeGatedField(input(), deps, 0, base())
    expect(out.content.experience.map((e) => e.bullets)).toEqual([
      ['Led the payments team', 'Moved billing to TypeScript'],
      ['Hand bullet 1'],
    ])
    expect(out.content.summary).toBe('Hand summary.')
    expect(out.fallbacks).toEqual(['experience.0.bullets'])
    expect(out.gate).toEqual({
      gate: 'content',
      ok: false,
      items: [{ path: 'experience.0.bullets', reason: 'UNGROUNDED' }],
    })
  })

  it('bullets that pass on a regeneration are kept, with no finding', async () => {
    const deps = fakeDeps({
      bullets: () => [bullets('Cut costs by 40%'), bullets('Led the payments team')],
    })
    const out = await writeGatedField(input(), deps, 0, base())
    expect(out.content.experience[0]?.bullets).toEqual(['Led the payments team'])
    expect(out.gate).toEqual({ gate: 'content', ok: true, items: [] })
    expect(out.fallbacks).toEqual([])
  })

  it('the summary: one summary call, cleaned for the template, the bullets kept', async () => {
    const deps = fakeDeps({ summary: [ok('Backend\nengineer.')] })
    const out = await writeGatedField(input(), deps, 'summary', base())
    expect(deps.calls.map((c) => c.task)).toEqual(['summary'])
    expect(out.content.summary).toBe('Backend engineer.')
    expect(out.content.experience).toEqual(base().experience)
    expect(out.gate).toEqual({ gate: 'content', ok: true, items: [] })
    expect(out.fallbacks).toEqual([])
  })

  it('a summary still failing after two regenerations keeps the previous one and is a fallback (FR-A-4)', async () => {
    const deps = fakeDeps({ summary: [ok('   ')] })
    const out = await writeGatedField(input(), deps, 'summary', base())
    expect(deps.calls).toHaveLength(3)
    expect(out.content.summary).toBe('Hand summary.')
    expect(out.content.experience).toEqual(base().experience)
    expect(out.fallbacks).toEqual(['summary'])
    expect(out.gate).toEqual({
      gate: 'content',
      ok: false,
      items: [{ path: 'summary', reason: 'EMPTY' }],
    })
  })
})

describe('RunFailure', () => {
  it('carries the code, the gates and its name', () => {
    const gates = [{ gate: 'ats', ok: false, items: [] }]
    const err = new RunFailure('RENDER_FAILED', gates)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('RunFailure')
    expect(err.message).toBe('RENDER_FAILED')
    expect(err.gates).toBe(gates)
    expect(new RunFailure('STALLED').gates).toEqual([])
  })
})
