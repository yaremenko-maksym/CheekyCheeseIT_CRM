import { describe, expect, it } from 'vitest'
import {
  EMPTY_RESUME_FACTS,
  RESUME_TEMPLATE_NAMES,
  confirmResumeSchema,
  editStagedFieldSchema,
  regenerateStagedFieldSchema,
  resumeFactsSchema,
  resumeMonthSchema,
  resumeTemplateNameSchema,
  resumeVerificationErrorCodeSchema,
  resumeVerificationReportSchema,
  resumeVerificationStatusSchema,
  updateResumeFactsSchema,
  updateResumeTemplateSchema,
  type ResumeFacts,
} from './resume-facts'

const RUN_ID = '3f2b8c1e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'

function factsWith(overrides: Partial<ResumeFacts>): ResumeFacts {
  return { ...EMPTY_RESUME_FACTS, ...overrides }
}

const experience = {
  company: 'Acme',
  role: 'Backend engineer',
  location: null,
  start: null,
  end: null,
  current: false,
  technologies: ['Go'],
  notes: ['Built the billing service'],
}

describe('resumeMonthSchema', () => {
  it('rejects month "2021-13"', () => {
    expect(resumeMonthSchema.safeParse('2021-13').success).toBe(false)
  })

  it('accepts "2021-03"', () => {
    expect(resumeMonthSchema.parse('2021-03')).toBe('2021-03')
  })

  it('rejects month "2021-00" and a full date', () => {
    expect(resumeMonthSchema.safeParse('2021-00').success).toBe(false)
    expect(resumeMonthSchema.safeParse('2021-03-01').success).toBe(false)
  })
})

describe('resumeFactsSchema', () => {
  it('facts with start null parse (draft allowed)', () => {
    const parsed = resumeFactsSchema.parse(factsWith({ experience: [experience] }))
    expect(parsed.experience[0]?.start).toBeNull()
  })

  it('an experience month out of range is rejected', () => {
    const result = resumeFactsSchema.safeParse(
      factsWith({ experience: [{ ...experience, start: '2021-13' }] }),
    )
    expect(result.success).toBe(false)
  })

  it('link "javascript:alert(1)" is rejected', () => {
    const result = resumeFactsSchema.safeParse(
      factsWith({ links: [{ label: 'x', url: 'javascript:alert(1)' }] }),
    )
    expect(result.success).toBe(false)
  })

  it('an https link is accepted', () => {
    const result = resumeFactsSchema.safeParse(
      factsWith({ links: [{ label: 'GitHub', url: 'https://github.com/x' }] }),
    )
    expect(result.success).toBe(true)
  })

  it('a language level outside the CEFR set is rejected', () => {
    const result = resumeFactsSchema.safeParse(
      factsWith({ languages: [{ name: 'English', level: 'fluent' as 'C1' }] }),
    )
    expect(result.success).toBe(false)
  })

  it('workFormat outside the set is rejected', () => {
    const result = resumeFactsSchema.safeParse(factsWith({ workFormat: 'office' as 'onsite' }))
    expect(result.success).toBe(false)
  })

  it('more skills than RESUME_LIMITS.skills (60) is rejected', () => {
    const skills = Array.from({ length: 61 }, (_, i) => `skill-${i}`)
    expect(resumeFactsSchema.safeParse(factsWith({ skills })).success).toBe(false)
  })

  it('EMPTY_RESUME_FACTS parses', () => {
    expect(resumeFactsSchema.parse(EMPTY_RESUME_FACTS)).toEqual({
      headline: '',
      location: { city: '', country: '' },
      workFormat: null,
      skills: [],
      experience: [],
      education: [],
      languages: [],
      links: [],
    })
  })
})

describe('resumeTemplateNameSchema', () => {
  it('templateName "fancy" is rejected', () => {
    expect(resumeTemplateNameSchema.safeParse('fancy').success).toBe(false)
  })

  it('the catalog is exactly the four names', () => {
    expect(RESUME_TEMPLATE_NAMES).toEqual(['classic', 'modern', 'compact', 'technical'])
    expect(resumeTemplateNameSchema.parse('technical')).toBe('technical')
  })
})

describe('verification schemas', () => {
  it('status and error code reject values outside their sets', () => {
    expect(resumeVerificationStatusSchema.parse('AWAITING_CONFIRM')).toBe('AWAITING_CONFIRM')
    expect(resumeVerificationStatusSchema.safeParse('READY').success).toBe(false)
    expect(resumeVerificationErrorCodeSchema.parse('STALLED')).toBe('STALLED')
    expect(resumeVerificationErrorCodeSchema.safeParse('UNKNOWN').success).toBe(false)
  })

  it('a report with gates and fallbacks parses', () => {
    const report = {
      gates: [
        { gate: 'ats', ok: false, items: [{ path: 'experience.0.bullets.1', reason: 'missing' }] },
      ],
      fallbacks: ['summary'],
    }
    expect(resumeVerificationReportSchema.parse(report)).toEqual(report)
  })
})

describe('request bodies', () => {
  it('updateResumeFactsSchema validates the nested facts', () => {
    expect(updateResumeFactsSchema.safeParse({ facts: EMPTY_RESUME_FACTS }).success).toBe(true)
    expect(updateResumeFactsSchema.safeParse({ facts: { headline: '' } }).success).toBe(false)
  })

  it('updateResumeTemplateSchema accepts only catalog names', () => {
    expect(updateResumeTemplateSchema.safeParse({ templateName: 'modern' }).success).toBe(true)
    expect(updateResumeTemplateSchema.safeParse({ templateName: 'fancy' }).success).toBe(false)
  })

  it('confirmResumeSchema needs a uuid runId and an integer version', () => {
    expect(confirmResumeSchema.safeParse({ runId: RUN_ID, version: 3 }).success).toBe(true)
    expect(confirmResumeSchema.safeParse({ runId: 'run-1', version: 3 }).success).toBe(false)
    expect(confirmResumeSchema.safeParse({ runId: RUN_ID, version: 1.5 }).success).toBe(false)
  })

  it('staged-field bodies need a uuid runId', () => {
    expect(
      editStagedFieldSchema.safeParse({ runId: RUN_ID, path: 'summary', text: 'x' }).success,
    ).toBe(true)
    expect(editStagedFieldSchema.safeParse({ runId: RUN_ID, path: 'summary' }).success).toBe(false)
    expect(regenerateStagedFieldSchema.safeParse({ runId: RUN_ID, path: 'summary' }).success).toBe(
      true,
    )
    expect(regenerateStagedFieldSchema.safeParse({ runId: 'x', path: 'summary' }).success).toBe(
      false,
    )
  })
})
