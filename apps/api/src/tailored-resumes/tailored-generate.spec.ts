import { MAX_EXTRACTION_INPUT_CHARS } from '@crm/inference'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import {
  MAX_POSTING_CHARS,
  tailorBodySchema,
  tailorWorkerInput,
} from '../extraction-worker/link-contract'
import type { WritingPayload } from '../resumes/verification/content-gates'
import type { ContactContext } from '../resumes/verification/contact-scan'
import type { Analysis } from './tailored-analysis'
import { sanitizeRun, tailorBody } from './tailored-generate'
import { assemblePrepared, tailorFits, type PreparedRun } from './tailored-prepare'

const contacts: ContactContext[] = [
  { fullName: 'Jane Doe', emails: ['jane@example.com'], telegram: null },
]
const CONTACT = /jane@example\.com|Jane Doe/
const content: ResumeContent = {
  ...EMPTY_RESUME_CONTENT,
  summary: 'Backend engineer who builds APIs.',
  skills: ['Postgres', 'TypeScript'],
  experience: [
    {
      company: 'Acme',
      role: 'Dev',
      period: '2020 - 2022',
      bullets: ['Used React for dashboards', 'Ran 40 deploys a week'],
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
const analysis: Analysis = {
  injectionSuspected: false,
  requirements: [
    { name: 'React', bucket: 'existing' },
    { name: 'Kubernetes', bucket: 'supported' },
    { name: 'Kafka', bucket: 'gap' },
  ],
}

/** `prepared` with one payload field rewritten by `edit`, as a bypassed prepare step would leave it. */
function tampered(edit: (p: WritingPayload) => void): PreparedRun {
  const p = JSON.parse(prepared.payload) as WritingPayload
  edit(p)
  return { ...prepared, payload: JSON.stringify(p) }
}
const item = (p: WritingPayload) => p.experience[0] as WritingPayload['experience'][number]

describe('sanitizeRun and tailorBody (R19: redaction at the client boundary)', () => {
  it.each<[string, PreparedRun, Analysis]>([
    ['payload headline', tampered((p) => (p.headline = 'Ask jane@example.com')), analysis],
    ['payload skill', tampered((p) => (p.skills[0] = 'Jane Doe')), analysis],
    ['payload company', tampered((p) => (item(p).company = 'Jane Doe LLC')), analysis],
    ['payload role', tampered((p) => (item(p).role = 'jane@example.com')), analysis],
    ['payload technology', tampered((p) => (item(p).technologies = ['Jane Doe'])), analysis],
    ['payload note', tampered((p) => (item(p).notes[0] = 'Mail jane@example.com')), analysis],
    [
      'posting title',
      { ...prepared, posting: { ...prepared.posting, title: 'Jane Doe wanted' } },
      analysis,
    ],
    [
      'posting employer',
      { ...prepared, posting: { ...prepared.posting, employerName: 'jane@example.com' } },
      analysis,
    ],
    [
      'posting text',
      { ...prepared, posting: { ...prepared.posting, text: 'Reply to jane@example.com' } },
      analysis,
    ],
    [
      'existing requirement',
      prepared,
      { ...analysis, requirements: [{ name: 'Jane Doe', bucket: 'existing' }] },
    ],
    [
      'supported requirement',
      prepared,
      { ...analysis, requirements: [{ name: 'jane@example.com', bucket: 'supported' }] },
    ],
  ])('tailor payload carries no contact: %s', (_, run, a) => {
    const body = tailorBody(sanitizeRun(run, a), [])
    expect(JSON.stringify(body)).not.toMatch(CONTACT)
    expect(tailorBodySchema.safeParse(body).success).toBe(true)
  })

  it('a feedback line is redacted after its line breaks become spaces', () => {
    const body = tailorBody(sanitizeRun(prepared, analysis), [
      'Experience item 1, bullet 1: it states things that are not in FACTS: Jane\u0085Doe.',
      'Summary sentence 1: jane@example.com.',
    ])
    expect(JSON.stringify(body)).not.toMatch(CONTACT)
    expect(body.feedback).toHaveLength(2)
    expect(body.feedback[0]).not.toMatch(/\u0085/u)
    expect(tailorBodySchema.safeParse(body).success).toBe(true)
  })

  it('the body carries the analysis buckets, never the gap requirements', () => {
    const body = tailorBody(sanitizeRun(prepared, analysis), [])
    expect(body.posting.requirements).toEqual({ existing: ['React'], supported: ['Kubernetes'] })
    expect(body.posting.title).toBe('Senior Engineer')
    // Owner decision 2026-11-22: the writer never gets the employer name.
    expect(body.posting).not.toHaveProperty('employerName')
  })

  it('redaction that lengthens a field keeps it within the body caps', () => {
    // `[REDACTED]` is two characters longer than `Jane Doe`.
    const long = (n: number) => `${'x'.repeat(n - 9)} Jane Doe`
    const run = sanitizeRun(
      {
        ...prepared,
        posting: {
          ...prepared.posting,
          title: long(300),
          employerName: long(200),
          text: long(MAX_POSTING_CHARS),
        },
      },
      { ...analysis, requirements: [{ name: long(200), bucket: 'existing' }] },
    )
    const body = tailorBody(run, [])
    // A marker that does not fit whole is cut away whole, never split (SR-L-1).
    expect(body.posting.title).toBe(`${'x'.repeat(291)} `)
    // The employer name stays capped for the analysis and the review; the body never carries it.
    expect(run.posting.employerName).toBe(`${'x'.repeat(191)} `)
    expect(body.posting.text).toBe(`${'x'.repeat(MAX_POSTING_CHARS - 9)} `)
    expect(body.posting.requirements.existing[0]).toBe(`${'x'.repeat(191)} `)
    expect(tailorBodySchema.safeParse(body).success).toBe(true)
    // The re-cap cut the posting text, so it reads as truncated.
    expect(run.posting.truncated).toBe(true)
  })

  it('a redacted field that still fits keeps its whole marker and is not truncated', () => {
    const run = sanitizeRun(
      { ...prepared, posting: { ...prepared.posting, title: 'Jane Doe', text: 'Ask Jane Doe.' } },
      analysis,
    )
    expect(run.posting).toMatchObject({
      title: '[REDACTED]',
      text: 'Ask [REDACTED].',
      truncated: false,
    })
  })

  it('feedback past 20 lines is cut, and lines are trimmed last first to the worker cap', () => {
    const many = Array.from({ length: 25 }, (_, i) => `Line ${i + 1}.`)
    expect(tailorBody(sanitizeRun(prepared, analysis), many).feedback).toEqual(many.slice(0, 20))
    const run = sanitizeRun(
      { ...prepared, posting: { ...prepared.posting, text: 'y'.repeat(12_000) } },
      analysis,
    )
    const big = Array.from({ length: 20 }, () => 'z'.repeat(1000))
    const body = tailorBody({ ...run, payload: padded(run.payload, 30_000) }, big)
    const n = body.feedback.length
    expect(n).toBeLessThan(20)
    expect(n).toBeGreaterThan(1)
    // the longest prefix that fits: one more line would not
    expect(body.feedback).toEqual(big.slice(0, n))
    expect(tailorFits({ ...body, feedback: big.slice(0, n + 1) })).toBe(false)
    expect(tailorBodySchema.safeParse(body).success).toBe(true)
  })

  it('a payload that does not fit even without feedback ends the trim with no feedback', () => {
    const run = sanitizeRun(prepared, analysis)
    const body = tailorBody({ ...run, payload: padded(run.payload, 60_000) }, ['One.', 'Two.'])
    expect(tailorFits(body)).toBe(false)
    expect(body.feedback).toEqual([])
  })

  it('a payload at exactly the worker cap is sent whole; one char more drops the trailing item (CR-M-3)', () => {
    const p = JSON.parse(prepared.payload) as WritingPayload
    const run = (pad: number) =>
      sanitizeRun(
        {
          ...prepared,
          payload: JSON.stringify({
            ...p,
            experience: [item(p), { ...item(p), notes: ['n'.repeat(pad)] }],
          }),
          sentItems: 2,
        },
        analysis,
      )
    const size = (r: PreparedRun) => tailorWorkerInput(tailorBody(r, [])).length
    const pad = 10 + MAX_EXTRACTION_INPUT_CHARS - size(run(10))
    expect(size(run(pad))).toBe(MAX_EXTRACTION_INPUT_CHARS)
    expect(run(pad).sentItems).toBe(2)
    expect(run(pad + 1).sentItems).toBe(1)
  })

  it('a payload the analysis buckets push over the cap is refitted: trailing items go first', () => {
    const p = JSON.parse(prepared.payload) as WritingPayload
    const note = 'n'.repeat(1500)
    const run = sanitizeRun(
      {
        ...prepared,
        payload: JSON.stringify({
          ...p,
          experience: Array.from({ length: 40 }, () => ({ ...item(p), notes: [note] })),
        }),
        sentItems: 40,
      },
      analysis,
    )
    const sent = JSON.parse(run.payload) as WritingPayload
    expect(run.sentItems).toBe(sent.experience.length)
    expect(run.sentItems).toBeLessThan(40)
    expect(tailorBodySchema.safeParse(tailorBody(run, [])).success).toBe(true)
  })
})

/** `payload` with its headline grown so the JSON is about `size` chars. */
function padded(payload: string, size: number): string {
  const p = JSON.parse(payload) as WritingPayload
  return JSON.stringify({ ...p, headline: 'h'.repeat(Math.max(0, size - payload.length)) })
}
