import { MAX_EXTRACTION_INPUT_CHARS } from '@crm/inference'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../database/database.service'
import {
  tailorBodySchema,
  tailorWorkerInput,
  type TailorBody,
} from '../extraction-worker/link-contract'
import { loadOpportunity } from '../job-sourcing/runtime/recompute-inputs'
import type { ContactContext } from '../resumes/verification/contact-scan'
import { loadOwnerContacts } from '../resumes/verification/verification-runner'
import {
  assemblePrepared,
  checkBase,
  bodyPosting,
  fitTailor,
  prepareTailoring,
  tailorFits,
  type PrepareDeps,
} from './tailored-prepare'
import { TailoredRunFailure } from './tailored-run'

vi.mock('../resumes/verification/verification-runner', () => ({ loadOwnerContacts: vi.fn() }))
vi.mock('../job-sourcing/runtime/recompute-inputs', () => ({ loadOpportunity: vi.fn() }))

const contacts: ContactContext[] = [
  { fullName: 'Jane Doe', emails: ['jane@example.com'], telegram: null },
]
const content: ResumeContent = {
  ...EMPTY_RESUME_CONTENT,
  summary: 'Jane Doe builds APIs.',
  skills: ['Postgres', 'TypeScript'],
  experience: [
    { company: 'Acme', role: 'Dev', period: '2020 - 2022', bullets: ['Shipped React dashboards'] },
  ],
}
const base = {
  id: 'r1',
  version: 3,
  content,
  templateName: 'classic' as const,
  layout: DEFAULT_RESUME_LAYOUT,
  pdfPages: 1,
}
const owner = { displayName: 'Jane Doe', email: 'jane@example.com', contacts }
const opportunity = {
  title: 'Senior Engineer',
  employerName: 'Globex',
  descriptionMd: 'We use React and Kubernetes. Mail jobs@globex.io or call +380 67 123 4567.',
  tags: ['Postgres'],
}
const now = new Date('2026-11-22T00:00:00Z')
const assemble = (over: Partial<Parameters<typeof assemblePrepared>[0]> = {}) =>
  assemblePrepared({ base, owner, opportunity, now, ...over })

describe('assemblePrepared', () => {
  it('payload headline is the redacted base summary', () => {
    const p = assemble()
    expect(JSON.parse(p.payload)).toMatchObject({ headline: '[REDACTED] builds APIs.' })
    expect(p.payload).not.toContain('Jane')
  })

  it('prepare strips an email and a phone from the posting, and redacts the senior', () => {
    const p = assemble({
      opportunity: { ...opportunity, descriptionMd: `${opportunity.descriptionMd} Ask Jane Doe.` },
    })
    expect(p.posting.text).toContain('We use React and Kubernetes.')
    expect(p.posting.text).not.toMatch(/jobs@globex\.io|4567|Jane/)
    expect(p.posting).toMatchObject({ partial: false, truncated: false })
  })

  it('prepare marks postingPartial on missing description: text is the title and stack keywords', () => {
    const p = assemble({
      opportunity: { ...opportunity, descriptionMd: ' \n ', tags: ['Go', 'Rust'] },
    })
    expect(p.posting).toEqual({
      title: 'Senior Engineer',
      employerName: 'Globex',
      text: 'Senior Engineer\nGo, Rust',
      partial: true,
      truncated: false,
    })
  })

  it('a stack keyword that is blank after cleaning is dropped', () => {
    const p = assemble({ opportunity: { ...opportunity, descriptionMd: '', tags: [' ', 'Go'] } })
    expect(p.posting.text).toBe('Senior Engineer\nGo')
  })

  it('bodyPosting sends the existing and supported labels, never a gap, in the strict body shape', () => {
    const body = bodyPosting(assemble())
    expect(body).toEqual({
      title: 'Senior Engineer',
      employerName: 'Globex',
      text: assemble().posting.text,
      requirements: { existing: ['PostgreSQL'], supported: ['React'] },
    })
    expect(
      tailorBodySchema.parse({ payload: assemble().payload, posting: body, feedback: [] }),
    ).toBeTruthy()
  })

  it('a partial posting without stack keywords is the title alone', () => {
    const p = assemble({ opportunity: { ...opportunity, descriptionMd: '', tags: [] } })
    expect(p.posting.text).toBe('Senior Engineer')
  })

  it('caps the title at 300 and the employer at 200; a blank title reads "Job opening"', () => {
    const long = assemble({
      opportunity: { ...opportunity, title: 't'.repeat(301), employerName: 'e'.repeat(201) },
    })
    expect(long.posting.title).toBe('t'.repeat(300))
    expect(long.posting.employerName).toBe('e'.repeat(200))
    expect(assemble({ opportunity: { ...opportunity, title: '  ' } }).posting.title).toBe(
      'Job opening',
    )
  })

  it('a description over the cap is truncated at a sentence end', () => {
    const p = assemble({
      opportunity: { ...opportunity, descriptionMd: 'We build. '.repeat(1300) },
    })
    expect(p.posting.truncated).toBe(true)
    expect(p.posting.text.endsWith('We build.')).toBe(true)
  })

  it('requirements come from the title, description and tags, each with its bucket', () => {
    expect(assemble().requirements).toEqual([
      { name: 'Kubernetes', bucket: 'gap' },
      { name: 'React', bucket: 'supported' },
      { name: 'PostgreSQL', bucket: 'existing' },
    ])
  })

  it('carries the base, the owner and every sent item', () => {
    const p = assemble()
    expect(p).toMatchObject({ base, contacts, email: 'jane@example.com', displayName: 'Jane Doe' })
    expect(p.sentItems).toBe(1)
  })

  it('fitTailor on a resume over the worker budget trims the oldest items, sentItems < item count, and the trimmed items keep their base bullets', () => {
    const bullets = Array.from({ length: 20 }, (_, i) => `${i} ${'x'.repeat(900)}`)
    const items = Array.from({ length: 5 }, (_, i) => ({
      company: `Co${i}`,
      role: 'Dev',
      period: '2020 - 2022',
      bullets,
    }))
    const big = { ...content, experience: items }
    const p = assemble({ base: { ...base, content: big } })
    expect(p.sentItems).toBeGreaterThan(0)
    expect(p.sentItems).toBeLessThan(5)
    expect(JSON.parse(p.payload).experience).toHaveLength(p.sentItems)
    expect(JSON.parse(p.payload).experience[0].company).toBe('Co0')
    expect(p.base.content.experience).toEqual(items)
  })
})

