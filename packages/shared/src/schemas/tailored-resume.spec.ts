import { describe, expect, it } from 'vitest'
import { RESUME_LIMITS } from './resume'
import {
  TAILORED_LIST_MAX_SENIORS,
  tailoredEditRequestSchema,
  tailoredEligibilitySchema,
  tailoredGenerateRequestSchema,
  tailoredListQuerySchema,
  tailoredResumeDetailSchema,
  tailoredResumeErrorCodeSchema,
  tailoredResumeRowSchema,
  tailoredRunStageSchema,
  tailoredRunStatusSchema,
  tailoredVerificationSchema,
} from './tailored-resume'

const A = '0b6c1a1e-0000-4000-8000-000000000001'
const B = '0b6c1a1e-0000-4000-8000-000000000002'
const TEAM = '0b6c1a1e-0000-4000-8000-0000000000aa'
/** `n` distinct canonical uuids. */
const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `0b6c1a1e-0000-4000-8000-${String(i).padStart(12, '0')}`)

const EDIT = {
  summary: 'Backend engineer.',
  skills: ['TypeScript', 'PostgreSQL'],
  bullets: [['Built the billing API.'], ['Led the migration.', 'Cut p95 by 40%.']],
  coverLetter: 'I would like to apply.',
}

describe('tailored run enums (spec §4, §8)', () => {
  it('run status is exactly the four lifecycle values', () => {
    expect(tailoredRunStatusSchema.options).toEqual(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'])
  })

  it('run stages follow the spec §4 step 3 order', () => {
    expect(tailoredRunStageSchema.options).toEqual([
      'FETCHING_POSTING',
      'ANALYSING',
      'TAILORING',
      'CHECKING',
      'RENDERING',
      'VISUAL_CHECK',
    ])
  })

  it('eligibility values', () => {
    expect(tailoredEligibilitySchema.options).toEqual([
      'READY',
      'NO_VERIFIED_RESUME',
      'NON_ENGLISH',
      'NON_LATIN_NAME',
      'POSTING_PENDING',
    ])
  })

  it('error codes are the seventeen the plan names, in order', () => {
    expect(tailoredResumeErrorCodeSchema.options).toEqual([
      'BASE_NOT_VERIFIED',
      'BASE_CHANGED',
      'NON_ENGLISH',
      'NON_LATIN_NAME',
      'WRITER_UNAVAILABLE',
      'DECISION_UNAVAILABLE',
      'ENTAILMENT_UNAVAILABLE',
      'LIMITS_EXHAUSTED',
      'COVER_LETTER_UNGROUNDED',
      'RENDER_FAILED',
      'ATS_CHECK_FAILED',
      'GLYPH_CHECK_FAILED',
      'LAYOUT_UNFIXABLE',
      'VISUAL_CHECK_FAILED',
      'VISUAL_CHECK_UNAVAILABLE',
      'STALLED',
      'INTERNAL_ERROR',
    ])
  })

  it.each([
    'WRITER_UNAVAILABLE',
    'ENTAILMENT_UNAVAILABLE',
    'RENDER_FAILED',
    'ATS_CHECK_FAILED',
    'GLYPH_CHECK_FAILED',
    'LAYOUT_UNFIXABLE',
    'VISUAL_CHECK_FAILED',
    'VISUAL_CHECK_UNAVAILABLE',
  ])('error codes include every reused gate code: %s', (code) => {
    expect(tailoredResumeErrorCodeSchema.safeParse(code).success).toBe(true)
  })

  it('a VBR-only code is not a tailored code', () => {
    expect(tailoredResumeErrorCodeSchema.safeParse('INCOMPLETE').success).toBe(false)
  })
})

describe('tailoredGenerateRequestSchema', () => {
  it('accepts overwrite with and without a team', () => {
    expect(tailoredGenerateRequestSchema.parse({ overwrite: false })).toEqual({ overwrite: false })
    expect(tailoredGenerateRequestSchema.parse({ teamId: TEAM, overwrite: true })).toEqual({
      teamId: TEAM,
      overwrite: true,
    })
  })

  it('refuses a missing overwrite, a non-uuid team and an unknown key', () => {
    expect(tailoredGenerateRequestSchema.safeParse({}).success).toBe(false)
    expect(tailoredGenerateRequestSchema.safeParse({ teamId: 'x', overwrite: true }).success).toBe(
      false,
    )
    expect(tailoredGenerateRequestSchema.safeParse({ overwrite: true, force: 1 }).success).toBe(
      false,
    )
  })
})

describe('tailoredEditRequestSchema (spec §9: the base limits)', () => {
  it('accepts a valid edit with and without a team', () => {
    expect(tailoredEditRequestSchema.parse(EDIT)).toEqual(EDIT)
    expect(tailoredEditRequestSchema.parse({ ...EDIT, teamId: TEAM }).teamId).toBe(TEAM)
  })

  it('accepts a summary at RESUME_LIMITS.summary and refuses one char over', () => {
    const at = 'a'.repeat(RESUME_LIMITS.summary)
    expect(tailoredEditRequestSchema.safeParse({ ...EDIT, summary: at }).success).toBe(true)
    expect(tailoredEditRequestSchema.safeParse({ ...EDIT, summary: `${at}a` }).success).toBe(false)
  })

  it('refuses an item with 0 bullets', () => {
    expect(tailoredEditRequestSchema.safeParse({ ...EDIT, bullets: [[]] }).success).toBe(false)
  })

  it('refuses an unknown key', () => {
    expect(tailoredEditRequestSchema.safeParse({ ...EDIT, displayName: 'x' }).success).toBe(false)
  })

  it('caps skills, skill length, bullets per item, bullet length and items', () => {
    const parse = (patch: object) => tailoredEditRequestSchema.safeParse({ ...EDIT, ...patch })
    const skill = 'a'.repeat(RESUME_LIMITS.shortText)
    const bullet = 'b'.repeat(RESUME_LIMITS.bullet)
    expect(parse({ skills: Array(RESUME_LIMITS.skills).fill('x') }).success).toBe(true)
    expect(parse({ skills: Array(RESUME_LIMITS.skills + 1).fill('x') }).success).toBe(false)
    expect(parse({ skills: [skill] }).success).toBe(true)
    expect(parse({ skills: [`${skill}a`] }).success).toBe(false)
    expect(parse({ bullets: [[bullet]] }).success).toBe(true)
    expect(parse({ bullets: [[`${bullet}b`]] }).success).toBe(false)
    const full = Array(RESUME_LIMITS.bulletsPerExperience).fill('x')
    expect(parse({ bullets: [full] }).success).toBe(true)
    expect(parse({ bullets: [[...full, 'x']] }).success).toBe(false)
    expect(parse({ bullets: Array(RESUME_LIMITS.experience).fill(['x']) }).success).toBe(true)
    expect(parse({ bullets: Array(RESUME_LIMITS.experience + 1).fill(['x']) }).success).toBe(false)
  })

  it('cover letter is 1..4000 chars', () => {
    const parse = (coverLetter: string) =>
      tailoredEditRequestSchema.safeParse({ ...EDIT, coverLetter }).success
    expect(parse('')).toBe(false)
    expect(parse('a')).toBe(true)
    expect(parse('a'.repeat(4000))).toBe(true)
    expect(parse('a'.repeat(4001))).toBe(false)
  })
})

describe('tailoredListQuerySchema (D10)', () => {
  const parse = (seniorIds: string, teamId?: string) =>
    tailoredListQuerySchema.safeParse(teamId === undefined ? { seniorIds } : { seniorIds, teamId })

  it('parses "a,b" into two uuids, trimmed', () => {
    expect(parse(`${A}, ${B}`).data).toEqual({ seniorIds: [A, B] })
  })

  it('"a,a,b" is two: deduplicated before the count', () => {
    expect(parse(`${A},${A},${B}`).data?.seniorIds).toEqual([A, B])
  })

  it('lower-cases so one id has one spelling', () => {
    expect(parse(A.toUpperCase()).data?.seniorIds).toEqual([A])
  })

  it('accepts 100 ids and refuses 101 distinct ids', () => {
    expect(TAILORED_LIST_MAX_SENIORS).toBe(100)
    expect(parse(ids(100).join(',')).data?.seniorIds).toHaveLength(100)
    expect(parse(ids(101).join(',')).success).toBe(false)
  })

  it('100 distinct ids plus duplicates still pass (dedup before the count)', () => {
    expect(parse([...ids(100), ...ids(100)].join(',')).data?.seniorIds).toHaveLength(100)
    expect(parse([...ids(100), TEAM].join(',')).success).toBe(false)
  })

  it('refuses "not-a-uuid", an empty segment and an empty list', () => {
    expect(parse('not-a-uuid').success).toBe(false)
    expect(parse(`${A},,${B}`).success).toBe(false)
    expect(parse('').success).toBe(false)
  })

  it('takes an optional team uuid; refuses a bad one', () => {
    expect(parse(A, TEAM).data).toEqual({ seniorIds: [A], teamId: TEAM })
    expect(parse(A, 'team-1').success).toBe(false)
  })
})

const VERIFICATION = {
  gates: [{ gate: 'fact', ok: false, items: [{ path: 'summary', reason: 'UNGROUNDED' }] }],
  revertedPaths: ['summary'],
  keptFromBase: 1,
  coverage: { matched: ['typescript'], total: 3 },
  gaps: ['kubernetes'],
  injectionSuspected: false,
  postingPartial: true,
  postingTruncated: false,
  routes: ['groq/llama'],
}

const ROW = {
  seniorId: A,
  eligibility: 'READY',
  runStatus: 'RUNNING',
  runStage: 'TAILORING',
  runErrorCode: null,
  published: false,
  pdfStatus: 'IDLE',
  pdfRenderId: null,
  baseChanged: false,
}

describe('tailoredVerificationSchema', () => {
  it('parses the stored shape', () => {
    expect(tailoredVerificationSchema.parse(VERIFICATION)).toEqual(VERIFICATION)
  })

  it('refuses a missing flag and a negative total', () => {
    const { postingPartial: _omit, ...missing } = VERIFICATION
    expect(tailoredVerificationSchema.safeParse(missing).success).toBe(false)
    expect(
      tailoredVerificationSchema.safeParse({
        ...VERIFICATION,
        coverage: { matched: [], total: -1 },
      }).success,
    ).toBe(false)
  })
})

describe('tailored row and detail DTOs', () => {
  it('a row parses; an unknown pdf status is refused', () => {
    expect(tailoredResumeRowSchema.parse(ROW)).toEqual(ROW)
    expect(tailoredResumeRowSchema.safeParse({ ...ROW, pdfStatus: 'DONE' }).success).toBe(false)
    expect(tailoredResumeRowSchema.safeParse({ ...ROW, runErrorCode: 'INCOMPLETE' }).success).toBe(
      false,
    )
  })

  it('a detail with nothing published yet has nulls', () => {
    const detail = {
      ...ROW,
      coverLetter: null,
      editable: null,
      summary: null,
      generatedAt: null,
      editedAt: null,
    }
    expect(tailoredResumeDetailSchema.parse(detail)).toEqual(detail)
  })

  it('a published detail carries the editable fields and the short summary', () => {
    const detail = {
      ...ROW,
      runStatus: 'SUCCEEDED',
      runStage: null,
      published: true,
      pdfStatus: 'READY',
      coverLetter: 'Dear Hiring Team,',
      editable: {
        summary: 'S',
        skills: ['Go'],
        experience: [{ company: 'Acme', role: 'Dev', period: '2020 - 2024', bullets: ['B'] }],
      },
      summary: {
        keptFromBase: 2,
        gaps: ['rust'],
        coverage: { matched: ['go'], total: 2 },
        postingPartial: false,
      },
      generatedAt: '2026-11-21T10:00:00.000Z',
      editedAt: null,
    }
    expect(tailoredResumeDetailSchema.parse(detail)).toEqual(detail)
  })
})