const posting: TailorBody['posting'] = {
  title: 'T',
  employerName: 'E',
  text: '',
  requirements: { existing: [], supported: [] },
}
const payloadOf = (notes: string[][]) => ({
  headline: 'h',
  skills: [],
  yearsOfExperience: 1,
  experience: notes.map((n, i) => ({
    company: `C${i}`,
    role: 'R',
    start: null,
    end: null,
    current: false,
    technologies: [],
    notes: n,
  })),
})

describe('fitTailor / tailorFits', () => {
  it('a body that fits is returned unchanged', () => {
    const payload = payloadOf([['a'], ['b']])
    expect(fitTailor(payload, posting, ['f'])).toEqual({ payload, feedback: ['f'], sentItems: 2 })
  })

  it('never drops the first item; then drops feedback, last first', () => {
    const payload = payloadOf([['y'.repeat(45_000)], ['z']])
    const feedback = Array.from({ length: 20 }, (_, i) => `${i} ${'f'.repeat(900)}`)
    const out = fitTailor(payload, posting, feedback)
    expect(out.sentItems).toBe(1)
    expect(out.feedback.length).toBeGreaterThan(0)
    expect(out.feedback.length).toBeLessThan(20)
    expect(out.feedback).toEqual(feedback.slice(0, out.feedback.length))
    const body = { payload: JSON.stringify(out.payload), posting, feedback: out.feedback }
    expect(tailorFits(body)).toBe(true)
    // the most lines that fit: one more would not
    const more = feedback.slice(0, out.feedback.length + 1)
    expect(tailorFits({ ...body, feedback: more })).toBe(false)
  })

  it('drops only as many trailing items as it must', () => {
    const payload = payloadOf([['a'], ['b'], ['y'.repeat(50_000)]])
    expect(fitTailor(payload, posting, []).sentItems).toBe(2)
  })

  it('a first item over the cap on its own is returned as it is, with no feedback', () => {
    const payload = payloadOf([['y'.repeat(60_000)]])
    expect(fitTailor(payload, posting, ['f'])).toEqual({ payload, feedback: [], sentItems: 1 })
  })

  it('budgets the posting too: the same payload fits with a short posting, not a long one', () => {
    const payload = payloadOf([['a'], ['y'.repeat(45_000)]])
    expect(fitTailor(payload, posting, []).sentItems).toBe(2)
    expect(fitTailor(payload, { ...posting, text: 'p'.repeat(12_000) }, []).sentItems).toBe(1)
  })

  it('tailorFits is true at exactly the worker cap and false one char past it', () => {
    const empty = { payload: JSON.stringify(payloadOf([])), posting, feedback: [] }
    const room = MAX_EXTRACTION_INPUT_CHARS - tailorWorkerInput(empty).length
    const at = { ...empty, posting: { ...posting, text: 'a'.repeat(room) } }
    expect(tailorWorkerInput(at)).toHaveLength(MAX_EXTRACTION_INPUT_CHARS)
    expect(tailorFits(at)).toBe(true)
    expect(tailorFits({ ...at, posting: { ...posting, text: 'a'.repeat(room + 1) } })).toBe(false)
  })
})

const row = { verificationStatus: 'VERIFIED', version: 3, pdfS3Key: 'k', content }

describe('checkBase', () => {
  it('a VERIFIED base at the run version with a Latin owner → the row', () => {
    expect(checkBase(row, 'Jane Doe', 3)).toEqual({ row })
  })

  it.each([
    ['no base', undefined],
    ['a base not VERIFIED', { ...row, verificationStatus: 'CHECKING' }],
    ['a base without its PDF', { ...row, pdfS3Key: null }],
  ])('%s → BASE_NOT_VERIFIED', (_, r) => {
    expect(checkBase(r, 'Jane Doe', 3)).toEqual({ code: 'BASE_NOT_VERIFIED' })
  })

  it('prepare fails BASE_CHANGED when the base version moved after start', () => {
    expect(checkBase({ ...row, version: 4 }, 'Jane Doe', 3)).toEqual({ code: 'BASE_CHANGED' })
  })

  it('a non-Latin display name → NON_LATIN_NAME; a non-Latin field → NON_ENGLISH', () => {
    expect(checkBase(row, 'Іван', 3)).toEqual({ code: 'NON_LATIN_NAME' })
    expect(
      checkBase({ ...row, content: { ...content, summary: 'Інженер' } }, 'Jane Doe', 3),
    ).toEqual({ code: 'NON_ENGLISH' })
  })
})

describe('prepareTailoring (unit double: the DB reads mocked)', () => {
  const pdf = Buffer.from('%PDF')
  const baseRow = {
    id: 'r1',
    version: 3,
    content,
    templateName: 'modern',
    layout: DEFAULT_RESUME_LAYOUT,
    pdfS3Key: 'resumes/r1.pdf',
    verificationStatus: 'VERIFIED',
  }
  let rows: unknown[]
  const limit = vi.fn(async () => rows)
  const db = {
    db: { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) },
  } as unknown as DatabaseService
  const getObject = vi.fn(async () => pdf)
  const countRenderedPages = vi.fn(async () => 2)
  const deps: PrepareDeps = {
    db,
    s3: { getObject },
    extraction: { countRenderedPages },
    onDemandTypes: ['REMOTEOK_API'],
  }
  const p = { rowId: 't1', runId: 'u1', opportunityId: 'o1', seniorId: 's1', runBaseVersion: 3 }
  const failure = (e: unknown) => (e instanceof TailoredRunFailure ? e.code : e)

  beforeEach(() => {
    rows = [baseRow]
    vi.mocked(loadOwnerContacts).mockResolvedValue({
      ...owner,
      legalFullName: null,
      telegram: null,
    })
    vi.mocked(loadOpportunity).mockResolvedValue({
      canonical: { companyName: 'Globex', fields: { ...opportunity, descriptionMd: 'Use React.' } },
    } as unknown as Awaited<ReturnType<typeof loadOpportunity>>)
    getObject.mockClear()
    countRenderedPages.mockClear()
  })

  it('prepare reads pdfPages from the base PDF, never renders', async () => {
    const r = await prepareTailoring(deps, p)
    expect(getObject).toHaveBeenCalledWith('resumes/r1.pdf')
    expect(countRenderedPages).toHaveBeenCalledWith(pdf)
    expect(r.base).toEqual({
      id: 'r1',
      version: 3,
      content,
      templateName: 'modern',
      layout: DEFAULT_RESUME_LAYOUT,
      pdfPages: 2,
    })
    expect(r.posting).toMatchObject({
      title: 'Senior Engineer',
      employerName: 'Globex',
      text: 'Use React.',
    })
    expect(loadOwnerContacts).toHaveBeenCalledWith(db, 's1')
    expect(loadOpportunity).toHaveBeenCalledWith(db.db, 'o1', ['REMOTEOK_API'])
  })

  it('an opportunity without tags or a description is a partial posting of the title alone', async () => {
    vi.mocked(loadOpportunity).mockResolvedValueOnce({
      canonical: { companyName: '', fields: { title: 'Dev', descriptionMd: '' } },
    } as unknown as Awaited<ReturnType<typeof loadOpportunity>>)
    expect((await prepareTailoring(deps, p)).posting).toMatchObject({ text: 'Dev', partial: true })
  })

  it('an unknown stored template reads as the default one', async () => {
    rows = [{ ...baseRow, templateName: null }]
    expect((await prepareTailoring(deps, p)).base.templateName).toBe('classic')
  })

  it('prepare fails BASE_CHANGED when the base version moved after start, before any PDF read', async () => {
    rows = [{ ...baseRow, version: 4 }]
    expect(failure(await prepareTailoring(deps, p).catch((e: unknown) => e))).toBe('BASE_CHANGED')
    expect(getObject).not.toHaveBeenCalled()
  })

  it('no base row → BASE_NOT_VERIFIED', async () => {
    rows = []
    expect(failure(await prepareTailoring(deps, p).catch((e: unknown) => e))).toBe(
      'BASE_NOT_VERIFIED',
    )
  })

  it('a missing owner or opportunity → INTERNAL_ERROR', async () => {
    vi.mocked(loadOwnerContacts).mockResolvedValueOnce(null)
    expect(failure(await prepareTailoring(deps, p).catch((e: unknown) => e))).toBe('INTERNAL_ERROR')
    vi.mocked(loadOpportunity).mockResolvedValueOnce(null)
    expect(failure(await prepareTailoring(deps, p).catch((e: unknown) => e))).toBe('INTERNAL_ERROR')
    expect(getObject).not.toHaveBeenCalled()
  })
})
